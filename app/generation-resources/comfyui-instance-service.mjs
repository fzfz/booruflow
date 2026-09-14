import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, validateComfyuiInstanceListQuery, validateComfyuiInstanceWrite } from '../security/input-validation.mjs';
import { inTransaction } from '../catalog/database.mjs';
import { comfyuiImpactTokensMatch } from './comfyui-instance-repository.mjs';
import { comfyuiAuthorizationForStoredInstance } from './comfyui-instance-auth.mjs';

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('now must return a valid Date');
  return value.toISOString();
}

function duplicateUrl(error) {
  return /UNIQUE constraint failed: comfyui_instances\.url/u.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

export function createComfyuiInstanceService({ database, repository, crypto, now = () => new Date(), fetchImplementation = fetch } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new TypeError('database must provide prepare and exec transaction methods');
  if (!repository || ['list', 'get', 'getStored', 'create', 'update', 'setValidation', 'getImpact', 'remove'].some((name) => typeof repository[name] !== 'function')) throw new TypeError('ComfyUI instance repository is incomplete');
  if (!crypto || typeof crypto.encrypt !== 'function' || typeof crypto.decrypt !== 'function') throw new TypeError('crypto must provide encrypt and decrypt');
  if (typeof fetchImplementation !== 'function') throw new TypeError('fetchImplementation must be a function');

  function read(id) {
    assertIdentifier(id, 'id');
    const instance = repository.get(id);
    if (!instance) throw new ApplicationError('NOT_FOUND', 'ComfyUI instance was not found');
    return instance;
  }

  function create(input) {
    const request = validateComfyuiInstanceWrite(input, { creating: true });
    const credentialCiphertext = request.credential.type === 'none' ? null : crypto.encrypt(request.credential);
    try {
      return repository.create({ title: request.title, url: request.url, credential_type: request.credential.type, credential_ciphertext: credentialCiphertext, timestamp: timestamp(now) });
    } catch (error) {
      if (duplicateUrl(error)) throw new ApplicationError('DUPLICATE_RESOURCE', 'ComfyUI instance URL already exists');
      throw error;
    }
  }

  function update(id, input) {
    assertIdentifier(id, 'id');
    const request = validateComfyuiInstanceWrite(input, { creating: false });
    const existing = repository.getStored(id);
    if (!existing) throw new ApplicationError('NOT_FOUND', 'ComfyUI instance was not found');
    let credentialType = existing.credential_type;
    let credentialCiphertext = existing.credential_ciphertext;
    if (request.credential.action === 'replace') {
      credentialType = request.credential.type;
      credentialCiphertext = crypto.encrypt(request.credential);
    } else if (request.credential.action === 'clear' || request.credential.type === 'none') {
      credentialType = 'none';
      credentialCiphertext = null;
    }
    const connectionChanged = existing.url !== request.url || existing.credential_type !== credentialType || existing.credential_ciphertext !== credentialCiphertext;
    const isValid = connectionChanged ? false : existing.is_valid === 1;
    const isEnabled = !connectionChanged && isValid && request.is_enabled;
    try {
      return repository.update({ id, title: request.title, url: request.url, credential_type: credentialType, credential_ciphertext: credentialCiphertext, is_enabled: isEnabled, is_valid: isValid, connection_changed: connectionChanged, timestamp: timestamp(now) });
    } catch (error) {
      if (duplicateUrl(error)) throw new ApplicationError('DUPLICATE_RESOURCE', 'ComfyUI instance URL already exists');
      throw error;
    }
  }

  async function validate(id) {
    assertIdentifier(id, 'id');
    const existing = repository.getStored(id);
    if (!existing) throw new ApplicationError('NOT_FOUND', 'ComfyUI instance was not found');
    let valid = false;
    try {
      const authorization = comfyuiAuthorizationForStoredInstance(existing, crypto);
      const response = await fetchImplementation(existing.url, { method: 'GET', headers: authorization === null ? undefined : { authorization } });
      valid = response.ok;
      if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      valid = false;
    }
    return repository.setValidation({ id, is_valid: valid, is_enabled: valid ? existing.is_enabled === 1 : false, timestamp: timestamp(now) });
  }

  return Object.freeze({
    list: (input) => repository.list(validateComfyuiInstanceListQuery(input)),
    create,
    get: read,
    update,
    validate,
    getDeleteImpact(id) {
      assertIdentifier(id, 'id');
      const impact = repository.getImpact(id);
      if (!impact) throw new ApplicationError('NOT_FOUND', 'ComfyUI instance was not found');
      return impact;
    },
    delete(id, impactToken) {
      assertIdentifier(id, 'id');
      return inTransaction(database, () => {
        const impact = repository.getImpact(id);
        if (!impact) throw new ApplicationError('NOT_FOUND', 'ComfyUI instance was not found');
        if (!comfyuiImpactTokensMatch(impactToken, impact.impact_token)) throw new ApplicationError('DELETE_IMPACT_STALE', 'ComfyUI instance delete impact has changed');
        repository.remove(id);
        return Object.freeze({ target: impact.target, cascade_deleted: impact.cascade_deleted, retained: impact.retained });
      });
    }
  });
}
