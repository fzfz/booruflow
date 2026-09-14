import { ApplicationError } from '../security/error-mapping.mjs';

export function comfyuiAuthorizationForStoredInstance(row, crypto) {
  if (row.credential_type === 'none') return null;
  if (typeof row.credential_ciphertext !== 'string') throw new ApplicationError('COMFYUI_CREDENTIAL_ERROR', 'stored ComfyUI credential is unavailable');
  let credential;
  try { credential = crypto.decrypt(row.credential_ciphertext); } catch { throw new ApplicationError('COMFYUI_CREDENTIAL_ERROR', 'stored ComfyUI credential cannot be decrypted'); }
  if (row.credential_type === 'http_basic' && credential?.type === 'http_basic' && typeof credential.username === 'string' && typeof credential.password === 'string') {
    return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`;
  }
  if (row.credential_type === 'bearer' && credential?.type === 'bearer' && typeof credential.token === 'string') return `Bearer ${credential.token}`;
  throw new ApplicationError('COMFYUI_CREDENTIAL_ERROR', 'stored ComfyUI credential has an invalid type');
}
