-- ===========================================================================
-- ECHO ECHO - migration 038: session activity and administrator recovery
-- ===========================================================================

-- Per session, updated at most once a minute. Administrator sessions also use
-- it for the idle timeout.
ALTER TABLE session ADD COLUMN last_seen_at timestamptz;

-- A second address for security alerts. It can receive alerts only: it cannot
-- sign in or reset anything, so setting it widens nothing.
ALTER TABLE admin_credential ADD COLUMN alert_email text
  CHECK (alert_email IS NULL OR alert_email = lower(alert_email));

-- Proof that a password and a recovery code were both presented. It buys one
-- thing: replacing the authenticator. It never opens a session.
CREATE TABLE admin_recovery_ticket (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  ticket_hash text NOT NULL UNIQUE,
  totp_secret_enc text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- sessions.read is new and split out of admins.view. Whoever could read
-- sessions keeps that ability; nobody silently loses or gains anything.
UPDATE admin_account SET permissions = array_append(permissions, 'sessions.read')
 WHERE permissions IS NOT NULL AND 'admins.view' = ANY(permissions) AND NOT 'sessions.read' = ANY(permissions);

-- reports.export is new too: whoever could read orders could export them.
UPDATE admin_account SET permissions = array_append(permissions, 'reports.export')
 WHERE permissions IS NOT NULL AND 'orders.view' = ANY(permissions) AND NOT 'reports.export' = ANY(permissions);
