CREATE TABLE IF NOT EXISTS eduson_booking.slack_notification_state (
  key TEXT PRIMARY KEY,
  activation_at TIMESTAMPTZ NOT NULL,
  initialized_at TIMESTAMPTZ NOT NULL,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS eduson_booking.slack_notification_marks (
  source_key TEXT PRIMARY KEY,
  marked_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS eduson_booking.slack_notification_jobs (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  logical_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('assignment','released','report','hour')),
  booking_id TEXT REFERENCES eduson_booking.bookings(id),
  manager_id TEXT REFERENCES eduson_booking.users(id),
  source_version INT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','error','uncertain','blocked_mapping','cancelled')),
  attempts INT NOT NULL DEFAULT 0 CHECK(attempts>=0),
  due_at TIMESTAMPTZ NOT NULL,
  retry_at TIMESTAMPTZ NOT NULL,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  send_operation TEXT CHECK(send_operation IN ('post','update')),
  send_started_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS slack_notification_jobs_due ON eduson_booking.slack_notification_jobs(status,retry_at,due_at);
CREATE TABLE IF NOT EXISTS eduson_booking.slack_notification_messages (
  logical_key TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts TEXT,
  status TEXT NOT NULL CHECK(status IN ('posting','known','uncertain')),
  payload_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS eduson_booking.slack_notification_destinations (
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(team_id,slack_user_id)
);
CREATE TABLE IF NOT EXISTS eduson_booking.slack_notification_limits (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  next_allowed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(team_id,channel_id)
);
CREATE TABLE IF NOT EXISTS eduson_booking.slack_notification_method_limits (
  team_id TEXT NOT NULL,
  method TEXT NOT NULL,
  next_allowed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(team_id,method)
);
