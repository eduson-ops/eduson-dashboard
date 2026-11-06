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

CREATE TABLE IF NOT EXISTS eduson_booking.amocrm_stage_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  booking_id TEXT NOT NULL REFERENCES eduson_booking.bookings(id),
  event TEXT NOT NULL CHECK (event IN ('booking.created','booking.confirmed','booking.cancelled','booking.completed','booking.paid')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','error')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS amocrm_stage_jobs_status ON eduson_booking.amocrm_stage_jobs(status,created_at);

CREATE TABLE IF NOT EXISTS eduson_booking.confirmation_history_issues (
  id TEXT PRIMARY KEY,
  sheet_row INT NOT NULL CHECK (sheet_row>1),
  fingerprint TEXT NOT NULL,
  code TEXT NOT NULL,
  crm_url TEXT NOT NULL DEFAULT '',
  slot_time TEXT NOT NULL DEFAULT '',
  confirmed_at TIMESTAMPTZ,
  manager_name TEXT NOT NULL DEFAULT '',
  booking_id TEXT REFERENCES eduson_booking.bookings(id),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  attempts INT NOT NULL DEFAULT 1 CHECK (attempts>=1),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(sheet_row,fingerprint)
);
CREATE INDEX IF NOT EXISTS confirmation_history_issues_status ON eduson_booking.confirmation_history_issues(status,updated_at DESC);
