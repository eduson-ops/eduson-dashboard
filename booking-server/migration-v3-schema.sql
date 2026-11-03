CREATE TABLE IF NOT EXISTS eduson_booking.migration_v3_runs (
  source_fingerprint TEXT PRIMARY KEY,
  database_fingerprint TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  counts JSONB NOT NULL,
  raw JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS eduson_booking.migration_v3_sources (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES eduson_booking.bookings(id),
  fingerprint TEXT NOT NULL,
  raw JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(source,source_id)
);
CREATE TABLE IF NOT EXISTS eduson_booking.migration_v3_staff (
  source_name TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  manager_id TEXT NOT NULL REFERENCES eduson_booking.users(id),
  directory_active BOOLEAN,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS eduson_booking.migration_v3_schedule_hours (
  manager_id TEXT NOT NULL REFERENCES eduson_booking.users(id),
  date DATE NOT NULL,
  time TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY(manager_id,date,time)
);
