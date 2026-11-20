import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, type HttpFixture } from './helpers.ts';

async function mkJob(fx: HttpFixture, title: string) {
  const res = await fx.api(fx.actors.lead, 'POST', '/jobs',
    { client_id: 'client-acme', title, currency: 'USD' });
  assert.equal(res.status, 200);
  return res.json.job_id as string;
}

// T-003: distribute five cents equally across three stable job IDs as 2,2,1
// under deterministic rounding.
test('T-003: five-cent statement splits 2,2,1 across three jobs deterministically', async () => {
  const fx = await httpFixture();
  try {
    const a = await mkJob(fx, 'Job A');
    const b = await mkJob(fx, 'Job B');
    const c = await mkJob(fx, 'Job C');
    const res = await fx.api(fx.actors.finance, 'POST', '/statements/import', {
      source_ref: 'stmt-001', currency: 'USD', total_minor: 5,
      job_ids: [c, a, b], // unsorted input — allocation must sort stably
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const amounts: Record<string, number> = {};
    for (const al of res.json.allocations) amounts[al.job_id] = al.amount_minor;
    const sorted = [a, b, c].sort();
    // lowest two sorted ids receive the remainder cents
    assert.equal(amounts[sorted[0]], 2);
    assert.equal(amounts[sorted[1]], 2);
    assert.equal(amounts[sorted[2]], 1);
    assert.equal(res.json.unallocated_minor, 0);

    // ledger shows the shared_cost entries
    const led = await fx.api(fx.actors.finance, 'GET', `/jobs/${sorted[0]}/ledger`);
    assert.equal(led.json.entries[0].kind, 'shared_cost');
    assert.equal(led.json.entries[0].amount_minor, 2);
  } finally { fx.cleanup(); }
});

// T-004: a repeated source statement cannot create a second set of allocations.
test('T-004: repeated statement import dedupes — no second allocations', async () => {
  const fx = await httpFixture();
  try {
    const a = await mkJob(fx, 'Job A');
    const b = await mkJob(fx, 'Job B');
    const body = { source_ref: 'stmt-dup', currency: 'USD', total_minor: 10, job_ids: [a, b] };
    const first = await fx.api(fx.actors.finance, 'POST', '/statements/import', body);
    assert.equal(first.status, 200);
    const second = await fx.api(fx.actors.finance, 'POST', '/statements/import', body);
    assert.equal(second.status, 200);
    assert.equal(second.json.statement_id, first.json.statement_id);
    assert.equal(second.json.deduped, true);

    // exactly two shared_cost entries exist (one per job), not four
    for (const jobId of [a, b]) {
      const led = await fx.api(fx.actors.finance, 'GET', `/jobs/${jobId}/ledger`);
      assert.equal(led.json.entries.filter((e: any) => e.kind === 'shared_cost').length, 1);
    }
  } finally { fx.cleanup(); }
});

// INV-02: allocated + unallocated always equals the source statement total.
test('INV-02: explicit partial allocation surfaces unallocated residual', async () => {
  const fx = await httpFixture();
  try {
    const a = await mkJob(fx, 'Job A');
    const res = await fx.api(fx.actors.finance, 'POST', '/statements/import', {
      source_ref: 'stmt-partial', currency: 'USD', total_minor: 10,
      allocations: { [a]: 7 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.unallocated_minor, 3);

    const detail = await fx.api(fx.actors.finance, 'GET', `/statements/${res.json.statement_id}`);
    assert.equal(detail.json.allocated_minor, 7);
    assert.equal(detail.json.unallocated_minor, 3); // INV-02: 7 + 3 = 10
  } finally { fx.cleanup(); }
});

// Append-only: corrections are reversal entries linked to the original.
test('reversal entry negates the original and preserves the journal', async () => {
  const fx = await httpFixture();
  try {
    const a = await mkJob(fx, 'Job A');
    const post = await fx.api(fx.actors.worker, 'POST', `/jobs/${a}/costs`,
      { kind: 'labor', amount_minor: 50, note: 'review' });
    assert.equal(post.status, 200);
    const seq = post.json.entry_seq;
    const rev = await fx.api(fx.actors.finance, 'POST', `/jobs/${a}/costs/${seq}/reverse`,
      { note: 'double-booked', evidence_ref: 'ev-1' });
    assert.equal(rev.status, 200);
    const led = await fx.api(fx.actors.finance, 'GET', `/jobs/${a}/ledger`);
    assert.equal(led.json.net_costs_minor, 0);
    assert.equal(led.json.entries.length, 2);
    assert.equal(led.json.entries[1].reversal_of, seq);
    // reversing again is a conflict
    const again = await fx.api(fx.actors.finance, 'POST', `/jobs/${a}/costs/${seq}/reverse`, {});
    assert.equal(again.status, 409);
  } finally { fx.cleanup(); }
});
