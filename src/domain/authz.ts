import type { DatabaseSync } from 'node:sqlite';
import { forbidden, notFound, unauthorized } from './errors.ts';

export type Role = 'owner' | 'lead' | 'worker' | 'finance' | 'client';

export interface Actor {
  id: string;
  tenant_id: string;
  role: Role;
  client_id: string | null;
  display_name: string;
}

export function actorByToken(db: DatabaseSync, tok: string | undefined): Actor {
  if (!tok) throw unauthorized();
  const row = db.prepare(
    'SELECT id, tenant_id, role, client_id, display_name FROM actors WHERE token = ?',
  ).get(tok) as Actor | undefined;
  if (!row) throw unauthorized('unknown credentials');
  return row;
}

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) {
    throw forbidden(`role ${actor.role} cannot perform this action`);
  }
}

/** Tenant-scoped job lookup. Returns undefined detail for outsiders (404). */
export function jobFor(db: DatabaseSync, actor: Actor, jobId: string) {
  const job = db.prepare(
    'SELECT id, tenant_id, client_id, title, currency, status, created_by, created_at FROM jobs WHERE id = ?',
  ).get(jobId) as { id: string; tenant_id: string; client_id: string } | undefined;
  if (!job || job.tenant_id !== actor.tenant_id) throw notFound();
  // clients only ever see jobs bound to their own client_id
  if (actor.role === 'client' && job.client_id !== actor.client_id) throw notFound();
  return job;
}
