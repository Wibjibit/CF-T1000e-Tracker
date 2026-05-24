import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, type BlobEnv } from '../lib/crypto/blob';

// A deterministic, valid 32-byte key (base64) for the happy-path tests.
const KEY_32 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const env: BlobEnv = { BLOB_ENC_KEY: KEY_32 };

// A second, different 32-byte key for the wrong-key test.
const OTHER_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));
const otherEnv: BlobEnv = { BLOB_ENC_KEY: OTHER_KEY };

describe('crypto/blob round-trip', () => {
  it('decrypts back to the original plaintext', async () => {
    const plaintext = 'aas_et/the-google-master-token-value';
    const blob = await encrypt(plaintext, env);
    expect(await decrypt(blob, env)).toBe(plaintext);
  });

  it('handles JSON credential blobs and unicode', async () => {
    const plaintext = JSON.stringify({ token: 'abc', owner_key: 'b64==', note: 'café ☕ 🔑' });
    const blob = await encrypt(plaintext, env);
    expect(await decrypt(blob, env)).toBe(plaintext);
  });

  it('handles empty string', async () => {
    const blob = await encrypt('', env);
    expect(await decrypt(blob, env)).toBe('');
  });

  it('reads from D1-style { credentials_nonce, credentials_ciphertext } rows', async () => {
    const plaintext = 'stored-via-d1';
    const { nonce, ciphertext } = await encrypt(plaintext, env);
    // Simulate D1 returning BLOB columns as ArrayBuffer.
    const row = {
      credentials_nonce: nonce.slice().buffer,
      credentials_ciphertext: ciphertext.slice().buffer,
    };
    expect(await decrypt(row, env)).toBe(plaintext);
  });

  it('reads BLOB columns returned as number[] (production D1 shape)', async () => {
    // Regression: production D1 hands BLOBs back as a plain number[], which the
    // first cut of toBytes() rejected ("expected ArrayBuffer or typed array") —
    // it surfaced only on the first live Find Hub poll, never in local tests.
    const plaintext = JSON.stringify({ owner_key: 'deadbeef', master_token: 'aas_et/x' });
    const { nonce, ciphertext } = await encrypt(plaintext, env);
    const row = {
      credentials_nonce: Array.from(nonce),
      credentials_ciphertext: Array.from(ciphertext),
    };
    expect(await decrypt(row, env)).toBe(plaintext);
  });
});

describe('crypto/blob nonce', () => {
  it('uses a fresh 12-byte nonce per encrypt (ciphertexts differ)', async () => {
    const a = await encrypt('same-plaintext', env);
    const b = await encrypt('same-plaintext', env);
    expect(a.nonce.length).toBe(12);
    expect([...a.nonce]).not.toEqual([...b.nonce]);
    expect([...a.ciphertext]).not.toEqual([...b.ciphertext]);
    // ...yet both still decrypt to the same plaintext.
    expect(await decrypt(a, env)).toBe('same-plaintext');
    expect(await decrypt(b, env)).toBe('same-plaintext');
  });
});

describe('crypto/blob tamper rejection', () => {
  it('throws when the ciphertext is altered', async () => {
    const blob = await encrypt('integrity-matters', env);
    blob.ciphertext[0] ^= 0xff; // flip a bit in the body
    await expect(decrypt(blob, env)).rejects.toThrow(/decryption failed/);
  });

  it('throws when the nonce is altered', async () => {
    const blob = await encrypt('integrity-matters', env);
    blob.nonce[0] ^= 0xff;
    await expect(decrypt(blob, env)).rejects.toThrow(/decryption failed/);
  });

  it('throws when decrypted under the wrong key', async () => {
    const blob = await encrypt('secret', env);
    await expect(decrypt(blob, otherEnv)).rejects.toThrow(/decryption failed/);
  });
});

describe('crypto/blob key validation', () => {
  it('throws a clear error when BLOB_ENC_KEY is missing', async () => {
    await expect(encrypt('x', { BLOB_ENC_KEY: '' })).rejects.toThrow(/not set/);
  });

  it('throws when BLOB_ENC_KEY is not 32 bytes', async () => {
    const short = btoa('too-short');
    await expect(encrypt('x', { BLOB_ENC_KEY: short })).rejects.toThrow(/must be 32 bytes/);
  });
});
