import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
import { openDb, migrate, nowIso } from '../src/db/connection.ts';
import { ensureProviders } from '../src/providers/registry.ts';
import { token, uuid } from '../src/domain/ids.ts';
import { buildRouter } from '../src/http/routes.ts';
import { createApp } from '../src/http/server.ts';
import * as consoleUi from '../src/http/console.ts';
import type { Server } from 'node:http';
import type { Actor } from '../src/domain/authz.ts';
import type { JmError } from '../src/domain/errors.ts';

export interface FixtureActors {
  owner: Actor & { token: string };
  lead: Actor & { token: string };
  worker: Actor & { token: string };
  finance: Actor & { token: string };
  clientAcme: Actor & { token: string };
  outsiderClient: Actor & { token: string };
}

export interface Fixture {
  db: DatabaseSync;
  dir: string;
  dbPath: string;
  actors: FixtureActors;
  cleanup: () => void;
}

function seedActor(db: DatabaseSync, tenant: string, role: string, name: string, clientId: string | null) {
  const id = uuid();
  const tok = token();
  db.prepare(`INSERT INTO actors (id, tenant_id, role, client_id, display_name, token, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, tenant, role, clientId, name, tok, nowIso());
  return { id, tenant_id: tenant, role, client_id: clientId, display_name: name, token: tok };
}

/** In-memory migrated DB seeded with two tenants and a full role set. */
export function memFixture(): Fixture {
  const db = openDb(':memory:');
  migrate(db);
  const dir = mkdtempSync(join(TMP_ROOT, "jm-"));
  return seedInto(db, dir, join(dir, 'jobmargin.db'));
}

/** File-backed migrated DB — used by restart/concurrency tests. */
export function fileFixture(): Fixture {
  const dir = mkdtempSync(join(TMP_ROOT, "jm-"));
  const dbPath = join(dir, 'jobmargin.db');
  const db = openDb(dbPath);
  migrate(db);
  return seedInto(db, dir, dbPath);
}

function seedInto(db: DatabaseSync, dir: string, dbPath: string): Fixture {
  db.prepare('INSERT INTO tenants (id, name, kind, created_at) VALUES (?,?,?,?)')
    .run('agency-1', 'Agency One', 'agency', nowIso());
  db.prepare('INSERT INTO tenants (id, name, kind, created_at) VALUES (?,?,?,?)')
    .run('agency-2', 'Agency Two', 'agency', nowIso());
  ensureProviders(db);
  const actors: FixtureActors = {
    owner: seedActor(db, 'agency-1', 'owner', 'Ada Owner', null) as FixtureActors['owner'],
    lead: seedActor(db, 'agency-1', 'lead', 'Lee Lead', null) as FixtureActors['lead'],
    worker: seedActor(db, 'agency-1', 'worker', 'Wren Worker', null) as FixtureActors['worker'],
    finance: seedActor(db, 'agency-1', 'finance', 'Fran Finance', null) as FixtureActors['finance'],
    clientAcme: seedActor(db, 'agency-1', 'client', 'Clio Client', 'client-acme') as FixtureActors['clientAcme'],
    outsiderClient: seedActor(db, 'agency-2', 'client', 'Otto Outsider', 'client-other') as FixtureActors['outsiderClient'],
  };
  return {
    db, dir, dbPath, actors,
    cleanup: () => { try { db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); },
  };
}

export interface HttpFixture extends Fixture {
  server: Server;
  base: string;
  api: (actor: Actor & { token: string } | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any; text: string }>;
}

/** Real HTTP server on an ephemeral port against a file-backed DB. */
export async function httpFixture(fixture?: Fixture): Promise<HttpFixture> {
  const fx = fixture ?? fileFixture();
  const router = buildRouter(fx.db);
  const server = createApp({
    db: fx.db, router,
    renderError: (err: JmError, actor: Actor | null) =>
      consoleUi.layout(consoleUi.errorPage(err, actor), actor),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api: HttpFixture['api'] = async (actor, method, path, body, headers = {}) => {
    const h: Record<string, string> = { ...headers };
    if (actor) h.authorization = `Bearer ${actor.token}`;
    let payload: string | undefined;
    if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  };
  return {
    ...fx, server, base, api,
    cleanup: () => { server.close(); fx.cleanup(); },
  };
}
