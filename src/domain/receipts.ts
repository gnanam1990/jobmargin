import type { DatabaseSync } from 'node:sqlite';
import { nowIso, tx } from '../db/connection.ts';
import { uuid, payloadDigest } from './ids.ts';
import { recordOperation } from './audit.ts';
import { badRequest, notFound } from './errors.ts';
import { requireRole, type Actor } from './authz.ts';
import { appendEntry } from './ledger.ts';
import { providerRow } from '../providers/registry.ts';

/** Explicitly mapped USD-denominated test units (PRD): USDTEST settles into
 * USD jobs 1:1. Any other cross-asset receipt opens an exception. */
const ASSET_MAP: Record<string, string> = { USDTEST: 'USD' };

function canonicalAsset(asset: string): string {
  return ASSET_MAP[asset] ?? asset;
}

export interface ReceiptInput {
  provider_key?: string;
  provider_ref?: string;
  action_id?: string;
  merchant?: string;
  asset?: string;
  amount_minor?: number;
  tenant_id?: string;
}

/**
 * Ingest a provider statement line (FR-05): verify merchant, asset and amount
 * against the bound attempt, replace the held estimate with the actual cost,
 * and open an exception instead of guessing on any mismatch.
 */
export function importReceipt(
  db: DatabaseSync,
  actor: Actor,
  input: ReceiptInput,
  via: 'import' | 'webhook' = 'import',
) {
  if (via === 'import') requireRole(actor, 'finance', 'owner');
  const { provider_key, provider_ref, merchant, asset, amount_minor } = input;
  for (const [k, v] of Object.entries({ provider_key, provider_ref, merchant, asset }))
    if (!v) throw badRequest('MISSING_FIELD', `${k} is required`);
  if (!Number.isInteger(amount_minor) || (amount_minor as number) < 0)
    throw badRequest('INVALID_AMOUNT', 'amount_minor must be a non-negative integer');
  const provider = providerRow(db, provider_key!);
  if (!provider) throw badRequest('PROVIDER_UNKNOWN', 'provider_key not configured');
  const tenantId = via === 'webhook' ? (input.tenant_id ?? actor.tenant_id) : actor.tenant_id;

  return tx(db, () => {
    // dedupe: the same provider statement replays without double-settling
    const prior = db.prepare(
      'SELECT * FROM receipts WHERE tenant_id = ? AND provider_key = ? AND provider_ref = ?',
    ).get(tenantId, provider_key, provider_ref) as Record<string, unknown> | undefined;
    if (prior) {
      const op = recordOperation(db, actor, {
        action: 'receipt.import', targetType: 'receipt', targetId: prior.id as string,
        payload: input, decisionCode: 'RECEIPT_REPLAYED',
        detail: { status: prior.status, via },
      });
      return { receipt_id: prior.id, status: prior.status, replayed: true, operation: op };
    }

    // match the bound attempt by broker action id or provider ref
    const attempt = db.prepare(
      `SELECT a.*, r.tenant_id AS r_tenant FROM attempts a
       JOIN reservations r ON r.id = a.reservation_id
       WHERE (a.action_id = ? OR a.provider_ref = ?) AND r.tenant_id = ?`,
    ).get(input.action_id ?? provider_ref, provider_ref, tenantId) as
      | { id: string; reservation_id: string; job_id: string; merchant: string; amount_minor: number; action_id: string }
      | undefined;

    const receiptId = uuid();
    const insertReceipt = (status: string) =>
      db.prepare(`INSERT INTO receipts
        (id, tenant_id, provider_key, provider_ref, action_id, merchant, asset,
         amount_minor, status, job_id, reservation_id, attempt_id, via, actor_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(receiptId, tenantId, provider_key, provider_ref, input.action_id ?? null,
          merchant, asset, amount_minor, status, attempt?.job_id ?? null,
          attempt?.reservation_id ?? null, attempt?.id ?? null, via, actor.id, nowIso());

    const openException = (kind: string, detail: Record<string, unknown>) => {
      db.prepare(`INSERT INTO exceptions (id, tenant_id, kind, detail_json, receipt_id, job_id, raised_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(uuid(), tenantId, kind, JSON.stringify(detail), receiptId, attempt?.job_id ?? null, nowIso());
    };

    if (!attempt) {
      insertReceipt('unmatched');
      openException('UNMATCHED_RECEIPT', { provider_ref, action_id: input.action_id ?? null });
      const op = recordOperation(db, actor, {
        action: 'receipt.import', targetType: 'receipt', targetId: receiptId,
        payload: input, decisionCode: 'RECEIPT_UNMATCHED', externalRef: provider_ref, detail: { via },
      });
      return { receipt_id: receiptId, status: 'unmatched', replayed: false, operation: op };
    }

    // verification: merchant, asset, amount
    const job = db.prepare('SELECT currency FROM jobs WHERE id = ?').get(attempt.job_id) as { currency: string };
    if (merchant !== attempt.merchant) {
      insertReceipt('exception');
      openException('MERCHANT_MISMATCH', { expected: attempt.merchant, got: merchant });
      const op = recordOperation(db, actor, {
        action: 'receipt.import', targetType: 'receipt', targetId: receiptId,
        payload: input, decisionCode: 'RECEIPT_EXCEPTION', externalRef: provider_ref,
        detail: { kind: 'MERCHANT_MISMATCH', expected: attempt.merchant, got: merchant, via },
      });
      return { receipt_id: receiptId, status: 'exception', replayed: false, exception: 'MERCHANT_MISMATCH', operation: op };
    }
    if (canonicalAsset(asset!) !== job.currency) {
      insertReceipt('exception');
      openException('ASSET_MISMATCH', { expected: job.currency, got: asset });
      const op = recordOperation(db, actor, {
        action: 'receipt.import', targetType: 'receipt', targetId: receiptId,
        payload: input, decisionCode: 'RECEIPT_EXCEPTION', externalRef: provider_ref,
        detail: { kind: 'ASSET_MISMATCH', expected: job.currency, got: asset, via },
      });
      return { receipt_id: receiptId, status: 'exception', replayed: false, exception: 'ASSET_MISMATCH', operation: op };
    }
    const res = db.prepare('SELECT amount_minor, state FROM reservations WHERE id = ?')
      .get(attempt.reservation_id) as { amount_minor: number; state: string };
    if ((amount_minor as number) > res.amount_minor) {
      insertReceipt('exception');
      openException('AMOUNT_MISMATCH', { held_minor: res.amount_minor, charged_minor: amount_minor });
      const op = recordOperation(db, actor, {
        action: 'receipt.import', targetType: 'receipt', targetId: receiptId,
        payload: input, decisionCode: 'RECEIPT_EXCEPTION', externalRef: provider_ref,
        detail: { kind: 'AMOUNT_MISMATCH', held: res.amount_minor, charged: amount_minor, via },
      });
      return { receipt_id: receiptId, status: 'exception', replayed: false, exception: 'AMOUNT_MISMATCH', operation: op };
    }
    if (!['dispatched', 'uncertain'].includes(res.state)) {
      insertReceipt('exception');
      openException('SETTLEMENT_REVIEW', { reservation_state: res.state });
      const op = recordOperation(db, actor, {
        action: 'receipt.import', targetType: 'receipt', targetId: receiptId,
        payload: input, decisionCode: 'RECEIPT_EXCEPTION', externalRef: provider_ref,
        detail: { kind: 'SETTLEMENT_REVIEW', state: res.state, via },
      });
      return { receipt_id: receiptId, status: 'exception', replayed: false, exception: 'SETTLEMENT_REVIEW', operation: op };
    }

    // settle: post the actual cost once (dedupe guard = ledger dedupe_key)
    insertReceipt('settled');
    const existing = db.prepare(
      `SELECT seq FROM ledger_entries WHERE job_id = ? AND dedupe_key = ?`,
    ).get(attempt.job_id, `receipt:${provider_key}:${provider_ref}`) as { seq: number } | undefined;
    let entrySeq: number | null = existing?.seq ?? null;
    if (!existing) {
      entrySeq = appendEntry(db, actor, attempt.job_id, {
        kind: 'provider_expense', amount_minor: amount_minor as number,
        dedupe_key: `receipt:${provider_key}:${provider_ref}`,
        source: `receipt:${receiptId}`,
        note: `provider charge ${provider_ref} (${asset})`,
      });
    }
    db.prepare(`UPDATE reservations SET state='settled', updated_at=? WHERE id=?`)
      .run(nowIso(), attempt.reservation_id);
    const op = recordOperation(db, actor, {
      action: 'receipt.import', targetType: 'receipt', targetId: receiptId,
      payload: input, decisionCode: 'RECEIPT_SETTLED', externalRef: provider_ref,
      detail: {
        via, entry_seq: entrySeq, held_minor: res.amount_minor,
        released_minor: res.amount_minor - (amount_minor as number),
        asset_mapped: asset !== job.currency ? `${asset}→${job.currency}` : null,
      },
    });
    return {
      receipt_id: receiptId, status: 'settled', replayed: false,
      entry_seq: entrySeq, released_minor: res.amount_minor - (amount_minor as number),
      operation: op,
    };
  });
}

export function listReceipts(db: DatabaseSync, actor: Actor, jobId?: string) {
  if (jobId)
    return db.prepare('SELECT * FROM receipts WHERE job_id = ? AND tenant_id = ? ORDER BY created_at')
      .all(jobId, actor.tenant_id);
  return db.prepare('SELECT * FROM receipts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200')
    .all(actor.tenant_id);
}

export function listExceptions(db: DatabaseSync, actor: Actor) {
  return db.prepare(
    `SELECT id, kind, detail_json, status, receipt_id, job_id, raised_at
     FROM exceptions WHERE tenant_id = ? ORDER BY raised_at DESC`,
  ).all(actor.tenant_id);
}

export function resolveException(
  db: DatabaseSync, actor: Actor, id: string, input: { note?: string },
) {
  requireRole(actor, 'finance', 'owner');
  return tx(db, () => {
    const ex = db.prepare('SELECT * FROM exceptions WHERE id = ? AND tenant_id = ?')
      .get(id, actor.tenant_id) as { id: string; status: string } | undefined;
    if (!ex) throw notFound('exception not found');
    db.prepare(`UPDATE exceptions SET status='resolved', resolved_by=?, resolved_at=?, resolution_note=?
                WHERE id=?`).run(actor.id, nowIso(), input.note ?? null, id);
    const op = recordOperation(db, actor, {
      action: 'exception.resolve', targetType: 'exception', targetId: id,
      payload: input, decisionCode: 'EXCEPTION_RESOLVED',
    });
    return { exception_id: id, status: 'resolved', operation: op };
  });
}
