-- Administrator recovery links (O07). Additions only.
-- kind: a setup link (the first Administrator) or a recovery link (recover-admin); the email, the setup page and the
-- acceptance audit follow it.
-- prior_role, prior_status: for an account the link reused, its role and status before the link was issued, restored
-- if the link is superseded or found expired; both null when the link created the account.
ALTER TABLE setup_invitations
  ADD COLUMN kind         text NOT NULL DEFAULT 'setup' CHECK (kind IN ('setup', 'recovery')),
  ADD COLUMN prior_role   text,
  ADD COLUMN prior_status text,
  ADD CONSTRAINT setup_invitations_prior_together CHECK ((prior_role IS NULL) = (prior_status IS NULL));
