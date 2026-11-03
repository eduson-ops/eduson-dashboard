CREATE SCHEMA IF NOT EXISTS eduson_booking;

CREATE TABLE IF NOT EXISTS eduson_booking.users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('call_center','confirmation','sales','admin')),
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  age_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eduson_booking.schedules (
  manager_id TEXT NOT NULL REFERENCES eduson_booking.users(id),
  date DATE NOT NULL,
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  reserve_capacity INT NOT NULL DEFAULT 1 CHECK (reserve_capacity IN (0,1)),
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(manager_id,date)
);

CREATE TABLE IF NOT EXISTS eduson_booking.bookings (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  time TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  student_name TEXT NOT NULL,
  parent_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  crm_url TEXT NOT NULL DEFAULT '',
  age INT NOT NULL CHECK (age BETWEEN 1 AND 18),
  has_pc BOOLEAN NOT NULL,
  parent_present BOOLEAN NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  confirmation_status TEXT NOT NULL DEFAULT 'pending' CHECK (confirmation_status IN ('pending','confirmed')),
  confirmation_due_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  assigned_to TEXT REFERENCES eduson_booking.users(id),
  assignment_kind TEXT CHECK (assignment_kind IN ('primary','reserve')),
  state TEXT NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','in_progress','completed','cancelled')),
  cancel_reason TEXT,
  cancel_source TEXT,
  cancelled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INT NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at),
  CHECK ((assigned_to IS NULL) = (assignment_kind IS NULL)),
  UNIQUE(created_by,idempotency_key)
);
CREATE INDEX IF NOT EXISTS bookings_date ON eduson_booking.bookings(date);
CREATE INDEX IF NOT EXISTS bookings_assigned ON eduson_booking.bookings(assigned_to,starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_unique_assignment ON eduson_booking.bookings(assigned_to,starts_at,assignment_kind) WHERE state <> 'cancelled' AND assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS eduson_booking.reports (
  booking_id TEXT PRIMARY KEY REFERENCES eduson_booking.bookings(id),
  payload JSONB NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eduson_booking.audit_events (
  id TEXT PRIMARY KEY,
  booking_id TEXT,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_booking ON eduson_booking.audit_events(booking_id,created_at);

CREATE TABLE IF NOT EXISTS eduson_booking.sync_jobs (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES eduson_booking.bookings(id),
  kind TEXT NOT NULL CHECK (kind IN ('booking','report','cancel')),
  version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','error')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(booking_id,kind,version)
);
CREATE INDEX IF NOT EXISTS sync_jobs_status ON eduson_booking.sync_jobs(status,created_at);

CREATE TABLE IF NOT EXISTS eduson_booking.schema_migrations (
  version INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Version 1 also upgrades existing local databases from the initial 3–18 check.
-- The wider range preserves every existing row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eduson_booking.schema_migrations WHERE version=1) THEN
    ALTER TABLE eduson_booking.bookings DROP CONSTRAINT IF EXISTS bookings_age_check;
    ALTER TABLE eduson_booking.bookings ADD CONSTRAINT bookings_age_check CHECK (age BETWEEN 1 AND 18);
    INSERT INTO eduson_booking.schema_migrations(version) VALUES (1);
  END IF;
END $$;

-- Archived source records remain facts without consuming the published calendar.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eduson_booking.schema_migrations WHERE version=3) THEN
    ALTER TABLE eduson_booking.bookings ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE eduson_booking.bookings ADD COLUMN IF NOT EXISTS history_only BOOLEAN NOT NULL DEFAULT false;
    INSERT INTO eduson_booking.schema_migrations(version) VALUES (3);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS eduson_booking.sheet_projections (
  key TEXT PRIMARY KEY,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','error')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  previous_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eduson_booking.schema_migrations WHERE version=2) THEN
    ALTER TABLE eduson_booking.bookings ALTER COLUMN has_pc DROP NOT NULL;
    ALTER TABLE eduson_booking.bookings ALTER COLUMN parent_present DROP NOT NULL;
    ALTER TABLE eduson_booking.bookings ADD CONSTRAINT bookings_legacy_unknown_booleans CHECK (
      created_by='legacy-import' OR (has_pc IS NOT NULL AND parent_present IS NOT NULL)
    );
    INSERT INTO eduson_booking.schema_migrations(version) VALUES (2);
  END IF;
END $$;

-- Proven historical ownership is evidence, not live calendar occupancy.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eduson_booking.schema_migrations WHERE version=4) THEN
    DROP INDEX IF EXISTS eduson_booking.bookings_unique_assignment;
    CREATE UNIQUE INDEX bookings_unique_assignment ON eduson_booking.bookings(assigned_to,starts_at,assignment_kind)
      WHERE state <> 'cancelled' AND assigned_to IS NOT NULL AND history_only=false;
    INSERT INTO eduson_booking.schema_migrations(version) VALUES (4);
  END IF;
END $$;

-- Authoritative recovery keeps overflow visible without claiming unavailable places.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eduson_booking.schema_migrations WHERE version=5) THEN
    ALTER TABLE eduson_booking.bookings ADD COLUMN IF NOT EXISTS capacity_hold BOOLEAN NOT NULL DEFAULT false;
    INSERT INTO eduson_booking.schema_migrations(version) VALUES (5);
  END IF;
END $$;
