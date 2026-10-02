CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  idempotency_key uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  task jsonb NOT NULL,
  task_hash text NOT NULL CHECK (task_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted', 'funded', 'submitted', 'disputed', 'paid', 'refunded')),
  chain_snapshot jsonb,
  chain_slot bigint CHECK (chain_slot >= 0),
  chain_checked_at timestamptz,
  chain_verified_at timestamptz,
  chain_status text NOT NULL DEFAULT 'unchecked' CHECK (chain_status IN ('unchecked', 'verified', 'not_found', 'unavailable', 'conflict', 'stale'))
);

CREATE TABLE reports (
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  content jsonb NOT NULL,
  report_hash text NOT NULL CHECK (report_hash ~ '^[0-9a-f]{64}$'),
  stored_at timestamptz NOT NULL DEFAULT now()
);
