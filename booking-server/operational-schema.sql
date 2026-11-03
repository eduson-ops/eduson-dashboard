CREATE TABLE IF NOT EXISTS eduson_booking.payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES eduson_booking.bookings(id),
  manager_id TEXT NOT NULL REFERENCES eduson_booking.users(id),
  created_by TEXT NOT NULL REFERENCES eduson_booking.users(id),
  idempotency_key TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  version INT NOT NULL DEFAULT 1 CHECK (version=1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(created_by,idempotency_key)
);
CREATE INDEX IF NOT EXISTS payments_manager ON eduson_booking.payments(manager_id,created_at);

CREATE TABLE IF NOT EXISTS eduson_booking.operation_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('confirmation','payment','enrollment')),
  entity_id TEXT NOT NULL,
  version INT NOT NULL CHECK (version>0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','error')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts>=0),
  last_error TEXT,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL)),
  UNIQUE(kind,entity_id,version)
);
CREATE INDEX IF NOT EXISTS operation_jobs_status ON eduson_booking.operation_jobs(status,created_at);
