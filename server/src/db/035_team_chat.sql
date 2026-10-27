-- ============================================================================
-- ECHO ECHO - migration 035: Team Chat
--
-- Conversations between the people who run ECHO ECHO: administrators and
-- support staff, delivery partners, and cafe owners and staff.
--
--   chat_conversation   a one-to-one or group conversation. `audience` is
--                       which tab it belongs to (staff, partners, cafes);
--                       `vendor_id` ties a cafe conversation to one cafe.
--   chat_member         who may read and write it. Every read and write is
--                       checked against this table on the server; there is
--                       no other way into a conversation.
--   chat_message        plain text. `client_ref` lets a sender retry after a
--                       dropped connection without the message appearing
--                       twice (unique per sender and conversation).
--
-- No attachments in this version. Additive only.
-- ============================================================================

CREATE TABLE chat_conversation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('direct', 'group')),
  audience        text NOT NULL CHECK (audience IN ('staff', 'partners', 'cafes')),
  title           text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 80),
  vendor_id       uuid REFERENCES vendor(id),
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  -- A one-to-one conversation exists once per pair and audience.
  direct_key      text UNIQUE
);
CREATE INDEX chat_conversation_recent ON chat_conversation (last_message_at DESC NULLS LAST);

CREATE TABLE chat_member (
  conversation_id uuid NOT NULL REFERENCES chat_conversation(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  added_by        uuid REFERENCES app_user(id),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  last_read_at    timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX chat_member_user ON chat_member (user_id);

CREATE TABLE chat_message (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES chat_conversation(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES app_user(id),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  client_ref      text CHECK (client_ref IS NULL OR length(client_ref) BETWEEN 8 AND 64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sender_id, client_ref)
);
CREATE INDEX chat_message_conv ON chat_message (conversation_id, id);
