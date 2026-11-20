import { openDb, migrate, nowIso } from './db/connection.ts';
import { token, uuid } from './domain/ids.ts';

/**
 * Seed a labelled demo tenant with one actor per role. Prints the tokens once.
 * Demo tenants are kept separate from pilot records (tenants.kind='demo').
 */
const db = openDb(process.env.JM_DB ?? 'data/jobmargin.db');
migrate(db);

const tenantId = 'demo-agency';
const existing = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
if (!existing) {
  db.prepare('INSERT INTO tenants (id, name, kind, created_at) VALUES (?,?,?,?)')
    .run(tenantId, 'Demo Agency (seeded)', 'demo', nowIso());
  const actors: [string, string, string | null][] = [
    ['owner', 'Ada Owner', null],
    ['lead', 'Lee Lead', null],
    ['worker', 'Wren Worker', null],
    ['finance', 'Fran Finance', null],
    ['client', 'Clio Client', 'client-acme'],
  ];
  for (const [role, name, clientId] of actors) {
    const tok = token();
    db.prepare(`INSERT INTO actors (id, tenant_id, role, client_id, display_name, token, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(uuid(), tenantId, role, clientId, name, tok, nowIso());
    console.log(`${role.padEnd(8)} ${name.padEnd(14)} token: ${tok}`);
  }
  console.log('seeded demo tenant "demo-agency"');
} else {
  console.log('demo tenant already seeded; tokens are not re-printed (re-seed on a fresh DB to rotate)');
}
db.close();
