import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../db/connection.ts';
import { uuid, payloadDigest } from './ids.ts';
import type { Actor } from './authz.ts';

export interface OperationRef {
  id: string;
  decision_code: string;
}

/** Persist a decision record inside the caller's transaction. */
export function recordOperation(
  db: DatabaseSync,
  actor: Actor,
  opts: {
    action: string;
    targetType?: string;
    targetId?: string;
    payload?: unknown;
    decisionCode: string;
    detail?: Record<string, unknown>;
    externalRef?: string;
    latencyMs?: number;
  },
): OperationRef {
  const id = uuid();
  db.prepare(`INSERT INTO operations
    (id, tenant_id, actor_id, actor_role, action, target_type, target_id,
     payload_digest, decision_code, detail_json, external_ref, latency_ms, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, actor.tenant_id, actor.id, actor.role, opts.action,
    opts.targetType ?? null, opts.targetId ?? null,
    opts.payload !== undefined ? payloadDigest(opts.payload) : null,
    opts.decisionCode, opts.detail ? JSON.stringify(opts.detail) : null,
    opts.externalRef ?? null, opts.latencyMs ?? null, nowIso(),
  );
  return { id, decision_code: opts.decisionCode };
}
