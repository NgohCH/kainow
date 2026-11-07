-- Optional per-person monthly AI limit (configuration C45).
-- Unlike the organisation's monthly limit, this one is optional: 'not_applied' means no per-person limit,
-- which is a deliberate state and not a blank. With 'limit', a blank (NULL) or zero value means that
-- person has no allowance at all, as for every other limit.
ALTER TABLE ai_spend_settings
  ADD COLUMN user_monthly_mode text NOT NULL DEFAULT 'not_applied' CHECK (user_monthly_mode IN ('limit', 'not_applied')),
  ADD COLUMN user_monthly_limit_micro_myr bigint CHECK (user_monthly_limit_micro_myr >= 0),
  ADD CONSTRAINT ai_spend_user_limit_only_with_limit_mode CHECK (user_monthly_mode = 'limit' OR user_monthly_limit_micro_myr IS NULL);

CREATE INDEX ai_spend_entries_actor_idx ON ai_spend_entries (actor_user_id, created_at);
