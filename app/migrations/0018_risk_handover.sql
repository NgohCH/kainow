-- V1.0 sub-project 2b: a risk handed over from a closing project is created by a change request, so a risk may
-- have that request as its origin. A disposition finalised at an earlier closure no longer blocks a new one.

ALTER TABLE risks ADD COLUMN origin_request_id uuid UNIQUE REFERENCES change_requests (id);
ALTER TABLE risks DROP CONSTRAINT risks_one_origin;
ALTER TABLE risks ADD CONSTRAINT risks_one_origin CHECK (
  (origin_item_id IS NOT NULL)::int + (origin_proposal_id IS NOT NULL)::int + (origin_request_id IS NOT NULL)::int = 1
);

DROP INDEX closure_dispositions_current;
CREATE UNIQUE INDEX closure_dispositions_current ON closure_dispositions (project_id, record_kind, record_id) WHERE replaced_at IS NULL AND NOT final;
