import type { DatabaseSync } from 'node:sqlite';
import { nowIso, tx } from '../db/connection.ts';
import { uuid } from './ids.ts';
import { recordOperation } from './audit.ts';
import { badRequest, conflict, notFound, unprocessable } from './errors.ts';
import { jobFor, requireRole, type Actor } from './authz.ts';
import { providerRow } from '../providers/registry.ts';

/**
 * Bind a held reservation to a payment-session cap, provider and rail, then
 * persist the attempt intent + outbox row atomically (FR-04). The provider
 * call itself happens later in the worker — a crash between decision and
 * dispatch leaves a durable pending outbox row, never a lost intent.
 */
export function dispatchReservation(
  db: DatabaseSync,
  actor: Actor,
  reservationId: string,
  input: { provider_key?: string; session_ref?: string; session_cap_minor?: number },
) {
  requireRole(actor, 'worker', 'lead');
  const res = db.prepare(
    `SELECT id, job_id, tenant_id, amount_minor, state FROM reservations WHERE id = ?`,
  ).get(reservationId) as
    | { id: string; job_id: string; tenant_id: string; amount_minor: number; state: string }
    | undefined;
  if (!res || res.tenant_id !== actor.tenant_id) throw notFound('reservation not found');
  const job = jobFor(db, actor, res.job_id);

  return tx(db, () => {
    const fresh = db.prepare('SELECT state FROM reservations WHERE id = ?').get(res.id) as { state: string };
    if (fresh.state !== 'held')
      throw conflict('RESERVATION_NOT_HELD', `reservation is ${fresh.state}, not held`,
        { state: fresh.state });
    const provider = providerRow(db, input.provider_key ?? '');
    if (!provider) throw unprocessable('PROVIDER_UNKNOWN', 'provider_key not configured');
    const caps = JSON.parse(provider.capabilities) as { execute: boolean };
    if (!provider.live_enabled || !caps.execute)
      throw unprocessable('PROVIDER_UNAVAILABLE',
        `provider ${provider.key} is not enabled for live execution`,
        { provider: provider.key, capabilities: JSON.parse(provider.capabilities), note: provider.note });
    const cap = input.session_cap_minor;
    if (!Number.isInteger(cap) || (cap as number) <= 0)
      throw badRequest('INVALID_CAP', 'session_cap_minor must be a positive integer');
    if (res.amount_minor > (cap as number))
      throw unprocessable('AMOUNT_EXCEEDS_CAP',
        `reservation ${res.amount_minor} exceeds session cap ${cap}`,
        { amount_minor: res.amount_minor, session_cap_minor: cap });
    if (!['open', 'delivered'].includes(job.status))
      throw conflict('JOB_NOT_OPEN', `job is ${job.status}`);

    const attemptId = uuid();
    const actionId = uuid(); // broker action id — provider idempotency key
    const now = nowIso();
    db.prepare(`INSERT INTO attempts
      (id, reservation_id, job_id, action_id, provider_key, session_ref,
       session_cap_minor, merchant, rail, amount_minor, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'intent',?,?)`)
      .run(attemptId, res.id, res.job_id, actionId, provider.key,
        input.session_ref ?? null, cap, provider.merchant, provider.rail,
        res.amount_minor, now, now);
    const outboxId = uuid();
    db.prepare(`INSERT INTO dispatch_outbox (id, attempt_id, status, created_at, updated_at)
                VALUES (?,?, 'pending', ?, ?)`).run(outboxId, attemptId, now, now);
    db.prepare(`UPDATE reservations SET state = 'dispatched', updated_at = ? WHERE id = ?`)
      .run(now, res.id);
    const op = recordOperation(db, actor, {
      action: 'reservation.dispatch', targetType: 'attempt', targetId: attemptId,
      payload: { reservation_id: res.id, provider_key: provider.key },
      decisionCode: 'DISPATCH_QUEUED', externalRef: actionId,
      detail: { outbox_id: outboxId, amount_minor: res.amount_minor, merchant: provider.merchant, rail: provider.rail },
    });
    return { attempt_id: attemptId, action_id: actionId, outbox_id: outboxId, operation: op };
  });
}

export function attemptByReservation(db: DatabaseSync, reservationId: string) {
  return db.prepare('SELECT * FROM attempts WHERE reservation_id = ?')
    .get(reservationId) as Record<string, unknown> | undefined;
}

export function listAttempts(db: DatabaseSync, actor: Actor, jobId: string) {
  jobFor(db, actor, jobId);
  return db.prepare(
    `SELECT a.id, a.reservation_id, a.action_id, a.provider_key, a.merchant, a.rail,
            a.amount_minor, a.provider_ref, a.status, a.last_error, a.created_at
     FROM attempts a WHERE a.job_id = ? ORDER BY a.created_at`,
  ).all(jobId);
}
