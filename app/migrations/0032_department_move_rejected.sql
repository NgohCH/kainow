-- V1.0 sub-project 9 follow-up (Product Owner, 21 November 2026): a department move whose folder move can never succeed
-- is rejected. The project goes back to the department it was moved from, and the transfer keeps the reason (a fixed
-- code; the wording is in department-transfer.ts).
ALTER TABLE project_department_transfers DROP CONSTRAINT project_department_transfers_state_check;
ALTER TABLE project_department_transfers
  ADD CONSTRAINT project_department_transfers_state_check CHECK (state IN ('done', 'moving', 'move_failed', 'rejected'));
ALTER TABLE project_department_transfers
  ADD COLUMN rejected_reason text CHECK (rejected_reason IN ('destination_withdrawn', 'forbidden', 'not_found', 'conflict', 'unsupported')),
  ADD CONSTRAINT project_department_transfers_rejected_reason CHECK ((state = 'rejected') = (rejected_reason IS NOT NULL));
