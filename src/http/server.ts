import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { actorByToken, type Actor } from '../domain/authz.ts';
import { JmError, unauthorized } from '../domain/errors.ts';

export interface Ctx {
  db: DatabaseSync;
  req: IncomingMessage;
  res: ServerResponse;
  actor: Actor;
  params: Record<string, string>;
  body: Record<string, unknown>;
  /** 'json' for API clients, 'form' for console submissions. */
  mode: 'json' | 'form';
  url: URL;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  auth: boolean;
}

const MAX_BODY = 256 * 1024; // bound extraction payload sizes

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler, opts: { auth?: boolean } = {}) {
    const keys: string[] = [];
    const regex = new RegExp(
      '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\{(\w+)\\}/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$',
    );
    this.routes.push({ method, pattern, regex, keys, handler, auth: opts.auth !== false });
    return this;
  }
  get(p: string, h: Handler, o?: { auth?: boolean }) { return this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: { auth?: boolean }) { return this.add('POST', p, h, o); }
}

async function readBody(req: IncomingMessage): Promise<{ raw: string; fields: Record<string, unknown>; mode: 'json' | 'form' }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new JmError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = String(req.headers['content-type'] ?? '');
  if (ct.includes('application/x-www-form-urlencoded')) {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(raw)) {
      // coerce digit fields to numbers for handler convenience
      fields[k] = /^-?\d+$/.test(v) && /_(minor|version|ms|count|id)$|^(amount|price|cap|floor|version|port)$/.test(k)
        ? Number(v) : v;
    }
    return { raw, fields, mode: 'form' };
  }
  if (!raw.trim()) return { raw, fields: {}, mode: 'json' };
  try {
    return { raw, fields: JSON.parse(raw) as Record<string, unknown>, mode: 'json' };
  } catch {
    throw new JmError(400, 'INVALID_JSON', 'request body is not valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

function tokenFrom(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'jm_session') return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export interface AppOptions {
  db: DatabaseSync;
  router: Router;
  /** Render an HTML error for console (form) submissions. */
  renderError?: (err: JmError, actor: Actor | null) => string;
}

export function createApp(opts: AppOptions): Server {
  return createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // never log or echo secret-bearing query strings; strip from URL we pass down
      const route = opts.router.routes.find(
        (r) => r.method === req.method && r.regex.test(url.pathname),
      );
      if (!route) {
        if (opts.router.routes.some((r) => r.regex.test(url.pathname)))
          throw new JmError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        throw new JmError(404, 'NOT_FOUND', 'resource not found');
      }
      const { fields, mode } = await readBody(req);
      const params: Record<string, string> = {};
      const m = url.pathname.match(route.regex)!;
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

      let actor: Actor | null = null;
      if (route.auth) actor = actorByToken(opts.db, tokenFrom(req));
      const ctx: Ctx = { db: opts.db, req, res, actor: actor!, params, body: fields, mode, url };
      const out = await route.handler(ctx);
      if (res.writableEnded) return;
      if (ctx.mode === 'form' && req.method === 'POST') {
        // Post/Redirect/Get: console submissions bounce back with operation id.
        const back = String(fields._back ?? url.pathname);
        const opId = (out as { operation?: { id: string } } | undefined)?.operation?.id
          ?? (out as { operation_id?: string } | undefined)?.operation_id ?? '';
        res.writeHead(303, { location: `${back}${back.includes('?') ? '&' : '?'}op=${opId}` });
        res.end();
        return;
      }
      sendJson(res, 200, out ?? {});
    } catch (err) {
      if (res.writableEnded) return;
      const jm = err instanceof JmError ? err : new JmError(500, 'INTERNAL', 'internal error');
      if (!(err instanceof JmError)) console.error('internal error:', err);
      const isForm = String(req.headers['content-type'] ?? '').includes('urlencoded')
        || String(req.headers.accept ?? '').includes('text/html');
      if (isForm && opts.renderError) {
        let actor: Actor | null = null;
        try { actor = actorByToken(opts.db, tokenFrom(req)); } catch { /* anonymous */ }
        sendHtml(res, jm.status, opts.renderError(jm, actor));
      } else {
        sendJson(res, jm.status, { error: { code: jm.code, message: jm.message, ...jm.detail } });
      }
    } finally {
      void started;
    }
  });
}
