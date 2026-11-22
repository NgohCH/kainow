-- Second review (G05, option A): each service records, when it starts, whether it holds the protected key and which one.
-- The go-live checklist closes only once api and worker both hold the same key. Only the key id (a short hash) is kept,
-- never the key.
CREATE TABLE service_key_status (
  service text PRIMARY KEY CHECK (service IN ('api', 'worker')),
  key_id text,
  reported_at timestamptz NOT NULL
);
