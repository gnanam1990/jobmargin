import type { DatabaseSync } from 'node:sqlite';
import { nowIso, tx } from '../db/connection.ts';
import { uuid, payloadDigest } from './ids.ts';
import { recordOperation } from './audit.ts';
import { badRequest, conflict, notFound, unprocessable } from './errors.ts';
import { jobFor, requireRole, type Actor } from './authz.ts';

export const CURRENCIES = ['USD', 'USDTEST'] as const;
export type Currency = (typeof CURRENCIES)[number];

export function createJob(
  db: DatabaseSync,
  actor: Actor,
  input: { client_id?: string; title?: string; currency?: string },
) {
  requireRole(actor, 'owner', 'lead');
  const { client_id, title } = input;
  const currency = (input.currency ?? 'USD') as Currency;
  if (!client_id || typeof client_id !== 'string') throw badRequest('MISSING_FIELD', 'client_id is required');
  if (!title || typeof title !== 'string') throw badRequest('MISSING_FIELD', 'title is required');
  if (!CURRENCIES.includes(currency)) throw unprocessable('UNSUPPORTED_CURRENCY', `unsupported currency ${input.currency}`);

  return tx(db, () => {
    const id = uuid();
    db.prepare(`INSERT INTO jobs (id, tenant_id, client_id, title, currency, created_by, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, actor.tenant_id, client_id, title, currency, actor.id, nowIso());
    const op = recordOperation(db, actor, {
      action: 'job.create', targetType: 'job', targetId: id,
      payload: input, decisionCode: 'JOB_CREATED',
    });
    return { job_id: id, operation: op };
  });
}

export function createQuote(
  db: DatabaseSync,
  actor: Actor,
  jobId: string,
  input: { price_minor?: number; min_margin_minor?: number },
) {
  requireRole(actor, 'owner', 'lead');
  const job = jobFor(db, actor, jobId);
  if (job.status === 'closed') throw conflict('JOB_CLOSED', 'job is closed');
  const { price_minor, min_margin_minor } = input;
  if (!Number.isInteger(price_minor) || (price_minor as number) < 0)
    throw badRequest('INVALID_AMOUNT', 'price_minor must be a non-negative integer minor units');
  if (!Number.isInteger(min_margin_minor) || (min_margin_minor as number) < 0)
    throw badRequest('INVALID_AMOUNT', 'min_margin_minor must be a non-negative integer minor units');
  if ((min_margin_minor as number) > (price_minor as number))
    throw unprocessable('MARGIN_EXCEEDS_PRICE', 'margin floor cannot exceed the quoted price');

  return tx(db, () => {
    const next = (db.prepare(
      'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM quote_versions WHERE job_id = ?',
    ).get(jobId) as { v: number }).v;
    db.prepare(`INSERT INTO quote_versions
      (job_id, version, price_minor, min_margin_minor, status, created_by, created_at, payload_digest)
      VALUES (?,?,?,?,'draft',?,?,?)`)
      .run(jobId, next, price_minor, min_margin_minor, actor.id, nowIso(), payloadDigest(input));
    const op = recordOperation(db, actor, {
      action: 'quote.create', targetType: 'job', targetId: jobId,
      payload: input, decisionCode: 'QUOTE_DRAFTED',
      detail: { version: next, currency: job.currency },
    });
    return { job_id: jobId, version: next, status: 'draft', operation: op };
  });
}

/**
 * Lock a quote revision — the lead's authorized commercial commitment.
 * Atomically supersedes any previously locked version (INV-01).
 */
export function lockQuote(db: DatabaseSync, actor: Actor, jobId: string, version: number) {
  requireRole(actor, 'owner', 'lead');
  const job = jobFor(db, actor, jobId);
  if (job.status === 'closed') throw conflict('JOB_CLOSED', 'job is closed');

  return tx(db, () => {
    const quote = db.prepare(
      'SELECT version, status, price_minor, min_margin_minor FROM quote_versions WHERE job_id = ? AND version = ?',
    ).get(jobId, version) as { version: number; status: string } | undefined;
    if (!quote) throw notFound('quote version not found');
    if (quote.status === 'locked') {
      const op = recordOperation(db, actor, {
        action: 'quote.lock', targetType: 'job', targetId: jobId,
        decisionCode: 'QUOTE_ALREADY_LOCKED', detail: { version },
      });
      return { job_id: jobId, version, status: 'locked', operation: op };
    }
    db.prepare(`UPDATE quote_versions SET status = 'superseded'
                WHERE job_id = ? AND status = 'locked'`).run(jobId);
    const res = db.prepare(`UPDATE quote_versions
      SET status = 'locked', locked_by = ?, locked_at = ?
      WHERE job_id = ? AND version = ? AND status = 'draft'`)
      .run(actor.id, nowIso(), jobId, version);
    if (res.changes !== 1) throw conflict('QUOTE_NOT_DRAFT', 'only a draft quote can be locked');
    const op = recordOperation(db, actor, {
      action: 'quote.lock', targetType: 'job', targetId: jobId,
      decisionCode: 'QUOTE_LOCKED', detail: { version },
    });
    return { job_id: jobId, version, status: 'locked', operation: op };
  });
}

export function lockedQuote(db: DatabaseSync, jobId: string) {
  return db.prepare(
    `SELECT version, price_minor, min_margin_minor, locked_by, locked_at
     FROM quote_versions WHERE job_id = ? AND status = 'locked'`,
  ).get(jobId) as
    | { version: number; price_minor: number; min_margin_minor: number; locked_by: string; locked_at: string }
    | undefined;
}

export function jobDetail(db: DatabaseSync, actor: Actor, jobId: string) {
  const job = jobFor(db, actor, jobId);
  const quotes = db.prepare(
    `SELECT version, price_minor, min_margin_minor, status, created_by, created_at, locked_by, locked_at
     FROM quote_versions WHERE job_id = ? ORDER BY version`,
  ).all(jobId);
  const clientActor = actor.role === 'client';
  if (clientActor) {
    // client view: no cost or margin data, own job + delivery state only
    return { job: { id: job.id, title: job.title, status: job.status, currency: job.currency, client_id: job.client_id }, quotes: [] };
  }
  return { job, quotes };
}

export function listJobs(db: DatabaseSync, actor: Actor) {
  if (actor.role === 'client') {
    return db.prepare(
      `SELECT id, client_id, title, currency, status, created_at FROM jobs
       WHERE tenant_id = ? AND client_id = ? ORDER BY created_at DESC`,
    ).all(actor.tenant_id, actor.client_id);
  }
  return db.prepare(
    `SELECT id, client_id, title, currency, status, created_at FROM jobs
     WHERE tenant_id = ? ORDER BY created_at DESC`,
  ).all(actor.tenant_id);
}
