-- JobMargin migration 0001: tenants, actors, jobs, immutable quote versions.
-- (schema_migrations itself is created by the migration runner)

CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'agency' CHECK (kind IN ('agency','demo')),
  created_at TEXT NOT NULL
);

-- operator/client roles; client actors are bound to client_id so they can
-- only ever see their own jobs.
CREATE TABLE actors (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  role         TEXT NOT NULL CHECK (role IN ('owner','lead','worker','finance','client')),
  client_id    TEXT,
  display_name TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL
);
CREATE INDEX actors_tenant ON actors(tenant_id);

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  client_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  currency    TEXT NOT NULL CHECK (currency IN ('USD','USDTEST')),
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','delivered','accepted','closed')),
  created_by  TEXT NOT NULL REFERENCES actors(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX jobs_tenant_status ON jobs(tenant_id, status);

-- Immutable quote revisions. At most one 'locked' row per job (partial index).
CREATE TABLE quote_versions (
  job_id           TEXT NOT NULL REFERENCES jobs(id),
  version          INTEGER NOT NULL,
  price_minor      INTEGER NOT NULL CHECK (price_minor >= 0),
  min_margin_minor INTEGER NOT NULL CHECK (min_margin_minor >= 0),
  status           TEXT NOT NULL CHECK (status IN ('draft','locked','superseded')),
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  locked_by        TEXT,
  locked_at        TEXT,
  payload_digest   TEXT,
  PRIMARY KEY (job_id, version)
);
CREATE UNIQUE INDEX quote_one_locked
  ON quote_versions(job_id) WHERE status = 'locked';
