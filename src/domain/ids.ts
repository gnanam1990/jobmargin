import { randomUUID, createHash, randomBytes } from 'node:crypto';

export const uuid = (): string => randomUUID();
export const token = (): string => 'jmt_' + randomBytes(24).toString('hex');

/** Stable digest of a JSON payload for idempotency comparison. */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
