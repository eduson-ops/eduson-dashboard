CREATE TABLE IF NOT EXISTS eduson_booking.booking_confirmations (
  booking_id TEXT PRIMARY KEY REFERENCES eduson_booking.bookings(id),
  actor_id TEXT NOT NULL REFERENCES eduson_booking.users(id),
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'booking',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS eduson_booking.compensation_events (
  booking_id TEXT NOT NULL REFERENCES eduson_booking.bookings(id),
  manager_id TEXT NOT NULL REFERENCES eduson_booking.users(id),
  kind TEXT NOT NULL CHECK (kind IN ('confirmation','attendance')),
  amount INT NOT NULL CHECK (amount>=0),
  event_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'booking',
  PRIMARY KEY(booking_id,kind)
);
CREATE INDEX IF NOT EXISTS compensation_manager_period ON eduson_booking.compensation_events(manager_id,event_at);
