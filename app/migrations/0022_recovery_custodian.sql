-- Administrator recovery: the recovery custodian recorded in Kainow (O07). Additions only.
-- The person who can restore Administrator access if every Administrator is locked out, and how to reach them.
-- Changes reuse organisation.updated_by and organisation.updated_at, and are recorded in the audit trail.
ALTER TABLE organisation
  ADD COLUMN recovery_custodian_name    text CHECK (char_length(recovery_custodian_name) <= 200),
  ADD COLUMN recovery_custodian_contact text CHECK (char_length(recovery_custodian_contact) <= 200);
