import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, type HttpFixture } from './helpers.ts';
import { createWorker } from '../src/worker/worker.ts';
import { makeEmulator, memStore } from '../src/providers/emulator.ts';

/** Job at $10/$3 floor/$6.80 costs + dispatched 15¢ hold through the emulator. */
async function dispatchedJob(fx: HttpFixture) {
  let res = await fx.api(fx.actors.lead, 'POST', '/jobs',
    { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
  const jobId = res.json.job_id as string;
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
  await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/costs`, { kind: 'labor', amount_minor: 680 });
  res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
    { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'call-1' });
  const reservationId = res.json.reservation.id as string;
  res = await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
    { provider_key: 'emulator', session_ref: 'sess-1', session_cap_minor: 15 });
  const actionId = res.json.action_id as string;
  const store = memStore();
  const worker = createWorker(fx.db, { emulator: makeEmulator({ store }) });
  await worker.tick();
  const attempt = fx.db.prepare('SELECT provider_ref FROM attempts WHERE reservation_id = ?')
    .get(reservationId) as { provider_ref: string };
  return { jobId, reservationId, actionId, providerRef: attempt.provider_ref };
}

// T-009: a 12-cent receipt against a 15-cent hold releases 3 cents;
// replay does not affect headroom.
test('T-009: 12c receipt against 15c hold settles once; replay is a no-op', async () => {
  const fx = await httpFixture();
  try {
    const { jobId, providerRef } = await dispatchedJob(fx);
    let res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: providerRef,
      merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 12,
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.status, 'settled');
    assert.equal(res.json.released_minor, 3);

    let m = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
    assert.equal(m.json.headroom_minor, 8); // 1000 − 300 − 680 − 12
    assert.equal(m.json.open_holds_minor, 0);

    // replay of the same statement: deduped, headroom unchanged (INV-05)
    res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: providerRef,
      merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 12,
    });
    assert.equal(res.json.replayed, true);
    m = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
    assert.equal(m.json.headroom_minor, 8);
    const led = await fx.api(fx.actors.finance, 'GET', `/jobs/${jobId}/ledger`);
    assert.equal(led.json.entries.filter((e: any) => e.kind === 'provider_expense').length, 1);
  } finally { fx.cleanup(); }
});

// T-010: a receipt in a different asset or with a mismatched merchant opens
// an exception.
test('T-010: mismatched merchant and wrong asset open exceptions, no settlement', async () => {
  const fx = await httpFixture();
  try {
    const { jobId, providerRef } = await dispatchedJob(fx);

    // wrong merchant
    let res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: providerRef,
      merchant: 'unrelated-shop', asset: 'USDTEST', amount_minor: 12,
    });
    assert.equal(res.json.status, 'exception');
    assert.equal(res.json.exception, 'MERCHANT_MISMATCH');

    // different provider_ref this time, wrong asset
    res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: `${providerRef}-eur`,
      action_id: undefined, merchant: 'emulator-merchant', asset: 'EUR', amount_minor: 12,
    });
    // EUR receipt cannot match the attempt by provider_ref — but action match
    // via provider_ref fails, so it should be unmatched, not settled
    assert.ok(['exception', 'unmatched'].includes(res.json.status));

    // asset mismatch on a matching attempt
    const attempt = fx.db.prepare('SELECT action_id FROM attempts WHERE provider_ref = ?').get(providerRef) as any;
    res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: `${providerRef}-v2`,
      action_id: attempt.action_id, merchant: 'emulator-merchant', asset: 'BTC', amount_minor: 12,
    });
    assert.equal(res.json.status, 'exception');
    assert.equal(res.json.exception, 'ASSET_MISMATCH');

    const ex = await fx.api(fx.actors.finance, 'GET', '/exceptions');
    const kinds = ex.json.exceptions.map((e: any) => e.kind).sort();
    assert.ok(kinds.includes('MERCHANT_MISMATCH'));
    assert.ok(kinds.includes('ASSET_MISMATCH'));

    // nothing settled: hold still occupies
    const m = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
    assert.equal(m.json.open_holds_minor, 15);
  } finally { fx.cleanup(); }
});

// INV-05: a settled receipt changes net cost once across worker and webhook paths.
test('INV-05: webhook settle then import replay — cost posted exactly once', async () => {
  const fx = await httpFixture();
  try {
    const { jobId, providerRef } = await dispatchedJob(fx);
    // unverified webhook is rejected as evidence
    let res = await fx.api(null, 'POST', '/receipts/webhook', {
      tenant_id: 'agency-1', provider_key: 'emulator', provider_ref: providerRef,
      merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 12,
    });
    assert.equal(res.status, 401);

    // verified webhook settles
    res = await fx.api(null, 'POST', '/receipts/webhook', {
      tenant_id: 'agency-1', provider_key: 'emulator', provider_ref: providerRef,
      merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 12,
    }, { 'x-webhook-secret': 'dev-secret' });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'settled');

    // import path replay dedupes on (tenant, provider, provider_ref)
    res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: providerRef,
      merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 12,
    });
    assert.equal(res.json.replayed, true);
    const led = await fx.api(fx.actors.finance, 'GET', `/jobs/${jobId}/ledger`);
    assert.equal(led.json.entries.filter((e: any) => e.kind === 'provider_expense').length, 1);
    assert.equal(led.json.net_costs_minor, 692); // 680 + 12
  } finally { fx.cleanup(); }
});
