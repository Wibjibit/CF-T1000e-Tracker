// Per-device EIK (Encrypted Identity Key) retrieval.
//
// The EIK is the 32-byte secret every other FMDN crypto step needs. It lives
// encrypted inside the device registration
// (`DeviceRegistration.encryptedUserSecrets.encryptedIdentityKey`), keyed by the
// account-wide `owner_key` (E2EE shared key, cached at bootstrap). TS parity
// port of `desktop-app/src/crypto.rs::decrypt_eik`; see docs/desktop-app-crypto.md.

import { gcm } from '@noble/ciphers/aes.js';

/**
 * Bitwise XOR every byte with 0xFF. The MCU/dev-kit firmware
 * (`fastPairModelId == "003200"`, e.g. the T1000-E) mangles the
 * `encryptedIdentityKey` on the wire "so Android devices cannot decrypt the
 * key"; readers un-flip it. Don't apply to non-MCU devices — you'll get garbage.
 */
export function flipBits(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ 0xff;
  return out;
}

/**
 * Decrypt the per-device EIK using the account-wide `owner_key`. If `isMcu`,
 * the input is un-flipped (XOR 0xFF) first.
 *
 * Two on-wire shapes:
 *   - 60 bytes → AES-GCM `[12-byte IV][32-byte ciphertext][16-byte tag]`
 *     (what the real account dump uses). `owner_key` is 16 (AES-128) or 32
 *     (AES-256) bytes — @noble's `gcm` selects by key length.
 *   - 48 bytes → AES-CBC-no-padding. Never observed in our data; stubbed with a
 *     clear error (matching the Rust), implement if a device ever ships it.
 *
 * Returns the 32-byte EIK. Throws on a wrong key / tampered blob (GCM auth
 * failure), an unexpected blob length, or a plaintext that isn't 32 bytes.
 */
export function decryptEik(
  ownerKey: Uint8Array,
  encryptedIdentityKey: Uint8Array,
  isMcu: boolean,
): Uint8Array {
  if (ownerKey.length !== 16 && ownerKey.length !== 32) {
    throw new Error(`decryptEik: owner_key must be 16 or 32 bytes, got ${ownerKey.length}`);
  }

  const blob = isMcu ? flipBits(encryptedIdentityKey) : encryptedIdentityKey;

  let plaintext: Uint8Array;
  if (blob.length === 60) {
    plaintext = aesGcmDecrypt(ownerKey, blob);
  } else if (blob.length === 48) {
    throw new Error(
      'decryptEik: AES-CBC-no-padding (48-byte EIK) not implemented; ' +
        'add it if a real device produces this shape',
    );
  } else {
    throw new Error(
      `decryptEik: unexpected encrypted_identity_key length ${blob.length} ` +
        '(want 48 for AES-CBC or 60 for AES-GCM)',
    );
  }

  if (plaintext.length !== 32) {
    throw new Error(`decryptEik: decrypted EIK has length ${plaintext.length} (want 32)`);
  }
  return plaintext;
}

/**
 * AES-GCM decrypt a `[12-byte IV][ciphertext][16-byte tag]` blob — the
 * `cryptography.hazmat AESGCM` / @noble layout (ciphertext-then-tag). Shared by
 * EIK (60-byte) and own-report decryption.
 */
export function aesGcmDecrypt(key: Uint8Array, blob: Uint8Array): Uint8Array {
  const IV_LEN = 12;
  if (blob.length < IV_LEN + 16) {
    throw new Error(
      `aesGcmDecrypt: blob length ${blob.length} too short for 12-byte IV + 16-byte tag`,
    );
  }
  const iv = blob.subarray(0, IV_LEN);
  const ctAndTag = blob.subarray(IV_LEN);
  return gcm(key, iv).decrypt(ctAndTag);
}
