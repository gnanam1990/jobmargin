import type { DatabaseSync } from 'node:sqlite';
import { nowIso, tx } from '../db/connection.ts';
import { uuid, payloadDigest } from './ids.ts';
import { recordOperation } from './audit.ts';
import { badRequest, conflict } from './errors.ts';
import { jobFor, requireRole, type Actor } from './authz.ts';
import { lockedQuote } from './jobs.ts';
import { netCosts, priceCredits } from './ledger.ts';

export const OPEN_STATES = ['held', 'dispatched', 'uncertain'] as const;

export function openHolds(db: DatabaseSync, jobId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount_minor),0) AS n FROM reservations
     WHERE job_id = ? AND state IN ('held','dispatched','uncertain')`,
  ).get(jobId) as { n: number };
  return row.n;
}

/**
 * Decision procedure (TDD): headroom = locked quote price − price credits −
 * minimum margin − net posted attributable costs − open reservation balances.
 * Runs inside the caller's transaction.
 */
export function headroom(db: DatabaseSync, jobId: string): {
  headroom_minor: number;
  quote: { version: number; price_minor: number; min_margin_minor: number } | null;
  credits_minor: number;
  costs_minor: number;
  holds_minor: number;
} {
  const q = lockedQuote(db, jobId);
  const credits = priceCredits(db, jobId);
  const costs = netCosts(db, jobId);
  const holds = openHolds(db, jobId);
  const head = q ? q.price_minor - credits - q.min_margin_minor - costs - holds : 0;
  return {
    headroom_minor: head,
    quote: q ? { version: q.version, price_minor: q.price_minor, min_margin_minor: q.min_margin_minor } : null,
    credits_minor: credits, costs_minor: costs, holds_minor: holds,
  };
}

interface ReservationRow {
  id: string; state: string; amount_minor: number; denial_code: string | null;
  shortfall_minor: number | null; quote_version: number; payload_digest: string;
}

function resvPayload(jobId: string, input: Record<string, unknown>) {
  return { job_id: jobId, amount_minor: input.amount_minor, quote_version: input.quote_version };
}

/**
 * Atomic reservation (FR-03, INV-03). Everything below runs inside one
 * BEGIN IMMEDIATE transaction — approval and hold insertion serialize with
 * every other writer, so the sum of approved holds can never exceed routed
 * headroom at approval time.
 */
export function createReservation(
  db: DatabaseSync,
  actor: Actor,
  jobId: string,
  input: {
    request_key?: string;
    amount_minor?: number;
    quote_version?: number;
    ttl_seconds?: number;
  },
) {
  requireRole(actor, 'worker', 'lead');
  const job = jobFor(db, actor, jobId);
  const requestKey = input.request_key;
  if (!requestKey || typeof requestKey !== 'string')
    throw badRequest('MISSING_IDEMPOTENCY_KEY', 'request_key (Idempotency-Key) is required');
  const digest = payloadDigest(resvPayload(jobId, input));

  return tx(db, () => {
    // idempotent replay / conflict
    const prior = db.prepare(
      'SELECT * FROM reservations WHERE tenant_id = ? AND request_key = ?',
    ).get(actor.tenant_id, requestKey) as ReservationRow | undefined;
    if (prior) {
      if (prior.payload_digest !== digest)
        throw conflict('IDEMPOTENCY_CONFLICT',
          `request_key already used with a different payload`, { reservation_id: prior.id });
      const op = recordOperation(db, actor, {
        action: 'reservation.create', targetType: 'reservation', targetId: prior.id,
        payload: resvPayload(jobId, input), decisionCode: 'RESERVATION_REPLAYED',
      });
      return { reservation: prior, replayed: true, operation: op };
    }

    const deny = (code: string, shortfall: number | null, detail: Record<string, unknown> = {}) => {
      const id = uuid();
      db.prepare(`INSERT INTO reservations
        (id, tenant_id, job_id, request_key, amount_minor, state, quote_version,
         denial_code, shortfall_minor, payload_digest, expires_at, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,'denied',?,?,?,?,?,?,?,?)`)
        .run(id, actor.tenant_id, jobId, requestKey, input.amount_minor ?? 0,
          input.quote_version ?? 0, code, shortfall, digest, null, actor.id, nowIso(), nowIso());
      const op = recordOperation(db, actor, {
        action: 'reservation.create', targetType: 'reservation', targetId: id,
        payload: resvPayload(jobId, input), decisionCode: `DENIED_${code}`,
        detail: { shortfall_minor: shortfall, ...detail },
      });
      return { reservation: row(id), replayed: false, operation: op };
    };

    const row = (id: string) =>
      db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as ReservationRow;

    if (!Number.isInteger(input.amount_minor) || (input.amount_minor as number) <= 0)
      return deny('INVALID_AMOUNT', null);
    if (['closed', 'accepted'].includes(job.status))
      return deny('JOB_NOT_OPEN', null, { job_status: job.status });
    const hr = headroom(db, jobId);
    if (!hr.quote)
      return deny('QUOTE_NOT_LOCKED', null);
    if (input.quote_version !== hr.quote.version)
      return deny('STALE_QUOTE_VERSION', null,
        { locked_version: hr.quote.version, requested: input.quote_version ?? null });
    if ((input.amount_minor as number) > hr.headroom_minor)
      return deny('INSUFFICIENT_HEADROOM',
        (input.amount_minor as number) - hr.headroom_minor,
        { headroom_minor: hr.headroom_minor });

    const expiresAt = input.ttl_seconds
      ? new Date(Date.now() + input.ttl_seconds * 1000).toISOString()
      : null;
    const id = uuid();
    db.prepare(`INSERT INTO reservations
      (id, tenant_id, job_id, request_key, amount_minor, state, quote_version,
       denial_code, shortfall_minor, payload_digest, expires_at, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,'held',?,NULL,NULL,?,?,?,?,?)`)
      .run(id, actor.tenant_id, jobId, requestKey, input.amount_minor,
        hr.quote.version, digest, expiresAt, actor.id, nowIso(), nowIso());
    const op = recordOperation(db, actor, {
      action: 'reservation.create', targetType: 'reservation', targetId: id,
      payload: resvPayload(jobId, input), decisionCode: 'RESERVATION_HELD',
      detail: { headroom_minor: hr.headroom_minor, held_minor: input.amount_minor },
    });
    return { reservation: row(id), replayed: false, operation: op };
  });
}

export function listReservations(db: DatabaseSync, actor: Actor, jobId: string) {
  jobFor(db, actor, jobId);
  return db.prepare(
    `SELECT id, request_key, amount_minor, state, quote_version, denial_code,
            shortfall_minor, expires_at, created_by, created_at, updated_at
     FROM reservations WHERE job_id = ? ORDER BY created_at`,
  ).all(jobId);
}

/**
 * Auto-release expired holds — only 'held' (undispatched) rows may release;
 * dispatched and uncertain balances keep occupying capacity (INV-04).
 */
export function expireHolds(db: DatabaseSync, systemActor: Actor): number {
  const now = nowIso();
  return tx(db, () => {
    const stale = db.prepare(
      `SELECT id, job_id FROM reservations
       WHERE state = 'held' AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).all(now) as { id: string; job_id: string }[];
    for (const r of stale) {
      db.prepare(`UPDATE reservations SET state = 'released', updated_at = ? WHERE id = ? AND state = 'held'`)
        .run(now, r.id);
      recordOperation(db, systemActor, {
        action: 'reservation.expire', targetType: 'reservation', targetId: r.id,
        decisionCode: 'HOLD_EXPIRED', detail: { job_id: r.job_id },
      });
    }
    return stale.length;
  });
}
