-- Wrong sign-in codes are counted per account, not per code, so requesting a fresh code
-- does not reset the count (MVP decision R05: 5 attempts, then a 30-minute lockout).
-- The count resets on a successful sign-in or when the lockout starts.
ALTER TABLE users
  ADD COLUMN failed_code_attempts integer NOT NULL DEFAULT 0 CHECK (failed_code_attempts >= 0);
