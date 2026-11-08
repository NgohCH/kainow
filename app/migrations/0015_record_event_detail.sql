-- What a record change altered besides its status (for risks: responsible person, review date, mitigation),
-- as { field: { from, to } }. Kept with the history row, so earlier values stay traceable.
ALTER TABLE record_events ADD COLUMN detail jsonb;
