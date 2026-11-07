-- AI spend cap (MVP decisions R10 and 7 November 2026 updates).
-- Money is stored as whole micro-units (1 MYR = 1,000,000 micro-MYR) so no floating point is used.
-- A price is micro-USD per 1 million tokens (USD 2.00 per million = 2,000,000).
-- An exchange rate is micro-MYR per USD (4.1 = 4,100,000).

-- The approved settings. Exactly one row; nothing is invented, so until an administrator saves
-- it there is no row and every AI request is blocked.
CREATE TABLE ai_spend_settings (
  id                                   smallint PRIMARY KEY CHECK (id = 1),
  model_id                             text    NOT NULL CHECK (btrim(model_id) <> ''),
  input_usd_per_million_micro          bigint  NOT NULL CHECK (input_usd_per_million_micro >= 0),
  cached_input_usd_per_million_micro   bigint  NOT NULL CHECK (cached_input_usd_per_million_micro >= 0),
  output_usd_per_million_micro         bigint  NOT NULL CHECK (output_usd_per_million_micro >= 0),
  myr_per_usd_micro                    bigint  NOT NULL CHECK (myr_per_usd_micro > 0),
  -- NULL (blank) means zero allowance, the same as an explicit 0.
  monthly_limit_micro_myr              bigint  CHECK (monthly_limit_micro_myr >= 0),
  -- 'not_applied' is a deliberate decision that no daily limit is enforced. It is never implied by a blank.
  daily_mode                           text    NOT NULL CHECK (daily_mode IN ('limit', 'not_applied')),
  daily_limit_micro_myr                bigint  CHECK (daily_limit_micro_myr >= 0),
  updated_at                           timestamptz NOT NULL,
  updated_by                           uuid REFERENCES users (id),
  CONSTRAINT ai_spend_daily_limit_only_with_limit_mode CHECK (daily_mode = 'limit' OR daily_limit_micro_myr IS NULL)
);

-- One row per attempt that could cost money. A row is never deleted.
-- amount_micro_myr is what currently counts against the caps:
--   reserved   the conservative estimate, held before the request is sent
--   uncertain  the same estimate, kept in full until the real charge is known (never zero)
--   confirmed  the cost worked out from the usage the provider reported
--   released   0, only when no charge can have happened
CREATE TABLE ai_spend_entries (
  id                                   uuid PRIMARY KEY,
  request_id                           uuid NOT NULL,
  attempt_no                           integer NOT NULL CHECK (attempt_no >= 1),
  created_at                           timestamptz NOT NULL,
  updated_at                           timestamptz NOT NULL,
  status                               text NOT NULL CHECK (status IN ('reserved', 'uncertain', 'confirmed', 'released')),
  purpose                              text NOT NULL CHECK (btrim(purpose) <> ''),
  actor_user_id                        uuid REFERENCES users (id),
  model_id                             text NOT NULL,
  -- Prices in force when the reservation was made. Later changes do not rewrite this request.
  input_usd_per_million_micro          bigint NOT NULL,
  cached_input_usd_per_million_micro   bigint NOT NULL,
  output_usd_per_million_micro         bigint NOT NULL,
  myr_per_usd_micro                    bigint NOT NULL,
  estimate_micro_myr                   bigint NOT NULL CHECK (estimate_micro_myr > 0),
  amount_micro_myr                     bigint NOT NULL CHECK (amount_micro_myr >= 0),
  input_tokens                         bigint CHECK (input_tokens >= 0),
  cached_input_tokens                  bigint CHECK (cached_input_tokens >= 0),
  output_tokens                        bigint CHECK (output_tokens >= 0),
  exceeded_estimate                    boolean NOT NULL DEFAULT false,
  note                                 text,
  CONSTRAINT ai_spend_released_costs_nothing CHECK (status <> 'released' OR amount_micro_myr = 0),
  CONSTRAINT ai_spend_held_amount_is_estimate CHECK (status NOT IN ('reserved', 'uncertain') OR amount_micro_myr = estimate_micro_myr),
  CONSTRAINT ai_spend_request_attempt_key UNIQUE (request_id, attempt_no)
);
CREATE INDEX ai_spend_entries_period_idx ON ai_spend_entries (created_at) WHERE status <> 'released';

CREATE FUNCTION ai_spend_entries_never_removed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_spend_entries rows are never deleted';
END;
$$;

CREATE TRIGGER ai_spend_entries_no_delete
  BEFORE DELETE ON ai_spend_entries
  FOR EACH ROW EXECUTE FUNCTION ai_spend_entries_never_removed();

CREATE TRIGGER ai_spend_entries_no_truncate
  BEFORE TRUNCATE ON ai_spend_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ai_spend_entries_never_removed();
