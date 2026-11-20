import type { DatabaseSync } from 'node:sqlite';
import { jobFor, requireRole, type Actor } from './authz.ts';
import { lockedQuote } from './jobs.ts';
import { netCosts, priceCredits, openFlags } from './ledger.ts';
import { openHolds } from './reservations.ts';
import { notFound, unprocessable } from './errors.ts';

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

/** Reconciliation view (FR-07): holds with owners, attempts, receipts,
 * exceptions, flags and unallocated statement residual in one place. */
export function reconciliationView(db: DatabaseSync, actor: Actor, jobId: string) {
  const job = jobFor(db, actor, jobId);
  if (actor.role === 'client') throw notFound();
  const resv = db.prepare(
    `SELECT r.id, r.request_key, r.amount_minor, r.state, r.denial_code,
            r.shortfall_minor, r.expires_at, r.created_at, a.display_name AS owner
     FROM reservations r JOIN actors a ON a.id = r.created_by
     WHERE r.job_id = ? ORDER BY r.created_at`,
  ).all(jobId);
  const attempts = db.prepare(
    `SELECT id, reservation_id, action_id, provider_key, merchant, rail,
            amount_minor, provider_ref, status, last_error, created_at
     FROM attempts WHERE job_id = ? ORDER BY created_at`,
  ).all(jobId);
  const receipts = db.prepare(
    `SELECT id, provider_key, provider_ref, merchant, asset, amount_minor,
            status, via, created_at FROM receipts WHERE job_id = ? ORDER BY created_at`,
  ).all(jobId);
  const exceptions = db.prepare(
    `SELECT id, kind, detail_json, status, receipt_id, raised_at
     FROM exceptions WHERE job_id = ? ORDER BY raised_at`,
  ).all(jobId);
  const unallocated = db.prepare(
    `SELECT s.id, s.source_ref, s.currency, s.total_minor,
            s.total_minor - COALESCE(al.sum,0) AS unallocated_minor
     FROM source_statements s
     LEFT JOIN (SELECT statement_id, SUM(amount_minor) AS sum
                FROM statement_allocations GROUP BY statement_id) al
       ON al.statement_id = s.id
     WHERE s.tenant_id = ? AND s.total_minor - COALESCE(al.sum,0) > 0`,
  ).all(job.tenant_id);
  const flags = db.prepare(
    `SELECT id, description, status, raised_by, raised_at, resolution_entry
     FROM attribution_flags WHERE job_id = ? ORDER BY raised_at`,
  ).all(jobId);
  const closes = db.prepare(
    'SELECT version, ledger_cursor, realized_margin_minor, completeness, closed_by, closed_at FROM close_versions WHERE job_id = ? ORDER BY version',
  ).all(jobId);
  return {
    job: { id: job.id, title: job.title, status: job.status, currency: job.currency },
    reservations: resv, attempts, receipts, exceptions, flags,
    unallocated_statements: unallocated, closes,
  };
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Per-job CSV export bound to a close version: rows are exactly the journal
 * entries at that version's cursor, so the export reconciles to the same
 * numbers the console shows (INV-07).
 */
export function exportCsv(db: DatabaseSync, actor: Actor, jobId: string, version?: number) {
  const job = jobFor(db, actor, jobId); // scope first: outsiders get a bare 404
  requireRole(actor, 'owner', 'lead', 'finance');
  const close = db.prepare(
    `SELECT * FROM close_versions WHERE job_id = ? ${version !== undefined ? 'AND version = ?' : ''}
     ORDER BY version DESC LIMIT 1`,
  ).get(...(version !== undefined ? [jobId, version] : [jobId])) as Record<string, unknown> | undefined;
  if (!close) throw unprocessable('NO_CLOSE', 'no close version to export');
  const cursor = close.ledger_cursor as number;
  const entries = db.prepare(
    `SELECT seq, kind, amount_minor, dedupe_key, reversal_of, source, actor_id, note, evidence_ref, created_at
     FROM ledger_entries WHERE job_id = ? AND seq <= ? ORDER BY seq`,
  ).all(jobId, cursor) as Record<string, unknown>[];
  const flags = db.prepare(
    `SELECT id, description, status, raised_at FROM attribution_flags WHERE job_id = ?`,
  ).all(jobId) as Record<string, unknown>[];

  const lines: string[] = [];
  lines.push(`# jobmargin export job=${job.id} close_version=${close.version} ledger_cursor=${cursor}`);
  lines.push(`# job,${csvCell(job.title)},client=${csvCell(job.client_id)},currency=${job.currency},status=${job.status}`);
  lines.push('section,entry');
  lines.push('close_summary,field,value');
  for (const [k, label] of [
    ['price_minor', 'price_minor'], ['credits_minor', 'credits_minor'],
    ['costs_minor', 'costs_minor'], ['realized_margin_minor', 'realized_margin_minor'],
    ['completeness', 'completeness'], ['open_flag_count', 'open_flag_count'],
    ['closed_by', 'closed_by'], ['closed_at', 'closed_at'],
  ] as const)
    lines.push(`close_summary,${label},${csvCell(close[k])}`);
  lines.push('ledger,seq,kind,amount_minor,dedupe_key,reversal_of,source,actor_id,note,evidence_ref,created_at');
  for (const e of entries)
    lines.push(`ledger,${e.seq},${e.kind},${e.amount_minor},${csvCell(e.dedupe_key)},${e.reversal_of ?? ''},${csvCell(e.source)},${e.actor_id},${csvCell(e.note)},${csvCell(e.evidence_ref)},${e.created_at}`);
  lines.push('flag,id,description,status,raised_at');
  for (const f of flags)
    lines.push(`flag,${f.id},${csvCell(f.description)},${f.status},${f.raised_at}`);
  return {
    filename: `job-${job.id.slice(0, 8)}-close-v${close.version}.csv`,
    csv: lines.join('\n') + '\n',
    close,
  };
}
