-- Deliveries, customer acceptance and immutable close versions (FR-06).
CREATE TABLE deliveries (
  id           TEXT NOT NULL UNIQUE,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  version      INTEGER NOT NULL,
  artifact_hash TEXT NOT NULL,
  evidence_ref TEXT,
  delivered_by TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (job_id, version)
);

CREATE TABLE acceptances (
  id          TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id),
  job_id      TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);
CREATE INDEX acceptances_job ON acceptances(job_id);

-- Each close snapshots the journal cursor so exported numbers agree with
-- the exact ledger state that produced them (INV-07). Post-close
-- corrections land after the cursor and a later version captures them.
CREATE TABLE close_versions (
  job_id                TEXT NOT NULL,
  version               INTEGER NOT NULL,
  ledger_cursor         INTEGER NOT NULL,
  price_minor           INTEGER NOT NULL,
  credits_minor         INTEGER NOT NULL,
  costs_minor           INTEGER NOT NULL,
  realized_margin_minor INTEGER NOT NULL,
  completeness          TEXT NOT NULL CHECK (completeness IN ('complete','incomplete')),
  open_flag_count       INTEGER NOT NULL,
  closed_by             TEXT NOT NULL,
  closed_at             TEXT NOT NULL,
  PRIMARY KEY (job_id, version)
);
