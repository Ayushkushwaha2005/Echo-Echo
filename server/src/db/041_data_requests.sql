-- ===========================================================================
-- ECHO ECHO - migration 041: a person's requests about their own data
--
-- A deletion request is recorded and handled by a person. Nothing is deleted
-- automatically: order and payment records may have to be kept by law, and how
-- long is a question for a lawyer and an accountant, not a default in code.
-- ===========================================================================
CREATE TABLE data_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id),
  kind         text NOT NULL CHECK (kind IN ('deletion')),
  note         text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','declined')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid REFERENCES app_user(id),
  decision_note text
);
CREATE UNIQUE INDEX data_request_one_open ON data_request (user_id, kind) WHERE status = 'open';
