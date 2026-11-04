CREATE TABLE IF NOT EXISTS eduson_booking.source_intake_records (
  account_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  latest_revision NUMERIC(40,0),
  latest_hash TEXT,
  revision_conflicted BOOLEAN NOT NULL DEFAULT false,
  booking_id TEXT UNIQUE REFERENCES eduson_booking.bookings(id),
  last_applied_revision NUMERIC(40,0),
  last_applied_version INT,
  last_applied_fingerprint TEXT,
  ownership_issue TEXT,
  origin TEXT NOT NULL DEFAULT 'intake' CHECK(origin IN ('intake','migration_v3')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(account_id,record_id)
);
ALTER TABLE eduson_booking.source_intake_records ADD COLUMN IF NOT EXISTS revision_conflicted BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS eduson_booking.source_intake_observations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision NUMERIC(40,0) NOT NULL CHECK(revision>=0),
  input_hash TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('upsert','cancel','delete')),
  payload JSONB NOT NULL,
  raw JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  deliveries INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('pending','applied','unchanged','stale','issue')),
  code TEXT,
  booking_id TEXT REFERENCES eduson_booking.bookings(id),
  attempts INT NOT NULL DEFAULT 0,
  retry_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ,
  UNIQUE(account_id,record_id,revision,input_hash),
  FOREIGN KEY(account_id,record_id) REFERENCES eduson_booking.source_intake_records(account_id,record_id)
);
CREATE INDEX IF NOT EXISTS source_intake_pending ON eduson_booking.source_intake_observations(status,retry_at,received_at);
CREATE TABLE IF NOT EXISTS eduson_booking.source_intake_issues (
  id TEXT PRIMARY KEY,
  observation_id TEXT UNIQUE REFERENCES eduson_booking.source_intake_observations(id),
  account_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  booking_id TEXT REFERENCES eduson_booking.bookings(id),
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS source_intake_open_issues ON eduson_booking.source_intake_issues(resolved_at,created_at);
