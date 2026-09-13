-- ===========================================================================
-- ECHO ECHO - migration 015: granular administrator access
--
-- admin_account is the owner-managed record of one administrator: their
-- lifecycle (invited -> active -> suspended/revoked -> restored) and the
-- explicit list of permissions the owner granted. Roles in user_role remain
-- the ceiling; these permissions narrow within it (auth/permissions.js).
--
-- permissions IS NULL means "the role's default" - used only for accounts
-- that predate this migration or come from PLATFORM_ADMIN_EMAILS. Every
-- account invited from Campus Control gets an explicit list.
-- ===========================================================================

CREATE TABLE admin_account (
  user_id        uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'invited'
                   CHECK (status IN ('invited','active','suspended','revoked')),
  permissions    text[],
  display_name   text,
  invited_by     uuid REFERENCES app_user(id),
  invited_at     timestamptz,
  invite_email_sent_at timestamptz,
  activated_at   timestamptz,
  suspended_at   timestamptz,
  suspended_by   uuid REFERENCES app_user(id),
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES app_user(id),
  status_reason  text,
  permissions_updated_at timestamptz,
  permissions_updated_by uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_account (status);

-- An invitation to someone whose mailbox has not been proven yet. No account
-- is created in advance (app_user_student_email_proven forbids an unproven
-- address). When that mailbox signs in with its email code, the invitation
-- becomes the account's role, admin_account row and one-time passkey invite.
CREATE TABLE admin_invitation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL CHECK (email = lower(email)),
  name         text NOT NULL,
  role         text NOT NULL CHECK (role IN ('platform_admin','support')),
  permissions  text[] NOT NULL,
  invited_by   uuid NOT NULL REFERENCES app_user(id),
  code_hash    text NOT NULL,
  salt         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  email_sent_at timestamptz,
  accepted_at  timestamptz,
  accepted_user_id uuid REFERENCES app_user(id),
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX one_open_admin_invitation ON admin_invitation (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Every sign-in method stamps the session; "last signed in" is read from it.
CREATE INDEX IF NOT EXISTS session_user_issued ON session (user_id, issued_at DESC);

-- The audit log is append-only. The application never updates or deletes a
-- row; the database refuses it outright so a compromised route cannot either.
-- (Retention, if ever needed, is an operator task with the trigger disabled
-- by the database owner - see docs/BACKUP-RECOVERY.md.)
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE INDEX IF NOT EXISTS audit_log_resource ON audit_log (resource_id, at DESC);

-- Every outbound email attempt, so the server can stay inside the email
-- provider's free-tier quota (Resend Free: 100/day, 3,000/month) instead of
-- discovering the limit when a student's code fails to arrive. Never holds
-- the message body or a code.
CREATE TABLE email_send_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,              -- student_code | admin_invite | notification
  outcome      text NOT NULL CHECK (outcome IN ('sent','refused_budget','provider_quota','provider_error')),
  provider_ref text
);
CREATE INDEX ON email_send_log (at DESC);
