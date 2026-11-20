import type { DatabaseSync } from 'node:sqlite';
import { nowIso, tx } from '../db/connection.ts';
import { uuid, payloadDigest } from './ids.ts';
import { recordOperation } from './audit.ts';
import { badRequest, conflict, notFound, unprocessable } from './errors.ts';
import { jobFor, requireRole, type Actor } from './authz.ts';
import { lockedQuote } from './jobs.ts';
import { netCosts, priceCredits, openFlags } from './ledger.ts';

/** Capture an artifact digest and mark the job delivered (FR-06). */
export function deliver(
  db: DatabaseSync,
  actor: Actor,
  jobId: string,
  input: { artifact_hash?: string; evidence_ref?: string },
) {
  requireRole(actor, 'lead');
  const job = jobFor(db, actor, jobId);
  if (job.status === 'closed') throw conflict('JOB_CLOSED', 'job is closed');
  if (!input.artifact_hash || typeof input.artifact_hash !== 'string' || input.artifact_hash.length < 8)
    throw badRequest('INVALID_HASH', 'artifact_hash is required (digest of the delivered artifact)');

  return tx(db, () => {
    const next = (db.prepare(
      'SELECT COALESCE(MAX(version),0)+1 AS v FROM deliveries WHERE job_id = ?',
    ).get(jobId) as { v: number }).v;
    const id = uuid();
    db.prepare(`INSERT INTO deliveries (id, job_id, version, artifact_hash, evidence_ref, delivered_by, delivered_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, jobId, next, input.artifact_hash, input.evidence_ref ?? null, actor.id, nowIso());
    // a replacement artifact drops the job back to delivered — its prior
    // acceptance never applies to a different hash (T-012)
    db.prepare(`UPDATE jobs SET status='delivered' WHERE id=?`).run(jobId);
    const op = recordOperation(db, actor, {
      action: 'delivery.create', targetType: 'delivery', targetId: id,
      payload: input, decisionCode: 'DELIVERED',
      detail: { version: next, artifact_hash: input.artifact_hash },
    });
    return { delivery_id: id, version: next, operation: op };
  });
}

/** Client accepts the exact delivered hash — binds revenue recognition to
 * the actor bound to this job's client (FR-06, INV-06). */
export function accept(db: DatabaseSync, actor: Actor, deliveryId: string) {
  requireRole(actor, 'client');
  return tx(db, () => {
    const del = db.prepare(
      `SELECT d.id, d.job_id, d.version, d.artifact_hash, j.client_id, j.tenant_id, j.status
       FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE d.id = ?`,
    ).get(deliveryId) as
      | { id: string; job_id: string; version: number; client_id: string; tenant_id: string; status: string }
      | undefined;
    if (!del || del.tenant_id !== actor.tenant_id) throw notFound('delivery not found');
    if (del.client_id !== actor.client_id) throw notFound('delivery not found');
    if (del.status === 'closed') throw conflict('JOB_CLOSED', 'job is closed');
    const latest = db.prepare(
      'SELECT MAX(version) AS v FROM deliveries WHERE job_id = ?',
    ).get(del.job_id) as { v: number };
    if (del.version !== latest.v)
      throw conflict('DELIVERY_SUPERSEDED', 'only the latest delivery can be accepted');
    const prior = db.prepare('SELECT id FROM acceptances WHERE delivery_id = ?').get(deliveryId);
    if (prior) throw conflict('ALREADY_ACCEPTED', 'delivery already accepted');
    const id = uuid();
    db.prepare(`INSERT INTO acceptances (id, delivery_id, job_id, actor_id, accepted_at)
                VALUES (?,?,?,?,?)`).run(id, deliveryId, del.job_id, actor.id, nowIso());
    db.prepare(`UPDATE jobs SET status='accepted' WHERE id=?`).run(del.job_id);
    const op = recordOperation(db, actor, {
      action: 'delivery.accept', targetType: 'delivery', targetId: deliveryId,
      payload: { delivery_id: deliveryId }, decisionCode: 'ACCEPTED',
      detail: { job_id: del.job_id, version: del.version },
    });
    return { acceptance_id: id, job_id: del.job_id, operation: op };
  });
}

/**
 * Immutable close version (FR-06). Requires accepted revenue on the latest
 * delivery and no outstanding payment risk (INV-06). Open attribution flags
 * make the close 'incomplete' but do not block it — the flag stays visible
 * on exports until resolved against a posted entry (T-014).
 */
export function closeJob(db: DatabaseSync, actor: Actor, jobId: string) {
  requireRole(actor, 'finance', 'owner');
  const job = jobFor(db, actor, jobId);
  return tx(db, () => {
    const fresh = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string };
    if (fresh.status !== 'accepted' && fresh.status !== 'closed')
      throw conflict('NOT_ACCEPTED', 'close requires client acceptance of the latest delivery');
    const open = db.prepare(
      `SELECT id, state FROM reservations WHERE job_id = ? AND state IN ('held','dispatched','uncertain')`,
    ).all(jobId) as { id: string; state: string }[];
    if (open.length)
      throw conflict('UNRESOLVED_PAYMENTS',
        'outstanding reservations prevent a reconciled close',
        { open_reservations: open });
    const q = lockedQuote(db, jobId);
    if (!q) throw unprocessable('QUOTE_NOT_LOCKED', 'no locked quote');
    const cursor = (db.prepare(
      'SELECT COALESCE(MAX(seq),0) AS s FROM ledger_entries WHERE job_id = ?',
    ).get(jobId) as { s: number }).s;
    const flags = openFlags(db, jobId) as unknown[];
    const credits = priceCredits(db, jobId);
    const costs = netCosts(db, jobId);
    const margin = q.price_minor - credits - costs;

    const priorClose = db.prepare(
      `SELECT version, ledger_cursor, open_flag_count FROM close_versions
       WHERE job_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(jobId) as { version: number; ledger_cursor: number; open_flag_count: number } | undefined;
    if (priorClose && priorClose.ledger_cursor === cursor && priorClose.open_flag_count === flags.length)
      throw conflict('CLOSE_NO_CHANGE', 'no journal or flag changes since the last close version');

    const version = (priorClose?.version ?? 0) + 1;
    const completeness = flags.length === 0 ? 'complete' : 'incomplete';
    db.prepare(`INSERT INTO close_versions
      (job_id, version, ledger_cursor, price_minor, credits_minor, costs_minor,
       realized_margin_minor, completeness, open_flag_count, closed_by, closed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(jobId, version, cursor, q.price_minor, credits, costs, margin,
        completeness, flags.length, actor.id, nowIso());
    db.prepare(`UPDATE jobs SET status='closed' WHERE id=?`).run(jobId);
    const op = recordOperation(db, actor, {
      action: 'job.close', targetType: 'job', targetId: jobId,
      decisionCode: 'CLOSED', detail: {
        version, ledger_cursor: cursor, realized_margin_minor: margin,
        completeness, open_flag_count: flags.length,
      },
    });
    return { job_id: jobId, version, completeness, open_flag_count: flags.length, realized_margin_minor: margin, ledger_cursor: cursor, operation: op };
  });
}

export function latestDelivery(db: DatabaseSync, jobId: string) {
  return db.prepare(
    `SELECT id, version, artifact_hash, evidence_ref, delivered_by, delivered_at
     FROM deliveries WHERE job_id = ? ORDER BY version DESC LIMIT 1`,
  ).get(jobId);
}

export function deliveryDetail(db: DatabaseSync, actor: Actor, deliveryId: string) {
  const del = db.prepare(
    `SELECT d.*, j.tenant_id, j.client_id FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE d.id = ?`,
  ).get(deliveryId) as Record<string, unknown> | undefined;
  if (!del || del.tenant_id !== actor.tenant_id) throw notFound('delivery not found');
  if (actor.role === 'client' && del.client_id !== actor.client_id) throw notFound('delivery not found');
  const acc = db.prepare(
    'SELECT id, actor_id, accepted_at FROM acceptances WHERE delivery_id = ?',
  ).get(deliveryId);
  return { delivery: del, acceptance: acc ?? null };
}

export function closeVersions(db: DatabaseSync, actor: Actor, jobId: string) {
  jobFor(db, actor, jobId);
  return db.prepare('SELECT * FROM close_versions WHERE job_id = ? ORDER BY version').all(jobId);
}
