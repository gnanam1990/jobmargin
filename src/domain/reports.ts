import type { DatabaseSync } from 'node:sqlite';
import { jobFor, type Actor } from './authz.ts';
import { lockedQuote } from './jobs.ts';
import { netCosts, priceCredits, openFlags } from './ledger.ts';
import { openHolds } from './reservations.ts';
import { notFound } from './errors.ts';

/**
 * Margin view (FR-07 surface; feeds GET /jobs/{id}/margin and the console).
 * Values are computed from the live journal — the same cursor a close
 * version snapshots (INV-07).
 */
export function marginView(db: DatabaseSync, actor: Actor, jobId: string) {
  const job = jobFor(db, actor, jobId);
  if (actor.role === 'client') {
    // clients see delivery state on their own job — never costs or margin
    return { job_id: job.id, status: job.status, currency: job.currency, client_scope: true };
  }
  const q = lockedQuote(db, jobId);
  const credits = priceCredits(db, jobId);
  const costs = netCosts(db, jobId);
  const holds = openHolds(db, jobId);
  const price = q?.price_minor ?? null;
  const headroom = q ? q.price_minor - credits - q.min_margin_minor - costs - holds : null;
  const forecast = q ? q.price_minor - credits - costs - holds : null;
  const accepted = job.status === 'accepted' || job.status === 'closed';
  const holdsList = db.prepare(
    `SELECT id, request_key, amount_minor, state, expires_at, created_by
     FROM reservations WHERE job_id = ? AND state IN ('held','dispatched','uncertain')
     ORDER BY created_at`,
  ).all(jobId);
  return {
    job_id: job.id, status: job.status, currency: job.currency,
    quote: q, price_credits_minor: credits,
    net_costs_minor: costs, open_holds_minor: holds,
    headroom_minor: headroom,
    forecast_margin_minor: forecast,
    realized_margin_minor: accepted && q ? q.price_minor - credits - costs : null,
    open_flags: openFlags(db, jobId),
    open_holds: holdsList,
  };
}
