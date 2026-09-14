import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function keyFor(value) {
  if (typeof value !== 'string' || value.length < 16) throw new TypeError('ComfyUI credential encryption key must contain at least 16 characters');
  return createHash('sha256').update(value, 'utf8').digest();
}

function decodePart(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`invalid encrypted credential ${label}`);
  return Buffer.from(value, 'base64url');
}

/** Encrypts only credential write data; ciphertext is safe to persist but never to return. */
export function createComfyuiCredentialCrypto({ encryptionKey } = {}) {
  const key = keyFor(encryptionKey);

  return Object.freeze({
    encrypt(credential) {
      const plaintext = Buffer.from(JSON.stringify(credential), 'utf8');
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
    },
    decrypt(value) {
      const parts = typeof value === 'string' ? value.split('.') : [];
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('invalid encrypted credential format');
      const iv = decodePart(parts[1], 'iv');
      const ciphertext = decodePart(parts[2], 'ciphertext');
      const tag = decodePart(parts[3], 'tag');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('invalid encrypted credential length');
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
      } catch {
        throw new Error('encrypted credential cannot be decrypted');
      }
    }
  });
}
