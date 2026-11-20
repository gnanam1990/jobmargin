import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, fileFixture, type HttpFixture } from './helpers.ts';
import { openDb, migrate } from '../src/db/connection.ts';
import { nowIso } from '../src/db/connection.ts';
import { uuid } from '../src/domain/ids.ts';

// T-001: A lead locks a 1000-cent quote with a 300-cent floor and a client
// can view its own job.
test('T-001: lead locks 1000-cent quote with 300-cent floor; own client reads job', async () => {
  const fx = await httpFixture();
  try {
    const { api, actors } = fx;
    let res = await api(actors.lead, 'POST', '/jobs',
      { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const jobId = res.json.job_id;
    assert.ok(res.json.operation.id, 'operation id persisted');

    res = await api(actors.lead, 'POST', `/jobs/${jobId}/quotes`,
      { price_minor: 1000, min_margin_minor: 300 });
    assert.equal(res.status, 200);
    assert.equal(res.json.version, 1);

    res = await api(actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'locked');

    // client bound to this job's client_id can view its own job
    res = await api(actors.clientAcme, 'GET', `/jobs/${jobId}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.job.id, jobId);
    // client view carries no price/margin data
    assert.equal(res.json.job.price_minor, undefined);
    assert.deepEqual(res.json.quotes, []);
  } finally { fx.cleanup(); }
});

// T-002: A client from another agency cannot read the quote or infer its price.
test('T-002: cross-tenant client gets 404 with no resource details', async () => {
  const fx = await httpFixture();
  try {
    const { api, actors } = fx;
    let res = await api(actors.lead, 'POST', '/jobs',
      { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
    const jobId = res.json.job_id;
    await api(actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
    await api(actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);

    res = await api(actors.outsiderClient, 'GET', `/jobs/${jobId}`);
    assert.equal(res.status, 404);
    // generic 404: no quote, price or existence leakage
    assert.equal(res.json.error.code, 'NOT_FOUND');
    assert.ok(!res.text.includes('price_minor'));

    // also invisible in the outsider's job list
    res = await api(actors.outsiderClient, 'GET', '/jobs');
    assert.equal(res.status, 200);
    assert.equal(res.json.jobs.length, 0);

    // and an unauthenticated caller gets 401
    res = await api(null, 'GET', `/jobs/${jobId}`);
    assert.equal(res.status, 401);
  } finally { fx.cleanup(); }
});

// INV-01: one locked quote per job; locking a newer version supersedes atomically.
test('INV-01: only one locked quote version; lock supersedes previous', async () => {
  const fx = await httpFixture();
  try {
    const { api, actors } = fx;
    let res = await api(actors.lead, 'POST', '/jobs',
      { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
    const jobId = res.json.job_id;
    await api(actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
    await api(actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1200, min_margin_minor: 300 });
    await api(actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
    res = await api(actors.lead, 'POST', `/jobs/${jobId}/quotes/2/lock`);
    assert.equal(res.status, 200);
    res = await api(actors.lead, 'GET', `/jobs/${jobId}`);
    const statuses = res.json.quotes.map((q: any) => `${q.version}:${q.status}`);
    assert.deepEqual(statuses, ['1:superseded', '2:locked']);
  } finally { fx.cleanup(); }
});

// Forward migration from a populated previous schema must preserve data.
test('migration: populated v1 database migrates forward without data loss', () => {
  const fx = fileFixture();
  try {
    const db = fx.db;
    // already fully migrated by fixture; create a second db pinned to 0001
    const db2 = openDb(fx.dir + '/mig.db');
    migrate(db2, 1);
    db2.prepare('INSERT INTO tenants (id, name, kind, created_at) VALUES (?,?,?,?)')
      .run('t-old', 'Old Tenant', 'agency', nowIso());
    const actorId = uuid();
    db2.prepare(`INSERT INTO actors (id, tenant_id, role, display_name, token, created_at)
                 VALUES (?,?,?,?,?,?)`)
      .run(actorId, 't-old', 'lead', 'Old Lead', 'tok-old', nowIso());
    db2.prepare(`INSERT INTO jobs (id, tenant_id, client_id, title, currency, created_by, created_at)
                 VALUES (?,?,?,?,?,?,?)`)
      .run('job-old', 't-old', 'client-x', 'Old Job', 'USD', actorId, nowIso());
    db2.prepare(`INSERT INTO quote_versions
        (job_id, version, price_minor, min_margin_minor, status, created_by, created_at)
        VALUES ('job-old', 1, 500, 100, 'locked', ?, ?)`).run(actorId, nowIso());
    const applied = migrate(db2); // migrate the rest
    assert.ok(applied.length >= 1, 'later migrations applied');
    const job = db2.prepare('SELECT title, currency FROM jobs WHERE id = ?').get('job-old') as any;
    assert.equal(job.title, 'Old Job');
    const quote = db2.prepare('SELECT status, price_minor FROM quote_versions WHERE job_id = ?').get('job-old') as any;
    assert.deepEqual([quote.status, quote.price_minor], ['locked', 500]);
    db2.close();
  } finally { fx.cleanup(); }
});
