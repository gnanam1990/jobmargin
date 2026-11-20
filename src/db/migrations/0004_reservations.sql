-- Budget reservations (FR-03). A request_key is unique per tenant so a retry
-- returns the stored decision; a changed payload under the same key conflicts.
CREATE TABLE reservations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  request_key     TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL,
  state           TEXT NOT NULL CHECK (state IN
    ('held','dispatched','uncertain','settled','released','confirmed_void','denied')),
  quote_version   INTEGER NOT NULL,
  denial_code     TEXT,
  shortfall_minor INTEGER,
  payload_digest  TEXT NOT NULL,
  expires_at      TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, request_key)
);
CREATE INDEX resv_job_state ON reservations(job_id, state);
CREATE INDEX resv_pending_expiry ON reservations(state, expires_at);
