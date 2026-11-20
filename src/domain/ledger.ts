import type { DatabaseSync } from 'node:sqlite';
import { nowIso, tx } from '../db/connection.ts';
import { uuid } from './ids.ts';
import { recordOperation } from './audit.ts';
import { badRequest, conflict, notFound, unprocessable } from './errors.ts';
import { jobFor, requireRole, type Actor } from './authz.ts';

export const COST_KINDS = ['labor', 'infra', 'provider_expense', 'shared_cost'] as const;
export const CREDIT_KIND = 'credit';

export interface LedgerEntry {
  seq: number;
  job_id: string;
  kind: string;
  amount_minor: number;
  dedupe_key: string | null;
  reversal_of: number | null;
  source: string;
  actor_id: string;
  note: string | null;
  evidence_ref: string | null;
  created_at: string;
}

/** Insert one immutable journal row. Call inside a transaction. */
export function appendEntry(
  db: DatabaseSync,
  actor: Actor,
  jobId: string,
  e: {
    kind: string;
    amount_minor: number;
    dedupe_key?: string;
    reversal_of?: number;
    source: string;
    statement_id?: string;
    note?: string;
    evidence_ref?: string;
  },
): number {
  const res = db.prepare(`INSERT INTO ledger_entries
    (job_id, kind, amount_minor, dedupe_key, reversal_of, source, statement_id,
     actor_id, note, evidence_ref, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    jobId, e.kind, e.amount_minor, e.dedupe_key ?? null, e.reversal_of ?? null,
    e.source, e.statement_id ?? null, actor.id, e.note ?? null,
    e.evidence_ref ?? null, nowIso(),
  );
  return Number(res.lastInsertRowid);
}

/** Post a manual labor/infra cost or a price credit (FR-02). */
export function postCost(
  db: DatabaseSync,
  actor: Actor,
  jobId: string,
  input: { kind?: string; amount_minor?: number; note?: string; evidence_ref?: string; dedupe_key?: string },
) {
  const job = jobFor(db, actor, jobId);
  const kind = input.kind;
  if (kind === 'labor' || kind === 'infra') requireRole(actor, 'lead', 'worker', 'finance', 'owner');
  else if (kind === CREDIT_KIND) requireRole(actor, 'owner', 'finance');
  else throw badRequest('INVALID_KIND', `kind must be labor|infra|credit`);
  const amount = input.amount_minor;
  if (!Number.isInteger(amount) || (amount as number) <= 0)
    throw badRequest('INVALID_AMOUNT', 'amount_minor must be a positive integer');

  return tx(db, () => {
    if (input.dedupe_key) {
      const dup = db.prepare(
        'SELECT seq FROM ledger_entries WHERE job_id = ? AND dedupe_key = ?',
      ).get(jobId, input.dedupe_key) as { seq: number } | undefined;
      if (dup) {
        const op = recordOperation(db, actor, {
          action: 'cost.post', targetType: 'job', targetId: jobId,
          payload: input, decisionCode: 'COST_DEDUPED', detail: { entry_seq: dup.seq },
        });
        return { job_id: jobId, entry_seq: dup.seq, deduped: true, operation: op };
      }
    }
    const seq = appendEntry(db, actor, jobId, {
      kind: kind as string, amount_minor: amount as number,
      dedupe_key: input.dedupe_key, source: 'manual',
      note: input.note, evidence_ref: input.evidence_ref,
    });
    const op = recordOperation(db, actor, {
      action: 'cost.post', targetType: 'job', targetId: jobId,
      payload: input, decisionCode: 'COST_POSTED',
      detail: { entry_seq: seq, kind, post_close: job.status === 'closed' },
    });
    return { job_id: jobId, entry_seq: seq, deduped: false, post_close: job.status === 'closed', operation: op };
  });
}

/** Evidence-linked correction: appends a reversal tied to the original. */
export function reverseEntry(
  db: DatabaseSync,
  actor: Actor,
  jobId: string,
  entrySeq: number,
  input: { note?: string; evidence_ref?: string },
) {
  requireRole(actor, 'lead', 'finance', 'owner');
  const job = jobFor(db, actor, jobId);
  return tx(db, () => {
    const orig = db.prepare(
      'SELECT seq, kind, amount_minor FROM ledger_entries WHERE seq = ? AND job_id = ?',
    ).get(entrySeq, jobId) as { seq: number; kind: string; amount_minor: number } | undefined;
    if (!orig) throw notFound('ledger entry not found');
    if (orig.kind === 'reversal') throw unprocessable('CANNOT_REVERSE_REVERSAL', 'cannot reverse a reversal');
    const already = db.prepare(
      `SELECT seq FROM ledger_entries WHERE reversal_of = ?`,
    ).get(entrySeq);
    if (already) throw conflict('ALREADY_REVERSED', `entry ${entrySeq} already reversed`);
    const seq = appendEntry(db, actor, jobId, {
      kind: 'reversal', amount_minor: -orig.amount_minor,
      reversal_of: entrySeq, source: 'adjustment',
      note: input.note, evidence_ref: input.evidence_ref,
    });
    const op = recordOperation(db, actor, {
      action: 'cost.reverse', targetType: 'job', targetId: jobId,
      payload: input, decisionCode: 'COST_REVERSED',
      detail: { entry_seq: seq, reversal_of: entrySeq },
    });
    return { job_id: jobId, entry_seq: seq, reversal_of: entrySeq, operation: op };
  });
}

/** Net posted direct costs (labor+infra+provider+shared plus signed reversals). */
export function netCosts(db: DatabaseSync, jobId: string, cursor?: number): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount_minor),0) AS n FROM ledger_entries
     WHERE job_id = ? AND kind IN ('labor','infra','provider_expense','shared_cost','reversal')
       ${cursor !== undefined ? 'AND seq <= ?' : ''}`,
  ).get(...(cursor !== undefined ? [jobId, cursor] : [jobId])) as { n: number };
  return row.n;
}

export function priceCredits(db: DatabaseSync, jobId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount_minor),0) AS n FROM ledger_entries WHERE job_id = ? AND kind = 'credit'`,
  ).get(jobId) as { n: number };
  return row.n;
}

export function ledgerEntries(db: DatabaseSync, jobId: string): LedgerEntry[] {
  return db.prepare(
    `SELECT seq, job_id, kind, amount_minor, dedupe_key, reversal_of, source,
            actor_id, note, evidence_ref, created_at
     FROM ledger_entries WHERE job_id = ? ORDER BY seq`,
  ).all(jobId) as LedgerEntry[];
}

/**
 * Import a shared cost statement and allocate it (FR-02, INV-02).
 * `job_ids` splits equally with a deterministic remainder to the lowest-sorted
 * job ids; `allocations` posts explicit per-job amounts and surfaces the
 * unallocated residual. Repeat import of the same (tenant, source_ref) returns
 * the stored statement without duplicating entries.
 */
export function importStatement(
  db: DatabaseSync,
  actor: Actor,
  input: {
    source_ref?: string;
    currency?: string;
    total_minor?: number;
    job_ids?: string[];
    allocations?: Record<string, number>;
    note?: string;
  },
) {
  requireRole(actor, 'finance', 'lead', 'owner');
  const { source_ref, currency = 'USD', total_minor } = input;
  if (!source_ref) throw badRequest('MISSING_FIELD', 'source_ref is required');
  if (!Number.isInteger(total_minor) || (total_minor as number) < 0)
    throw badRequest('INVALID_AMOUNT', 'total_minor must be a non-negative integer');
  const hasEqual = Array.isArray(input.job_ids) && input.job_ids.length > 0;
  const hasExplicit = input.allocations && Object.keys(input.allocations).length > 0;
  if (!hasEqual && !hasExplicit)
    throw badRequest('MISSING_FIELD', 'provide job_ids (equal split) or allocations (explicit)');

  return tx(db, () => {
    const existing = db.prepare(
      'SELECT id FROM source_statements WHERE tenant_id = ? AND source_ref = ?',
    ).get(actor.tenant_id, source_ref) as { id: string } | undefined;
    if (existing) {
      const allocs = db.prepare(
        'SELECT job_id, amount_minor FROM statement_allocations WHERE statement_id = ? ORDER BY job_id',
      ).all(existing.id);
      const op = recordOperation(db, actor, {
        action: 'statement.import', targetType: 'statement', targetId: existing.id,
        payload: input, decisionCode: 'STATEMENT_DEDUPED',
      });
      return { statement_id: existing.id, deduped: true, allocations: allocs, operation: op };
    }

    // resolve allocation amounts deterministically
    let shares: [string, number][];
    if (hasEqual) {
      const ids = [...new Set(input.job_ids!)].sort();
      const base = Math.floor((total_minor as number) / ids.length);
      let rem = (total_minor as number) % ids.length;
      shares = ids.map((id) => [id, base + (rem-- > 0 ? 1 : 0)]);
    } else {
      shares = Object.entries(input.allocations!)
        .map(([id, amt]) => [id, amt] as [string, number])
        .sort(([a], [b]) => a.localeCompare(b));
      const sum = shares.reduce((s, [, a]) => s + a, 0);
      if (sum > (total_minor as number))
        throw unprocessable('OVER_ALLOCATED', `allocations total ${sum} exceeds statement ${total_minor}`);
      for (const [, amt] of shares)
        if (!Number.isInteger(amt) || amt < 0)
          throw badRequest('INVALID_AMOUNT', 'allocation amounts must be non-negative integers');
    }

    const statementId = uuid();
    db.prepare(`INSERT INTO source_statements
      (id, tenant_id, source_ref, currency, total_minor, note, actor_id, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(statementId, actor.tenant_id, source_ref, currency, total_minor, input.note ?? null, actor.id, nowIso());

    const out: { job_id: string; amount_minor: number }[] = [];
    for (const [jobId, amt] of shares) {
      if (amt === 0) continue;
      const job = jobFor(db, actor, jobId);
      if (job.currency !== currency)
        throw unprocessable('CURRENCY_MISMATCH', `job ${jobId} is ${job.currency}, statement is ${currency}`);
      const seq = appendEntry(db, actor, jobId, {
        kind: 'shared_cost', amount_minor: amt,
        dedupe_key: `stmt:${statementId}`, source: `statement:${source_ref}`,
        statement_id: statementId, note: input.note,
      });
      db.prepare(`INSERT INTO statement_allocations (statement_id, job_id, entry_seq, amount_minor)
                  VALUES (?,?,?,?)`).run(statementId, jobId, seq, amt);
      out.push({ job_id: jobId, amount_minor: amt });
    }
    const op = recordOperation(db, actor, {
      action: 'statement.import', targetType: 'statement', targetId: statementId,
      payload: input, decisionCode: 'STATEMENT_IMPORTED',
      detail: { allocated: out.reduce((s, a) => s + a.amount_minor, 0) },
    });
    return {
      statement_id: statementId, deduped: false, allocations: out,
      unallocated_minor: (total_minor as number) - out.reduce((s, a) => s + a.amount_minor, 0),
      operation: op,
    };
  });
}

export function statementDetail(db: DatabaseSync, actor: Actor, id: string) {
  const st = db.prepare(
    'SELECT * FROM source_statements WHERE id = ? AND tenant_id = ?',
  ).get(id, actor.tenant_id) as Record<string, unknown> | undefined;
  if (!st) throw notFound('statement not found');
  const allocs = db.prepare(
    'SELECT job_id, entry_seq, amount_minor FROM statement_allocations WHERE statement_id = ? ORDER BY job_id',
  ).all(id) as { amount_minor: number }[];
  const allocated = allocs.reduce((s, a) => s + a.amount_minor, 0);
  return {
    statement: st, allocations: allocs,
    allocated_minor: allocated,
    unallocated_minor: (st.total_minor as number) - allocated,
  };
}

export function raiseFlag(db: DatabaseSync, actor: Actor, jobId: string, input: { description?: string }) {
  requireRole(actor, 'lead', 'finance', 'owner');
  jobFor(db, actor, jobId);
  if (!input.description) throw badRequest('MISSING_FIELD', 'description is required');
  return tx(db, () => {
    const id = uuid();
    db.prepare(`INSERT INTO attribution_flags (id, job_id, description, raised_by, raised_at)
                VALUES (?,?,?,?,?)`).run(id, jobId, input.description, actor.id, nowIso());
    const op = recordOperation(db, actor, {
      action: 'flag.raise', targetType: 'job', targetId: jobId,
      payload: input, decisionCode: 'FLAG_RAISED', detail: { flag_id: id },
    });
    return { flag_id: id, operation: op };
  });
}

export function resolveFlag(db: DatabaseSync, actor: Actor, jobId: string, flagId: string, input: { entry_seq?: number }) {
  requireRole(actor, 'lead', 'finance', 'owner');
  jobFor(db, actor, jobId);
  return tx(db, () => {
    const flag = db.prepare(
      'SELECT id, status FROM attribution_flags WHERE id = ? AND job_id = ?',
    ).get(flagId, jobId) as { id: string; status: string } | undefined;
    if (!flag) throw notFound('flag not found');
    if (flag.status === 'resolved') throw conflict('FLAG_RESOLVED', 'flag already resolved');
    const res = db.prepare(`UPDATE attribution_flags
      SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_entry = ?
      WHERE id = ?`).run(actor.id, nowIso(), input.entry_seq ?? null, flagId);
    if (res.changes !== 1) throw conflict('FLAG_RESOLVED', 'flag already resolved');
    const op = recordOperation(db, actor, {
      action: 'flag.resolve', targetType: 'job', targetId: jobId,
      payload: input, decisionCode: 'FLAG_RESOLVED', detail: { flag_id: flagId },
    });
    return { flag_id: flagId, status: 'resolved', operation: op };
  });
}

export function openFlags(db: DatabaseSync, jobId: string) {
  return db.prepare(
    `SELECT id, description, raised_by, raised_at FROM attribution_flags
     WHERE job_id = ? AND status = 'open' ORDER BY raised_at`,
  ).all(jobId);
}
