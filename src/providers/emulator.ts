import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../db/connection.ts';
import { AmbiguousError, type ProviderAdapter } from './types.ts';

export type EmulatorMode =
  | 'ok'                 // charge then report confirmed
  | 'fail'               // definitive provider refusal
  | 'crash-after-accept' // charge lands, then the call fails (worker sees ambiguous)
  | 'lookup-down';       // execute ambiguous AND status lookup unavailable

interface Store {
  get(action_id: string): { provider_ref: string; merchant: string; amount_minor: number; asset: string } | undefined;
  put(c: { action_id: string; provider_ref: string; merchant: string; amount_minor: number; asset: string }): void;
}

/** In-memory charge store (per-process). */
export function memStore(): Store & { all(): Map<string, unknown> } {
  const m = new Map<string, { provider_ref: string; merchant: string; amount_minor: number; asset: string }>();
  return {
    get: (id) => m.get(id),
    put: (c) => m.set(c.action_id, c),
    all: () => m as Map<string, unknown>,
  };
}

/** Durable store backed by emulator_charges — the emulator's own state,
 * deliberately separate from JobMargin's journal. */
export function dbStore(db: DatabaseSync): Store {
  return {
    get: (id) => db.prepare(
      'SELECT provider_ref, merchant, amount_minor, asset FROM emulator_charges WHERE action_id = ?',
    ).get(id) as ReturnType<Store['get']>,
    put: (c) => {
      db.prepare(`INSERT INTO emulator_charges (action_id, provider_ref, merchant, amount_minor, asset, created_at)
                  VALUES (?,?,?,?,?,?)`)
        .run(c.action_id, c.provider_ref, c.merchant, c.amount_minor, c.asset, nowIso());
    },
  };
}

/**
 * Local boundary emulator for deterministic fault injection at the provider
 * edge (TEST-PLAN: "a local boundary emulator is suitable"). The broker
 * action_id is the provider-side idempotency key: a second execute for the
 * same action returns the recorded charge and never double-charges.
 */
export function makeEmulator(opts: { mode?: EmulatorMode; store?: Store } = {}): ProviderAdapter {
  const mode = opts.mode ?? 'ok';
  const store = opts.store ?? memStore();
  let seq = 0;
  const charge = (action_id: string, merchant: string, amount: number) => {
    const prior = store.get(action_id);
    if (prior) return prior.provider_ref;
    const ref = `emu-${++seq}-${action_id.slice(0, 8)}`;
    store.put({ action_id, provider_ref: ref, merchant, amount_minor: amount, asset: 'USDTEST' });
    return ref;
  };
  return {
    key: 'emulator',
    merchant: 'emulator-merchant',
    rail: 'local',
    asset: 'USDTEST',
    capabilities: { quote: true, execute: true, status_lookup: mode !== 'lookup-down', refund: false },
    async execute({ action_id, amount_minor, merchant }) {
      if (mode === 'fail') return { outcome: 'failed', reason: 'merchant refused (emulator)' };
      const ref = charge(action_id, merchant, amount_minor);
      if (mode === 'crash-after-accept')
        throw new AmbiguousError('provider accepted then connection dropped (emulator)');
      if (mode === 'lookup-down')
        throw new AmbiguousError('provider response lost (emulator)');
      return { outcome: 'confirmed', provider_ref: ref };
    },
    async status(action_id) {
      if (mode === 'lookup-down') return { known: false };
      const c = store.get(action_id);
      if (!c) return { known: false };
      return { known: true, status: 'confirmed', provider_ref: c.provider_ref };
    },
  };
}
