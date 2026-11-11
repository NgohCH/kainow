-- Onboarding: the organisation this installation serves, its logos, and the one-time setup invitation.

-- At most one row. Created when the name is first saved during onboarding; registered once Finish setup succeeds.
CREATE TABLE organisation (
  id             smallint    PRIMARY KEY CHECK (id = 1),
  name           text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  registered_by  uuid        REFERENCES users (id),
  registered_at  timestamptz,
  updated_by     uuid        REFERENCES users (id),
  updated_at     timestamptz NOT NULL
);

-- A wide and a square logo, each optional. Stored as received; never written to the audit log.
CREATE TABLE organisation_logos (
  shape        text        PRIMARY KEY CHECK (shape IN ('wide', 'square')),
  content      bytea       NOT NULL,
  mime         text        NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  width        integer     NOT NULL CHECK (width > 0),
  height       integer     NOT NULL CHECK (height > 0),
  byte_size    integer     NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  uploaded_by  uuid        NOT NULL REFERENCES users (id),
  uploaded_at  timestamptz NOT NULL
);

-- The one-time invitation that creates the first Enterprise Administrator. One open at a time.
CREATE TABLE setup_invitations (
  id             uuid        PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users (id),
  email          text        NOT NULL,
  token_hash     text        NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  accepted_at    timestamptz,
  superseded_at  timestamptz
);
CREATE UNIQUE INDEX setup_invitations_one_open ON setup_invitations ((true)) WHERE accepted_at IS NULL AND superseded_at IS NULL;
