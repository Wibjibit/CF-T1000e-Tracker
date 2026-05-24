// Find Hub poller — a Durable Object that, on each alarm tick, opens an
// EPHEMERAL FCM/MCS push socket, nudges Google, and writes the pushed reports.
//
// This is the thin glue layer: all the logic worth testing lives in the pure,
// vitest-covered modules (`lib/fmdn/*`, `lib/google/*`); this file wires them
// over the `cloudflare:sockets` connection whose connect→login→locate→collect
// path was proven on the real edge by the Phase 3.0 spike
// (`spike/findhub-mcs/`). Reports are NOT fetchable synchronously — the
// encrypted DeviceUpdate arrives only as an MCS DataMessageStanza push — so a
// Workers cron can't do this; a DO alarm holding the socket for ~12 s can
// (socket I/O isn't CPU time, so the collect window is free of the 30 s cap).
//
// Per master-plan Phase 3.2. Live end-to-end verification waits on the Phase
// 3.3 bootstrap importer creating the `accounts` + `device_sources(findhub)`
// rows; until then this is exercised through its pure helpers' tests.

import { connect } from 'cloudflare:sockets';
// `Socket` is a global runtime type (cloudflare:sockets only exports `connect`).
import { decrypt as decryptBlob } from '../lib/crypto/blob';
import { mintAdmToken } from '../lib/google/auth';
import { novaPost, buildDevicesListRequest, buildLocateTrackerRequest } from '../lib/google/nova';
import { parseDevices } from '../lib/fmdn/report';
import {
  buildLoginFrame,
  buildHeartbeatAckFrame,
  FrameReader,
  TAG,
  loginError,
  decodeMessage,
} from '../lib/fmdn/mcs';
import { getVarint } from '../lib/fmdn/protobuf';
import {
  parseGoogleCreds,
  buildEikCache,
  processPush,
  findhubSourceMetadata,
  findhubReportInsert,
  mergePersistentIds,
  nextAlarmDelay,
  type GoogleAccountCreds,
} from '../lib/fmdn/findhub';

export interface PollerEnv {
  DB: D1Database;
  BLOB_ENC_KEY: string;
}

const MTALK_HOST = 'mtalk.google.com';
const MTALK_PORT = 5228;
const COLLECT_MS = 12_000; // push latency is ~4 s (spike); 12 s leaves margin
const LOCATE_GAP_MS = 800; // small gap between sequential LocateTracker fires
const ALARM_INTERVAL_MS = 10 * 60_000; // nominal cadence
const ALARM_FLOOR_MS = 5 * 60_000; // never hammer faster than this
const PERSISTENT_ID_CAP = 64; // bound the acked-id list we replay on login

/** One enabled findhub source joined to its account credentials. */
interface SourceRow {
  source_id: number;
  device_id: string;
  source_ref: string; // FMDN canonic_id
  account_id: number;
  credentials_nonce: ArrayBuffer;
  credentials_ciphertext: ArrayBuffer;
}

interface TickResult {
  accounts: number;
  sources: number;
  reportsInserted: number;
  errors: string[];
}

export class FindHubPoller {
  constructor(
    private state: DurableObjectState,
    private env: PollerEnv,
  ) {}

  /** Manual kick (`/kick`) + an idempotent "ensure an alarm is scheduled". */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/kick')) {
      return Response.json(await this.runTick());
    }
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + 1_000);
    }
    return Response.json({ ok: true });
  }

  /** Self-scheduling: run a tick, then always re-arm the next alarm. */
  async alarm(): Promise<void> {
    try {
      await this.runTick();
    } catch (e) {
      console.error('findhub-poller: tick threw', e);
    } finally {
      await this.state.storage.setAlarm(Date.now() + nextAlarmDelay(ALARM_INTERVAL_MS, ALARM_FLOOR_MS));
    }
  }

  private async runTick(): Promise<TickResult> {
    const result: TickResult = { accounts: 0, sources: 0, reportsInserted: 0, errors: [] };

    const rows = await this.env.DB.prepare(
      `SELECT s.source_id, s.device_id, s.source_ref, s.account_id,
              a.credentials_nonce, a.credentials_ciphertext
         FROM device_sources s
         JOIN accounts a ON a.account_id = s.account_id
        WHERE s.source_type = 'findhub' AND s.enabled = 1`,
    ).all<SourceRow>();

    const sources = rows.results ?? [];
    result.sources = sources.length;
    if (sources.length === 0) return result;

    // One MCS socket per Google account → group sources by account_id.
    const byAccount = new Map<number, SourceRow[]>();
    for (const r of sources) {
      const list = byAccount.get(r.account_id);
      if (list) list.push(r);
      else byAccount.set(r.account_id, [r]);
    }
    result.accounts = byAccount.size;

    for (const [accountId, accountSources] of byAccount) {
      try {
        result.reportsInserted += await this.pollAccount(accountId, accountSources);
      } catch (e) {
        const msg = String(e);
        result.errors.push(`account ${accountId}: ${msg}`);
        // Persist the failure so it surfaces in the settings auth-health badge
        // (Phase 3.3 exit criterion; Phase 4 alerting reads the same columns).
        // A successful pollAccount clears last_error, so this only sticks while
        // the account is genuinely broken (e.g. a revoked Master Token).
        try {
          await this.env.DB.prepare(
            `UPDATE accounts SET last_error = ?, last_attempt_at = ? WHERE account_id = ?`,
          )
            .bind(msg.slice(0, 500), Date.now(), accountId)
            .run();
        } catch (dbErr) {
          console.error('findhub-poller: could not record account error', dbErr);
        }
      }
    }
    return result;
  }

  /** Poll one Google account: ListDevices → EIK cache → socket → collect → write. */
  private async pollAccount(accountId: number, sources: SourceRow[]): Promise<number> {
    const creds = parseGoogleCreds(
      await decryptBlob(
        { credentials_nonce: sources[0].credentials_nonce, credentials_ciphertext: sources[0].credentials_ciphertext },
        this.env,
      ),
    );

    // ADM token (gpsoauth second leg) — also the auth-health signal.
    const adm = await mintAdmToken(creds.username, creds.masterToken, creds.gcmAndroidId);
    if (!adm.ok || !adm.token) {
      throw new Error(`ADM token mint failed (status ${adm.status}) — re-auth needed`);
    }

    // ListDevices → registration → EIK cache.
    const listResp = await novaPost(adm.token, 'nbe_list_devices', buildDevicesListRequest());
    const devices = parseDevices(listResp);
    const { cache: eikCache } = buildEikCache(
      devices.map((d) => ({ canonicId: d.canonicId, registration: d.registration })),
      creds.ownerKey,
    );

    // canonic_id → the source row that wants it.
    const sourceByCanonic = new Map(sources.map((s) => [s.source_ref, s]));

    const storageKey = `pids:${accountId}`;
    const storedPids = (await this.state.storage.get<string[]>(storageKey)) ?? [];

    const conn = await this.connectAndLogin(creds, storedPids);
    const newPids: string[] = [];
    const inserts: D1PreparedStatement[] = [];
    const touchedSources = new Set<number>();
    let now = Date.now();

    try {
      // Fire LocateTracker for each requested device (fire-and-forget).
      for (const s of sources) {
        try {
          await novaPost(adm.token, 'nbe_execute_action', buildLocateTrackerRequest(s.source_ref, creds.fcmToken));
        } catch (e) {
          console.warn(`findhub-poller: locate ${s.source_ref} failed`, e);
        }
        await sleep(LOCATE_GAP_MS);
      }

      // Collect pushes until the window closes.
      const deadline = Date.now() + COLLECT_MS;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let frame: { tag: number; payload: Uint8Array };
        try {
          frame = await withTimeout(conn.fr.readFrame(), remaining, 'read frame');
        } catch {
          break; // window closed / stream idle
        }

        if (frame.tag === TAG.HeartbeatPing) {
          const lastStream = getVarint(decodeMessage(frame.payload), 2) ?? 0;
          try {
            await conn.writer.write(buildHeartbeatAckFrame(lastStream));
          } catch {
            /* ignore */
          }
          continue;
        }
        if (frame.tag !== TAG.DataMessageStanza) continue;

        const processed = processPush(frame.payload, creds.eceKeys, eikCache);
        if (!processed) continue;
        if (processed.persistentId) newPids.push(processed.persistentId);
        for (const e of processed.errors) console.warn('findhub-poller: report skipped:', e);

        const src = sourceByCanonic.get(processed.canonicId);
        if (!src) continue; // a device we didn't ask about (shared account)

        now = Date.now();
        for (const r of processed.reports) {
          inserts.push(
            findhubReportInsert(this.env.DB, {
              deviceId: src.device_id,
              sourceId: src.source_id,
              receivedAt: r.receivedAtUnixS * 1000,
              latitude: r.latitude,
              longitude: r.longitude,
              altitudeM: r.altitudeM,
              accuracyM: r.accuracyM,
              metadata: findhubSourceMetadata(r, processed.ownerKeyVersion),
              rawPayload: JSON.stringify({ canonicId: processed.canonicId, ...r }),
            }),
          );
          touchedSources.add(src.source_id);
        }
      }
    } finally {
      try {
        conn.fr.releaseLock();
        conn.writer.releaseLock();
        await conn.socket.close();
      } catch {
        /* ignore */
      }
    }

    // Persist: reports (INSERT OR IGNORE dedup), bookkeeping, acked persistentIds.
    const writes: D1PreparedStatement[] = [...inserts];
    for (const sid of touchedSources) {
      writes.push(
        this.env.DB.prepare(`UPDATE device_sources SET last_report_at = ? WHERE source_id = ?`).bind(now, sid),
      );
    }
    writes.push(
      this.env.DB.prepare(
        `UPDATE accounts SET last_refreshed_at = ?, last_attempt_at = ?, last_error = NULL WHERE account_id = ?`,
      ).bind(now, now, accountId),
    );
    if (writes.length) await this.env.DB.batch(writes);

    await this.state.storage.put(storageKey, mergePersistentIds(storedPids, newPids, PERSISTENT_ID_CAP));
    return inserts.length;
  }

  /** Open the TLS socket, send LoginRequest, read until LoginResponse. */
  private async connectAndLogin(
    creds: GoogleAccountCreds,
    persistentIds: string[],
  ): Promise<{ socket: Socket; fr: FrameReader; writer: WritableStreamDefaultWriter<Uint8Array> }> {
    const socket = connect({ hostname: MTALK_HOST, port: MTALK_PORT }, { secureTransport: 'on', allowHalfOpen: false });
    await withTimeout(socket.opened, 10_000, 'socket.opened (TLS mtalk:5228)');
    const writer = socket.writable.getWriter();
    await withTimeout(
      writer.write(buildLoginFrame(creds.gcmAndroidId, creds.gcmSecurityToken, persistentIds)),
      5_000,
      'write LoginRequest',
    );

    const fr = new FrameReader(socket.readable);
    await withTimeout(fr.readByte(), 10_000, 'server version byte');
    for (let i = 0; i < 4; i++) {
      const frame = await withTimeout(fr.readFrame(), 12_000, `login frame#${i}`);
      if (frame.tag === TAG.LoginResponse) {
        const err = loginError(frame.payload);
        if (err) {
          fr.releaseLock();
          writer.releaseLock();
          await socket.close();
          throw new Error(`MCS login failed: code ${err.code} ${err.message ?? ''}`);
        }
        return { socket, fr, writer };
      }
      if (frame.tag === TAG.Close) break;
    }
    fr.releaseLock();
    writer.releaseLock();
    await socket.close();
    throw new Error('MCS login: no LoginResponse before close');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}
