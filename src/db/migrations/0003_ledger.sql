-- Append-only job journal (FR-02). Entries are immutable; corrections are
-- reversal rows linked to the original entry (reversal_of).
CREATE TABLE ledger_entries (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  kind         TEXT NOT NULL CHECK (kind IN
    ('labor','infra','provider_expense','shared_cost','credit','reversal')),
  amount_minor INTEGER NOT NULL,
  dedupe_key   TEXT,
  reversal_of  INTEGER REFERENCES ledger_entries(seq),
  source       TEXT NOT NULL,
  statement_id TEXT,
  actor_id     TEXT NOT NULL,
  note         TEXT,
  evidence_ref TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX ledger_dedupe
  ON ledger_entries(job_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX ledger_job ON ledger_entries(job_id, seq);

-- Shared cost statements: a source record allocated across jobs.
CREATE TABLE source_statements (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  currency    TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  note        TEXT,
  actor_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (tenant_id, source_ref)
);

CREATE TABLE statement_allocations (
  statement_id TEXT NOT NULL REFERENCES source_statements(id),
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  entry_seq    INTEGER NOT NULL REFERENCES ledger_entries(seq),
  amount_minor INTEGER NOT NULL,
  PRIMARY KEY (statement_id, job_id)
);

-- Lead/finance flag that an expected cost record is missing — makes closes
-- incomplete until resolved against a posted entry.
CREATE TABLE attribution_flags (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id),
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  raised_by        TEXT NOT NULL,
  raised_at        TEXT NOT NULL,
  resolved_by      TEXT,
  resolved_at      TEXT,
  resolution_entry INTEGER REFERENCES ledger_entries(seq)
);
CREATE INDEX flags_job ON attribution_flags(job_id, status);
