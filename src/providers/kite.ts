import type { DatabaseSync } from 'node:sqlite';
import { AmbiguousError, type ProviderAdapter } from './types.ts';
import { JmError } from '../domain/errors.ts';

/**
 * Kite Passport adapter — GATED. Live paid execution is outside this build
 * run: no owner grant covering seller/rail/amount/purpose, no Passport
 * session, and no verified merchant/receipt lookup. The adapter therefore
 * reports no execution capabilities and fails closed; the exact missing
 * proof is recorded in build-progress/jobmargin/HANDOFF.md.
 *
 * When the owner grants authority, implement execute/status against the
 * task-scoped session API (docs.gokite.ai/passport/payments), keep a
 * session-bound route with no allowance fallback, and re-enable via the
 * providers table after verifying merchant + receipt lookup support.
 */
export function makeKiteProvider(_db: DatabaseSync): ProviderAdapter {
  const gated = (what: string): never => {
    throw new JmError(503, 'PROVIDER_NOT_AUTHORIZED',
      `kite ${what} unavailable: external authorization and verified receipt lookup not recorded for this build`,
      { provider: 'kite', missing: ['owner_grant(seller,rail,amount,purpose)', 'passport_session', 'receipt_lookup_proof'] });
  };
  return {
    key: 'kite',
    merchant: 'kite-passport',
    rail: 'kite-x402',
    asset: 'USDC',
    capabilities: { quote: false, execute: false, status_lookup: false, refund: false },
    async execute() { return gated('execute'); },
    async status() { return gated('status'); },
  };
}
