-- Durable decision log: every mutating operation records actor, scope,
-- decision code and external reference for replayable evidence (NFR-01).
CREATE TABLE operations (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_role     TEXT NOT NULL,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  payload_digest TEXT,
  decision_code  TEXT NOT NULL,
  detail_json    TEXT,
  external_ref   TEXT,
  latency_ms     INTEGER,
  created_at     TEXT NOT NULL
);
CREATE INDEX operations_target ON operations(target_type, target_id);
CREATE INDEX operations_tenant ON operations(tenant_id, created_at);
