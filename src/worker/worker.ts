import type { DatabaseSync } from 'node:sqlite';
import { nowIso, tx } from '../db/connection.ts';
import { recordOperation } from '../domain/audit.ts';
import { expireHolds } from '../domain/reservations.ts';
import { AmbiguousError, type ProviderAdapter } from '../providers/types.ts';
import type { Actor } from '../domain/authz.ts';
import { uuid } from '../domain/ids.ts';

const SYSTEM: Actor = { id: 'system', tenant_id: '*', role: 'worker', client_id: null, display_name: 'worker' };

interface OutboxRow {
  id: string; attempt_id: string; status: string;
}
interface AttemptRow {
  id: string; reservation_id: string; job_id: string; action_id: string;
  provider_key: string; merchant: string; amount_minor: number;
  provider_ref: string | null; status: string;
}

export function createWorker(
  db: DatabaseSync,
  providers: Record<string, ProviderAdapter>,
  opts: { workerId?: string; intervalMs?: number } = {},
) {
  const workerId = opts.workerId ?? `worker-${uuid().slice(0, 8)}`;
  const intervalMs = opts.intervalMs ?? 250;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /** Transition attempt + reservation + outbox to a terminal/recoverable state. */
  function finalize(attempt: AttemptRow, outboxId: string,
    outcome: 'confirmed' | 'failed' | 'uncertain', providerRef?: string, errMsg?: string) {
    tx(db, () => {
      const now = nowIso();
      if (outcome === 'confirmed') {
        db.prepare(`UPDATE attempts SET status='confirmed', provider_ref=?, last_error=NULL, updated_at=? WHERE id=?`)
          .run(providerRef ?? null, now, attempt.id);
        db.prepare(`UPDATE reservations SET state='dispatched', updated_at=? WHERE id=? AND state IN ('dispatched','uncertain')`)
          .run(now, attempt.reservation_id);
        db.prepare(`UPDATE dispatch_outbox SET status='done', updated_at=? WHERE id=?`).run(now, outboxId);
      } else if (outcome === 'failed') {
        // definitive provider refusal: safe to void the hold
        db.prepare(`UPDATE attempts SET status='failed', last_error=?, updated_at=? WHERE id=?`)
          .run(errMsg ?? 'provider failed', now, attempt.id);
        db.prepare(`UPDATE reservations SET state='confirmed_void', updated_at=? WHERE id=?`)
          .run(now, attempt.reservation_id);
        db.prepare(`UPDATE dispatch_outbox SET status='done', updated_at=? WHERE id=?`).run(now, outboxId);
      } else {
        // ambiguous: hold keeps occupying capacity (INV-04); no redispatch
        db.prepare(`UPDATE attempts SET status='uncertain', last_error=?, updated_at=? WHERE id=?`)
          .run(errMsg ?? 'outcome unknown', now, attempt.id);
        db.prepare(`UPDATE reservations SET state='uncertain', updated_at=? WHERE id=?`)
          .run(now, attempt.reservation_id);
        db.prepare(`UPDATE dispatch_outbox SET status='uncertain', updated_at=? WHERE id=?`).run(now, outboxId);
      }
      recordOperation(db, SYSTEM, {
        action: 'worker.finalize', targetType: 'attempt', targetId: attempt.id,
        decisionCode: `DISPATCH_${outcome.toUpperCase()}`,
        externalRef: providerRef ?? attempt.action_id,
        detail: { worker_id: workerId, reservation_id: attempt.reservation_id, error: errMsg },
      });
    });
  }

  async function resolveByLookup(attempt: AttemptRow, outboxId: string): Promise<void> {
    const adapter = providers[attempt.provider_key];
    if (!adapter?.capabilities.status_lookup) {
      finalize(attempt, outboxId, 'uncertain', undefined, 'status lookup unavailable — manual reconciliation required');
      return;
    }
    const res = await adapter.status(attempt.action_id);
    if (res.known && res.status === 'confirmed') finalize(attempt, outboxId, 'confirmed', res.provider_ref);
    else if (res.known && res.status === 'failed') finalize(attempt, outboxId, 'failed', undefined, 'provider reports failed');
    else finalize(attempt, outboxId, 'uncertain', undefined, 'provider status unknown — manual reconciliation required');
  }

  /** One work cycle: expiry sweep, pending dispatch, uncertain recovery. */
  async function tick(): Promise<{ claimed: number; resolved: number; expired: number }> {
    const expired = expireHolds(db, { ...SYSTEM });
    let claimed = 0, resolved = 0;

    // 1) recover rows left 'claimed' by a dead worker — resolve by status
    //    lookup only, never a second execute (T-008 / INV-04)
    const stale = db.prepare(
      `SELECT o.id AS outbox_id, o.attempt_id, a.* FROM dispatch_outbox o
       JOIN attempts a ON a.id = o.attempt_id
       WHERE o.status = 'claimed'`,
    ).all() as (OutboxRow & AttemptRow)[];
    for (const row of stale) {
      const won = db.prepare(
        `UPDATE dispatch_outbox SET claimed_by=?, claimed_at=? WHERE id=? AND status='claimed'`,
      ).run(workerId, nowIso(), row.outbox_id).changes === 1;
      if (!won) continue;
      if (row.provider_ref || row.status === 'confirmed') {
        finalize(row, row.outbox_id, 'confirmed', row.provider_ref ?? undefined);
      } else if (row.status === 'uncertain') {
        db.prepare(`UPDATE dispatch_outbox SET status='uncertain', updated_at=? WHERE id=?`).run(nowIso(), row.outbox_id);
      } else {
        await resolveByLookup(row, row.outbox_id);
      }
      resolved++;
    }

    // 2) claim + execute pending outbox rows
    const pending = db.prepare(
      `SELECT o.id AS outbox_id, o.attempt_id, a.* FROM dispatch_outbox o
       JOIN attempts a ON a.id = o.attempt_id
       WHERE o.status = 'pending' ORDER BY o.created_at LIMIT 20`,
    ).all() as (OutboxRow & AttemptRow)[];
    for (const row of pending) {
      const won = db.prepare(
        `UPDATE dispatch_outbox SET status='claimed', claimed_by=?, claimed_at=? WHERE id=? AND status='pending'`,
      ).run(workerId, nowIso(), row.outbox_id).changes === 1;
      if (!won) continue;
      claimed++;
      db.prepare(`UPDATE attempts SET status='sent', updated_at=? WHERE id=?`).run(nowIso(), row.attempt_id);
      const adapter = providers[row.provider_key];
      if (!adapter) {
        finalize(row, row.outbox_id, 'uncertain', undefined, `no adapter for provider ${row.provider_key}`);
        continue;
      }
      try {
        const out = await adapter.execute({
          action_id: row.action_id, amount_minor: row.amount_minor,
          merchant: row.merchant, session_ref: undefined,
        });
        if (out.outcome === 'confirmed') finalize(row, row.outbox_id, 'confirmed', out.provider_ref);
        else finalize(row, row.outbox_id, 'failed', undefined, out.reason);
      } catch (err) {
        if (err instanceof AmbiguousError)
          await resolveByLookup(row, row.outbox_id).catch(() =>
            finalize(row, row.outbox_id, 'uncertain', undefined, 'status lookup failed after ambiguous execute'));
        else
          finalize(row, row.outbox_id, 'uncertain', undefined, `execute error: ${(err as Error).message}`);
      }
    }

    // 3) retry status lookup for uncertain attempts (bounded: only those the
    //    provider can still resolve; rows stay uncertain where it cannot)
    const uncertain = db.prepare(
      `SELECT o.id AS outbox_id, o.attempt_id, a.* FROM dispatch_outbox o
       JOIN attempts a ON a.id = o.attempt_id
       WHERE o.status = 'uncertain'`,
    ).all() as (OutboxRow & AttemptRow)[];
    for (const row of uncertain) {
      const adapter = providers[row.provider_key];
      if (!adapter?.capabilities.status_lookup) continue; // stays unresolved — manual
      const res = await adapter.status(row.action_id).catch(() => ({ known: false }) as Awaited<ReturnType<ProviderAdapter['status']>>);
      if (res.known && res.status === 'confirmed') { finalize(row, row.outbox_id, 'confirmed', res.provider_ref); resolved++; }
      else if (res.known && res.status === 'failed') { finalize(row, row.outbox_id, 'failed', undefined, 'provider reports failed'); resolved++; }
    }
    return { claimed, resolved, expired };
  }

  return {
    workerId,
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        tick().catch((e) => console.error('worker tick error:', e))
          .finally(() => { running = false; });
      }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
