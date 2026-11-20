import type { DatabaseSync } from 'node:sqlite';

export interface ProviderRow {
  key: string; label: string; kind: string; merchant: string; rail: string;
  asset: string; live_enabled: number; capabilities: string; note: string | null;
}

const SEED: Omit<ProviderRow, 'note'>[] & { note?: string }[] = [
  {
    key: 'emulator', label: 'Local boundary emulator (test merchant)', kind: 'emulator',
    merchant: 'emulator-merchant', rail: 'local', asset: 'USDTEST', live_enabled: 1,
    capabilities: JSON.stringify({ quote: true, execute: true, status_lookup: true, refund: false }),
    note: 'Deterministic fault-injection boundary; not a real merchant.',
  } as Omit<ProviderRow, 'note'> & { note?: string },
  {
    key: 'kite', label: 'Kite Passport (gated)', kind: 'kite',
    merchant: 'kite-passport', rail: 'kite-x402', asset: 'USDC', live_enabled: 0,
    capabilities: JSON.stringify({ quote: false, execute: false, status_lookup: false, refund: false }),
    note: 'Disabled: no recorded owner grant for paid calls, no session, no verified receipt lookup.',
  } as Omit<ProviderRow, 'note'> & { note?: string },
];

export function ensureProviders(db: DatabaseSync): void {
  for (const p of SEED) {
    db.prepare(`INSERT INTO providers (key, label, kind, merchant, rail, asset, live_enabled, capabilities, note)
                VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(key) DO NOTHING`)
      .run(p.key, p.label, p.kind, p.merchant, p.rail, p.asset, p.live_enabled, p.capabilities, (p as { note?: string }).note ?? null);
  }
}

export function providerRow(db: DatabaseSync, key: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM providers WHERE key = ?').get(key) as ProviderRow | undefined;
}

export function listProviders(db: DatabaseSync): ProviderRow[] {
  return db.prepare('SELECT * FROM providers ORDER BY key').all() as ProviderRow[];
}
