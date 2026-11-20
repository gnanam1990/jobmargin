import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, type HttpFixture } from './helpers.ts';
import { createWorker } from '../src/worker/worker.ts';
import { makeEmulator, memStore } from '../src/providers/emulator.ts';

async function closedJob(fx: HttpFixture, opts: { flag?: boolean } = {}) {
  let res = await fx.api(fx.actors.lead, 'POST', '/jobs',
    { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
  const jobId = res.json.job_id as string;
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
  await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/costs`, { kind: 'labor', amount_minor: 680 });
  res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
    { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'call-1' });
  const rid = res.json.reservation.id as string;
  await fx.api(fx.actors.worker, 'POST', `/reservations/${rid}/dispatch`,
    { provider_key: 'emulator', session_cap_minor: 15 });
  await createWorker(fx.db, { emulator: makeEmulator({ store: memStore() }) }).tick();
  const attempt = fx.db.prepare('SELECT provider_ref FROM attempts WHERE reservation_id = ?').get(rid) as any;
  await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
    provider_key: 'emulator', provider_ref: attempt.provider_ref,
    merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 12,
  });
  if (opts.flag)
    await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/flags`,
      { description: 'review-cost record missing for finance QA pass' });
  res = await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/deliveries`,
    { artifact_hash: 'sha256:report-final-001' });
  await fx.api(fx.actors.clientAcme, 'POST', `/deliveries/${res.json.delivery_id}/accept`);
  const close = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
  return { jobId, close: close.json };
}

// T-013: CSV for close v1 reconciles to the on-screen 308-cent gross margin.
test('T-013: close v1 CSV export reconciles to the margin view (INV-07)', async () => {
  const fx = await httpFixture();
  try {
    const { jobId } = await closedJob(fx);
    const m = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
    assert.equal(m.json.realized_margin_minor, 308);

    const res = await fetch(`${fx.base}/jobs/${jobId}/export.csv?version=1`,
      { headers: { authorization: `Bearer ${fx.actors.finance.token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    const csv = await res.text();
    assert.match(csv, /close_summary,realized_margin_minor,308/);
    assert.match(csv, /close_summary,costs_minor,692/);
    assert.match(csv, /close_summary,price_minor,1000/);
    assert.match(csv, /close_summary,completeness,complete/);
    // journal rows present: the 680 labor and the 12 provider expense
    assert.match(csv, /ledger,\d+,labor,680,/);
    assert.match(csv, /ledger,\d+,provider_expense,12,/);

    // the console job page shows the same 308 figure
    const page = await fetch(`${fx.base}/ui/jobs/${jobId}`,
      { headers: { cookie: `jm_session=${fx.actors.lead.token}` } });
    const html = await page.text();
    assert.match(html, /\$3\.08/);
  } finally { fx.cleanup(); }
});

// T-014: a missing review-cost record flagged by the lead makes the close
// incomplete and visible on export.
test('T-014: open attribution flag makes close incomplete and export-visible', async () => {
  const fx = await httpFixture();
  try {
    const { jobId, close } = await closedJob(fx, { flag: true });
    assert.equal(close.completeness, 'incomplete');
    assert.equal(close.open_flag_count, 1);

    const res = await fetch(`${fx.base}/jobs/${jobId}/export.csv`,
      { headers: { authorization: `Bearer ${fx.actors.finance.token}` } });
    const csv = await res.text();
    assert.match(csv, /close_summary,completeness,incomplete/);
    assert.match(csv, /flag,[^,]+,review-cost record missing for finance QA pass,open/);

    // reconciliation view surfaces the open flag
    const rec = await fx.api(fx.actors.finance, 'GET', `/jobs/${jobId}/reconciliation`);
    const openFlags = rec.json.flags.filter((f: any) => f.status === 'open');
    assert.equal(openFlags.length, 1);
  } finally { fx.cleanup(); }
});

// UI surfaces: denial shortfall + reservation owners are visible on the page;
// the client sees only a redacted delivery view.
test('console shows denial shortfall, owners, and a redacted client view', async () => {
  const fx = await httpFixture();
  try {
    let res = await fx.api(fx.actors.lead, 'POST', '/jobs',
      { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
    const jobId = res.json.job_id as string;
    await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
    await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
    await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/costs`, { kind: 'labor', amount_minor: 999 });
    // this request is denied: headroom is negative after floor
    res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
      { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'deny-me' });
    assert.equal(res.json.reservation.state, 'denied');

    const page = await fetch(`${fx.base}/ui/jobs/${jobId}`,
      { headers: { cookie: `jm_session=${fx.actors.lead.token}` } });
    const html = await page.text();
    assert.match(html, /INSUFFICIENT_HEADROOM/);
    assert.match(html, /Wren Worker/); // reservation owner

    // client view: no costs, no margin, no owner names
    const clientPage = await fetch(`${fx.base}/ui/jobs/${jobId}`,
      { headers: { cookie: `jm_session=${fx.actors.clientAcme.token}` } });
    const clientHtml = await clientPage.text();
    assert.doesNotMatch(clientHtml, /INSUFFICIENT_HEADROOM/);
    assert.doesNotMatch(clientHtml, /\$9\.99/);
    assert.doesNotMatch(clientHtml, /Margin floor/);
  } finally { fx.cleanup(); }
});

// CSV access is role-gated; cross-tenant export is a bare 404.
test('export is denied to clients and outsiders', async () => {
  const fx = await httpFixture();
  try {
    const { jobId } = await closedJob(fx);
    let res = await fetch(`${fx.base}/jobs/${jobId}/export.csv`,
      { headers: { authorization: `Bearer ${fx.actors.clientAcme.token}` } });
    assert.equal(res.status, 403);
    res = await fetch(`${fx.base}/jobs/${jobId}/export.csv`,
      { headers: { authorization: `Bearer ${fx.actors.outsiderClient.token}` } });
    assert.equal(res.status, 404);
  } finally { fx.cleanup(); }
});
