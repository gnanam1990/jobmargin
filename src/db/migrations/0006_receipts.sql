-- Provider statements/receipts (FR-05). (tenant, provider, provider_ref) is
-- unique so a settled receipt changes net cost exactly once across worker
-- and webhook paths (INV-05).
CREATE TABLE receipts (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  provider_key   TEXT NOT NULL,
  provider_ref   TEXT NOT NULL,
  action_id      TEXT,
  merchant       TEXT NOT NULL,
  asset          TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('settled','exception','unmatched')),
  job_id         TEXT,
  reservation_id TEXT,
  attempt_id     TEXT,
  via            TEXT NOT NULL DEFAULT 'import' CHECK (via IN ('import','webhook')),
  actor_id       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (tenant_id, provider_key, provider_ref)
);
CREATE INDEX receipts_attempt ON receipts(attempt_id);

CREATE TABLE exceptions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN
    ('MERCHANT_MISMATCH','ASSET_MISMATCH','AMOUNT_MISMATCH','UNMATCHED_RECEIPT','SETTLEMENT_REVIEW')),
  detail_json     TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  receipt_id      TEXT,
  job_id          TEXT,
  raised_at       TEXT NOT NULL,
  resolved_by     TEXT,
  resolved_at     TEXT,
  resolution_note TEXT
);
CREATE INDEX exceptions_open ON exceptions(tenant_id, status);
