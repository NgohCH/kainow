# V1.0 sub-project 5: history, logical deletion and credential quarantine — design

**Date:** 16 November 2026
**Status:** Approved by the Product Owner on 16 November 2026, after section-by-section agreement in conversation.
**Builds on:** branch `TheLord/history-deletion-design-c700fd`, cut from the 4b branch at c426984 (4b is PR #14, not yet merged; the plan must be rebased onto `main` once #14 merges). Next migration: `0027_history_deletion.sql`.
**Authority:** Intent Card principles 3, 4 and 7; Consolidated Specification §2 (logical deletion only), §7, §12, D56–D59, D72, D75, O01, O02, O09, O14, Q03, Q04, A08, A11, A15, A16; Discussion, Evidence, Access and History Rules §3, §7–§9, §11, §13; Managed Sources, Credentials, Storage and Recovery Rules §3; Permission Matrix rows 40–41 and 105–111; Configuration Catalogue C14, C62, C69; Remaining Design and Verification Register R07, R08; the 4a design (`2026-11-11-v1-discussion-design.md` §3, §5) and the 4b design (`2026-11-15-v1-ai-assist-design.md` §5.5, §7.3, §14); and the new decisions D79–D83 below.

## 1. Purpose and the why

Kainow never erases anything (Consolidated Specification §2: "Logical deletion only in V1.0"). People still need to take things out of use: a duplicate decision, a task authorised by mistake, notes imported into the wrong project. And a secret sometimes ends up in stored text: a manager pastes a password into imported notes, or someone writes a database login in prose that the detector cannot recognise. O01 says detection is best-effort and asks for quarantine "when discovered after storage".

Sub-project 5 makes deletion, restoring and quarantine complete and safe:

1. **Logical deletion and restoring** for imported sources and authorised records, joining the message deletion that 4a already has. Deleted things leave every ordinary view, count, search, export, email and AI request, and appear only as a line in the project's History.
2. **Inspect Deleted Content**: a recorded tick-box on Audit/Oversight grants that lets its holder read Deleted items, read-only and labelled.
3. **Credential quarantine**: anyone who can read something can report a secret in it; the item is held at once; the original is encrypted apart from the database; every ordinary copy is cleaned to "[credential removed]"; a PM, Owner or Sponsor releases the cleaned version; separately designated security reviewers may open originals only under a 24-hour grant approved by a different Administrator.

Development data does not matter here: go-live starts from an empty database (`golive-init`). The design is for what happens after go-live.

### Goals

- Nothing that is Deleted or held can be read through any ordinary route: views, search, the Ask panel's passages, AI requests, digests, notifications, history previews or direct links.
- After quarantine, the marked text exists nowhere in plain text in the project's registered columns, so it is not in future backups either. Only the encrypted originals hold it. It comes back in a place only when a PM or Deputy dismisses that place as "not the secret", or a security reviewer releases a false alarm.
- Every deletion, restoration, report, cleaning, release, grant and inspection is recorded with actor, time and reason, and none of those records contains the secret or Deleted text.
- Owners and Sponsors can hand record deletion and restoring to the PM (D83), so they do not carry that load across all their projects.

### Non-goals (5)

- Physical deletion of anything, ever. Backup rotation (A07) remains the only expiry, and it is operations work (sub-project 10).
- Managed SharePoint/OneDrive source storage (A13). Sources still live in PostgreSQL; quarantine cleans them there.
- Key rotation and a cloud secret-manager integration. 5 introduces the protected-key file and records a key id per encrypted row so rotation can be added; sub-project 6 reuses the same mechanism for API keys.
- Quarantine across projects. Kainow sweeps the project where the secret was reported; Administrators are told the kind of secret and can ask other projects' managers to look.
- Retention settings by category (D56). Nothing is erased in V1.0, and archiving (the only retention behaviour) already exists from 1b, so there is nothing new to configure.
- Recalling copies already sent: emails and AI provider copies cannot be recalled, and Kainow never implies they were (O01).

### Anti-goals (failure even if it works)

- A secret that survives quarantine in any table, index, email row or AI-material row belonging to the reported item or a confirmed copy.
- Other places holding the same text that the PM and Deputies are not told about.
- A Deleted or held item that someone without the right reaches through search, a link, a passage, a history line or a notification.
- A Deleted record's title appearing in the History of people without Inspect Deleted Content.
- Restoring that silently restarts work: AI runs, emails, reminders, deadlines or withdrawn AI answers.
- Anyone, including an Administrator, reading a quarantined original without a current approved grant they did not approve themselves.

## 2. Decisions taken with the Product Owner

| Question | Decision |
|---|---|
| Can secrets reach storage after go-live? | Yes, two ways: managers' imports were not checked, and the detector only knows well-formed secrets. The import gap is closed (D79); after-storage discovery stays necessary (O01). |
| Who sets quarantine in motion? | Anyone who can read the item reports it; Kainow reports it itself when a job's secret check finds one in stored content. Recommendation accepted. |
| How quarantine works | Hold at once; encrypt the original apart; clean every copy; PM/Owner/Sponsor review the cleaned version and release it; notify Administrators, the author and any named credential holder; list known disclosures; security reviewers open originals under a 24-hour grant from a different Administrator. Recommendation accepted. |
| False alarms | A security reviewer with a current grant may release the original unchanged, with a recorded reason. Otherwise the cleaned version is permanent. (Claude's call; the PO left it open.) |
| Size | One spec, built in two parts: 5a deletion, restoring, Inspect Deleted Content and History; then 5b quarantine. (Claude's call, not objected to.) |
| What a Deleted authorised record leaves behind | It shows only in the project History. It leaves lists, counts and links. |
| Owner/Sponsor workload | They may delegate record deletion and restoring to the PM, per project (D83). PM only, not Deputies; one delegation per project, not a standing one across projects. |
| How to clean copies | Approach A: clean every copy in place, from a registry of every stored text column, in one transaction (§7.4). |
| How far one report reaches | Only the reported item (with its own derived rows: passages, transcript text, quotes, AI-material snapshots of it) is held at once. If the same text appears in other items of the project, the PM and Deputies are alerted with where. (PO, 16 Nov 2026: "secret is not a common thing to be shared".) |
| Copies before the PM acts | The secret is masked in the other places at once, "preventing further damage" (PO, 16 Nov 2026): the marked text is cleaned there immediately while the items stay in view, labelled "Possible credential removed — awaiting check". A PM or Deputy then confirms (the place joins the case and stays cleaned) or dismisses (its original text returns). |
| Marked text found in many places (PO, 18 Nov 2026) | A secret is private and rarely shared, so more than 10 other places in one project means an ordinary word was marked. A person's report or Mark more that finds more than 10 other places is refused: "This text appears in N other places in the project, too common to be a credential. Mark a longer, more exact part." Nothing is held or masked. Kainow's own reports are never refused for this (§7.1). |
| Which kind the report notice names (PO, 18 Nov 2026) | The credential kind the check recognised ("API key", "password"), or "credential" when it recognised none, as built (§7.7). |
| Outputs withdrawn during a hold, after release unchanged (PO, 18 Nov 2026) | They stay withdrawn; people ask the AI again (§7.6). |
| Restoring a summary source (PO, 18 Nov 2026) | The summary its deletion withdrew comes back to the state it had (§4.4). |
| A digest listing a held or Deleted item (PO, 18 Nov 2026) | Only that item drops out; the digest still goes, rebuilt at that moment (§7.2). |
| Change requests pending on a Deleted record (PO, 18 Nov 2026) | They stay pending, hidden with the record, and come back if it is restored. |
| Wording where a deleted source was cited (PO, 18 Nov 2026) | "[Source deleted]", as built. |

### 2.1 New Decision Register entries

Added to Consolidated Specification §14 in this branch.

- **D79 — Secrets refused at import (16 November 2026).** Notes imported, versions added and summaries approved by a PM, Deputy, Owner or Sponsor go through the same credential check as messages (D75): text in which the check finds a suspected secret is refused and not stored, and the person is told only the kind found. Detection remains best-effort; after-storage discovery follows D80–D82.
- **D80 — Reporting and holding a suspected secret (16 November 2026).** Anyone who can currently read a stored item may report a suspected secret in it, marking the secret text, with a reason. Kainow itself reports when a job's secret check finds a secret in stored content. The item, with the rows derived from it, is held at once: hidden from every ordinary view, search, export, email, notification and AI request, with removal of dependent AI outputs as for deletion (D76–D78), queued jobs skipping it and any approved summary built on it hidden. Security quarantine overrides normal sharing. When the same text appears in other items of the project, it is masked there at once (cleaned in place, the items staying in view as "Possible credential removed — awaiting check") and the PM and Deputies are alerted with where it appears (never the text); a PM or Deputy confirms each place (it joins the case and stays cleaned) or dismisses it (its original text returns).
- **D81 — Quarantine, cleaning and release (16 November 2026).** The original text of the item, of the rows derived from it and of any confirmed copy is encrypted with a key kept apart from the database and its backups, and the ordinary copies are cleaned: the marked text and anything the credential check finds become "[credential removed]". This is the only change ever made to a stored version. A PM, Owner or Sponsor in the item's audience reviews the cleaned version, may mark more text, and releases it to its audience; they never see the original. Authorised records stay in view with a "Credential removed — under review" label once cleaned. Administrators, the author and any credential holder the reporter names are notified to revoke or rotate the credential; the notice never contains it. The case lists the disclosures Kainow knows of (AI providers sent to, emails sent) and states that sent copies cannot be recalled.
- **D82 — Security reviewers and quarantined-original grants (16 November 2026).** An Enterprise Administrator designates security reviewers (not themselves). A security reviewer requests access to named held cases with a purpose; an Enterprise Administrator other than the requester approves, for 24 hours by default; extension needs fresh approval. Each opening of an original needs explicit confirmation and is logged. Originals are never exported, emailed or sent to AI. A reviewer with a current grant may release a false alarm: the original returns unchanged, with a recorded reason. If no other Administrator is available, access stays blocked (Q03).
- **D83 — Delegated record deletion and restoring (16 November 2026).** An Owner or Sponsor may delegate deleting and restoring a project's authorised records to its PM, with a recorded reason, revocable by any Owner or Sponsor, ending when the PM changes. One delegation per project; Deputies cannot receive it. The final-state rule still applies. Owners and Sponsors receive an in-app notice when the PM deletes or restores under the delegation.

### 2.2 Open questions from earlier sub-projects this touches

- *4b: a request removed while its AI call runs is still charged*: unchanged; deletion and quarantine use the same hook.
- *4a: flags on minutes drafts built from later-hidden messages*: not settled here. Quarantine does clean minutes drafts (they hold text), but no new flag is added to them.
- *4b: approved summary audience editable through the audience panel*: unchanged.

## 3. Concepts

- **Item**: anything that holds user text and can be deleted or reported: a message, a source (notes, minutes, approved summary), an authorised record (task, decision, question, risk), and for reporting only also a proposal, an AI answer, a report draft, a summary draft, a minutes draft or a feedback note.
- **Deleted**: a state, with actor, time and reason. Content and history are kept. Restoring returns the item to its previous state.
- **Final state** (records): Completed or Cancelled task; Superseded or Withdrawn decision; Resolved or Withdrawn question; Resolved risk, or Accepted with "No further review required".
- **Quarantine case**: one report. It has the marked text (never stored in plain text — see §7.3), the item, the copies found, the encrypted originals, its state (`held` → `cleaned` → `released`, or `released_unchanged`) and its history.
- **Held**: the visible condition of every item in an open case: hidden from ordinary use as in §7.2.
- **Security reviewer**: a person an Administrator has designated; they may request quarantined-original grants and nothing else follows from it.

## 4. Deletion and restoring (5a)

### 4.1 Who may delete what

| Item | Delete | Restore | Project states |
|---|---|---|---|
| Message | Author, PM, Deputy (4a, unchanged) | PM, Deputy (4a, unchanged) | Delete: Draft, Planned, Active. Restore: all. |
| Imported source (notes, minutes, approved summary) | PM, Owner, Sponsor | PM, Owner, Sponsor, after an audience preview | Delete: Draft, Planned, Active. Restore: all (Q04). |
| Authorised record | Owner, Sponsor; or the PM under D83 | Owner, Sponsor; or the PM under D83. The act is the Owner/Sponsor approval Q04 asks for. | Delete: Draft, Planned, Active. Restore: all (Q04). |

Every deletion and restoration needs a reason (1–1,000 characters) and is refused with a plain sentence otherwise. Audit/Oversight holders never delete or restore. A discussion transcript source (`kind = 'discussion'`) is not deleted directly; its messages are.

### 4.2 Deleting a source

- `sources.status` becomes `deleted`, with `deleted_by`, `deleted_at`, `delete_reason` (new columns); a `source_events` row records it.
- In the same transaction: `onMaterialRemoved(db, { sourceIds: [id] }, 'deleted', at)` (private AI outputs built on it disappear, shared ones go to PM/Deputy review; summaries of it are hidden from their wider audience, 4b §7.3). Deleting an approved **summary** source also withdraws its summary (`summary_withdrawn` cause).
- Queued work skips it: extraction runs, analysis runs and AI requests recheck at start (A11) and end `blocked` with "source deleted", without an AI call or charge. The builder verifies each runner's start check covers `status = 'deleted'` and adds a test per runner.
- Proposals (pending or authorised) whose evidence is a version of the source show **"Source deleted — review"**, worked out when shown as 4a does for messages. Nothing changes automatically; restoring clears the flag.
- Search (`search_documents` view and the passage search) already filters deleted sources for some kinds; the builder makes every branch filter them and adds a leak test for each.

### 4.3 Deleting an authorised record

- Allowed only from a final state (§3). The refusal names the state needed: "Cancel this task first" and so on. Deletion is not a way round cancellation, withdrawal or resolution (O14).
- Deleting a task deletes its subtasks with it; every subtask must also be in a final state. A subtask may be deleted on its own. Subtasks deleted with their parent record `deleted_with` = the parent's id; restoring the parent restores exactly those, while subtasks deleted on their own stay Deleted. A subtask cannot be restored while its parent is Deleted *(Claude's call)*.
- Records have no audience of their own: a record is readable by every participant and by grant holders within scope. That is "its audience" wherever this spec refers to one (restore preview, quarantine review) *(Claude's call)*.
- New columns on `tasks`, `decisions`, `questions`, `risks`: `deleted_at`, `deleted_by`, `delete_reason` (status values are unchanged, so restoring returns the earlier state exactly). Events go to `task_events` / `record_events` with kinds `deleted` and `restored`.
- A Deleted record leaves: work lists, project and personal dashboards, progress counts (it is excluded from both numerator and denominator), search, the Ask panel's record material, digests and emails, review flags lists, and links from other records. A link from a live record to a Deleted one reads "a deleted record". Its answers (questions) go with it.
- `onMaterialRemoved` gains a record form: AI answers and drafts whose `ai_request_material` holds a snapshot of the record are treated as removed material (`record_deleted`), as for messages. The builder extends the hook rather than adding a second one.

### 4.4 Restoring

- Every restore shows a **preview of who will be able to see it again**: the current audience (current memberships, holds, grants and audience rules applied), as names. Confirming needs a reason.
- The item returns to its earlier state with its history. Nothing restarts: no analysis or extraction, no AI request, no email or notification beyond the D83 notice, no reminder or deadline change, no invitation. Withdrawn AI answers stay withdrawn; a summary hidden because its original source was deleted stays hidden until PM/Owner/Sponsor confirm it (4b §7.3). Restoring a **summary source** brings back the summary its deletion withdrew, in the state it had before (PO, 18 Nov 2026), unless something else has happened to the summary since; this is recorded as `summary_restored`, and the restore preview names the summary's readers. Answers built on it that were withdrawn meanwhile stay withdrawn.
- A restored source is again eligible for future processing, but only when a person starts it.
- An item in an open quarantine case cannot be restored or deleted until the case is released (§7). A released item can be deleted and restored normally; its cleaned text is what returns.

### 4.5 Delegation (D83)

- New table `record_deletion_delegations` shaped like `closure_delegations` (project, PM user, delegated_by, reason, at, revoked_by, revoked_at, revoke_reason; one open row per project). It ends automatically when the project's PM changes: the PM-transfer code closes it in the same transaction, as it does for closure delegation.
- Set and revoke on the project page by an Owner or Sponsor, with a reason. Shown to all participants as "Record deletion delegated to [PM] by [name]".
- When the PM deletes or restores under it, each Owner and Sponsor gets an in-app notice (title only: "[PM] deleted a task in [project]").

### 4.6 Project History

The project page's History section gains **Deletions and restorations**, visible to every participant and grant holder:

> 3 Dec 2026 — A task was deleted by Aisyah Rahman — "Duplicate of an earlier task"
> 5 Dec 2026 — A note was restored by Daniel Tan — "Imported into the wrong project; it belongs here after all"

The line shows the kind, actor, time and reason, but never the title or text, in case the item should never have been written (Claude's call). People with Inspect Deleted Content also see the title and can open the item. Message deletions keep their 4a tombstone in the thread ("Deleted by [name]: [reason]") and also appear in this list. Quarantine cases appear as "A suspected credential was reported in a [kind]" without the reporter's name to ordinary viewers (the reporter is visible to PM/Owner/Sponsor and Administrators).

### 4.7 Inspect Deleted Content (O02)

- `access_grants` gains `inspect_deleted boolean NOT NULL DEFAULT false`, chosen on the request and shown on approval ("Includes Inspect Deleted Content"). Existing grants stay false. It can only be set when requesting; changing it needs a new grant.
- While such a grant is Active, its holder sees Deleted items **within the grant's project** in place, read-only, labelled **Deleted — [actor], [date]: [reason]**, plus a **Deleted items** list on the project. Audience rules still apply: the grant does not open Restricted sources the holder could not otherwise read.
- Nothing else changes: no AI over Deleted items (the Ask panel never includes them, even for the holder), no search hits, no export. Quarantined originals are never included; a Deleted item that is also in a quarantine case shows its cleaned text.
- Each opening of a Deleted item by a grant holder is recorded in `audit_events` (`deleted.inspected`, item kind and id, no text) (Claude's call).
- Creators, PMs and Administrators get no Deleted-content access by role (Permission Matrix row 109).

## 5. Refusing secrets at import (D79)

`NotesService.createSource` and `addVersion` call the existing `refuseSecrets` for every import and version, not only for submissions. The same applies to the text of an uploaded file after extraction to text (the check runs on the extracted text). The refusal message names only the kind found. Summary approval already refuses through the 4b leave-out rules, which include credentials; the builder confirms it calls `refuseSecrets` on the approved version and adds it if not.

## 6. Permissions summary (additions)

| Action | Who | Project states |
|---|---|---|
| Delete / restore a source | PM, Owner, Sponsor | Delete: Draft, Planned, Active; restore: all |
| Delete / restore an authorised record | Owner, Sponsor; PM under D83 | Delete: Draft, Planned, Active; restore: all |
| Delegate / revoke record deletion | Owner, Sponsor | All |
| Read Deleted items | Active grant with Inspect Deleted Content | All |
| Report a suspected secret | Anyone who can currently read the item, including grant holders | All (protective) |
| Review and release a cleaned item | PM, Owner, Sponsor in the item's audience | All (protective) |
| Confirm or dismiss possible copies | PM, Deputy | All (protective) |
| See quarantine cases (no content) | Enterprise Administrators | — |
| Designate / undesignate security reviewers | Enterprise Administrator, never themselves | — |
| Request a quarantined-original grant | Designated security reviewer | — |
| Approve / decline / extend such a grant | Enterprise Administrator other than the requester | — |
| Open an original; release unchanged | Holder of a current grant naming that case | — |

New matrix actions: `source.delete`, `source.restore`, `record.delete`, `record.restore`, `record.delegate_deletion`, `secret.report`, `quarantine.release`. Out-of-audience direct requests return 404, as in 4a and 4b. Grant holders gain `secret.report` only.

## 7. Credential quarantine (5b)

### 7.1 Reporting

- **Report a suspected secret** appears on every item a person can read (§3). The person selects the secret text in the item (or pastes it; it must occur in the item's current text), and gives a reason. The marked text must be at least 4 characters, may not be part of the marker or run into a marker already in the item, and may be found in at most 10 other places in the project; more than that is refused as too common to be a credential, and nothing changes (PO, 18 Nov 2026). Kainow's own reports are not limited this way: they are credentials its check recognised.
- **Kainow reports** when a secret check at job start (extraction, analysis, minutes, assist runners) finds a secret in stored content: it opens a case on the item with the detector's matches as the marked text and the reporter shown as "Kainow". The job still ends `blocked` as today. The case opens on the owning item, never on a derived row: a passage or transcript match opens on its source version's source or its message; a record snapshot in `ai_request_material` opens on that record. The author notified is that item's author *(Claude's call)*.
- **Matching** is exact and case-sensitive on the marked string; in `email_outbox.html_body` the HTML-escaped form is matched too. Whitespace is not normalised *(Claude's call)*.
- The marked text is never logged, never written to an event, notification or email, and never returned in an API response after the report.

### 7.2 Holding (same transaction as the report)

- A `quarantine_cases` row is opened and the item and every copy (§7.4) are linked to it. Each item table that can be held (`discussion_messages`, `sources`, `tasks`, `decisions`, `questions`, `risks`, `extraction_items`, `human_proposals`, `ai_answers`, `report_drafts`, `summaries`, `ai_feedback`, `discussion_threads` for meeting minutes drafts) gains `held_case_id uuid`, set and cleared in step with the case, so every view, count, search branch and runner filters a column rather than joining the case tables *(Claude's call)*.
- Held items are hidden exactly as Deleted items are (§4), from everyone except: PM/Owner/Sponsor reviewers in the item's audience (cleaned text only, §7.5), and security reviewers with a current grant (§7.6). Inspect Deleted Content does not show held items.
- `onMaterialRemoved(..., 'quarantined', at)` runs for the item's messages and sources (a new `RemovalReason`; private outputs disappear, shared ones go to review). An approved summary built on it is set to `hidden` (the hook 4b left, `summaries.state = 'hidden'`), overriding its approved audience.
- Queued emails (`email_outbox` rows in `queued` or `retry_wait`) that contain the marked text are cancelled (`status = 'cancelled'`, reason "held: suspected credential"); this is the only content check on emails and runs by the copy sweep. A cancelled **digest** goes again, rebuilt at that moment without the held item and with its copies masked (PO, 18 Nov 2026); the same happens when the dispatcher finds that a task a queued digest lists has since been held or Deleted. Nothing is queued when the project is no longer Active or no open task is left.

### 7.3 Encryption and the protected-key file

- AES-256-GCM, a fresh 96-bit nonce per value, the authentication tag stored with it.
- The key is 32 random bytes in a file outside the database and its backups, path from `KAINOW_PROTECTED_KEY_FILE` (Compose mounts it read-only). Kainow reads it at start and holds it in memory only. `npm run protected-key -- --create <path>` writes a new key file (refusing to overwrite); INSTALL.md tells the Administrator to keep a recovery copy apart from the backups (A15).
- Each encrypted row stores a `key_id` (first 16 hex characters of SHA-256 of the key) so a later rotation can find its rows.
- **Without the key** (file missing or unreadable): reporting still opens the case and holds the item at once; cleaning waits, the case shows "Waiting for the protected key", and the Administrator dashboard shows a persistent warning. Held items stay hidden, including authorised records, until cleaned. When the key appears, a worker job cleans waiting cases in report order.
- The marked text itself is stored only inside the encrypted originals; the case keeps its length and the detector kind (if any).

### 7.4 Cleaning every copy (Approach A)

- **Text registry.** One module lists every table and column that can hold user text (about 25 columns in some 20 tables: `source_versions.text_content` and `original_bytes`, `sources.title`, `message_versions.body`, `discussion_threads.title`, `minutes_drafts.body`, `passages.body`, `extraction_items.text` and `quote`, `extraction_item_edits.text`, `human_proposals.text`, `tasks.title` and `description`, `task_events.detail`, `decisions.statement` and `rationale`, `questions.text`, `question_answers.answer`, `risks.description` and `mitigation`, `change_request_versions.terms`, `ai_answers.question` and `answer_markdown`, `ai_request_material.snapshot`, `report_drafts.title` and `brief`, `report_draft_versions.body`, `summary_versions.body`, `summary_marks.phrase`, `ai_feedback.note`, `notifications.summary`, `email_outbox.subject`, `text_body` and `html_body`, and any others the builder finds). Each entry says how to find the project's rows and whether the column is plain text or JSON.
- **Reasons and event detail are in the registry too.** Free-text reasons and details in project-scoped history tables (`membership_events`, `grant_events`, `discussion_events`, `task_events`, `record_events`, `feedback_events`, `ai_assist_events`, `source_events`, delete reasons, grant purposes, `quarantine_cases.reason` and the like) are swept, because people paste secrets into reasons. Tables with no project scope (`users`, departments, organisation settings, `audit_events`, which never holds text by rule) go on the "holds no user text" list with that reason; reason inputs everywhere also run the credential check and refuse a match *(Claude's call)*.
- **Completeness test.** A test reads every `text`, `varchar` and `jsonb` column from `information_schema` and fails unless each is in the registry or in an explicit "holds no user text" list with a one-line reason. A future migration that adds a text column therefore fails the build until someone decides.
- **Scope of the sweep (PO decision).** At report time the sweep cleans only the **reported item and the rows derived from it**: its versions, its passages, transcript text built from it, proposal quotes taken from it, `ai_request_material` snapshots of it, notifications and queued or sent `email_outbox` rows generated from it, and reasons/details in history rows about it. The same search over the rest of the project's registered columns runs in the same transaction and finds other items holding the marked text.
- **Copies in other items: masked at once, decided by the PM (PO decision).** Every other place found is cleaned in the same transaction, exactly as the sweep below (original encrypted, marked text replaced, offsets mapped, derived rows included), but **not held**: it stays in view, search and work, labelled **"Possible credential removed — awaiting check"**. The PM and every Deputy get an urgent in-app alert: "The text reported as a suspected credential in [kind] also appeared in N other places in [project] and has been masked there", linking to a **Possible copies** list on the case. The list shows kind, title or reference and date for each place; opening one follows normal access rules. The marked text is never shown. For each place a PM or Deputy chooses **Confirm** (it joins the case as a confirmed copy and stays cleaned; released with the case) or **Dismiss — not the secret** (its originals are decrypted back into place as in release-unchanged, §7.6, with the same changed-since-cleaning rule). Each decision is recorded with who and when. Without the protected key, places found are **held** (hidden) instead of masked until the key appears, then masked. The places are stored as row references only (`quarantine_possible_copies`: case, item kind, item id, found_at, decision, decided_by, decided_at), never text, so the list survives restarts.
- **The sweep.** In one transaction, for each item being cleaned: find every registered column value of that item and its derived rows that contains the marked text (and, for the reported item itself, every credential-check match); for each, store the original value encrypted in `quarantine_originals` (case, table, row key, column, ciphertext, nonce, tag, key_id) and write the cleaned value, with every occurrence replaced by `[credential removed]`. JSON values are cleaned string by string.
- **Uploaded originals.** A source version's `original_bytes` (DOCX/PDF) cannot be cleaned; when its text holds the secret, the bytes are encrypted into `quarantine_originals` and set to NULL, and the version shows "Original file withheld — credential removed from text". The check constraint `source_versions_upload_has_original` is relaxed to allow this one case (`quarantined_at IS NOT NULL`).
- **Derived rows are recomputed in place, not string-replaced**, where splitting could have cut the secret. Every offset into a cleaned version (passage start/end, transcript spans, proposal quote locations) is mapped through the replacements; an offset that fell inside a replaced span is widened to cover the whole "[credential removed]" marker; a passage's body is then rewritten as the slice of the cleaned text between its mapped offsets. No passage rows are added, so `UNIQUE (owner_kind, owner_id, ordinal)` and `ai_request_material` links stay valid and no query changes *(Claude's call)*. A proposal whose quote overlapped the secret has its quote cleaned and shows "Quote changed: credential removed — review".
- **What release-unchanged needs**: each `quarantine_originals` row also stores the SHA-256 of the cleaned value it wrote, so a later release can tell whether the row changed since (§7.6).
- **The immutability exception.** Every trigger that blocks UPDATE on these tables allows an UPDATE when the transaction-local setting `kainow.quarantine_write` equals the id of an open case. Only the quarantine module sets it (a test fails if the string appears anywhere else in `src`). The generated `tsvector` columns and trigram indexes update with the row.
- Confirmed copies in other items are released together with the reported item.
- **Audit.** `quarantine_events` (append-only) records `reported`, `held`, `cleaned`, `marked_more`, `released`, `released_unchanged`, `grant_*`, `original_opened`, `notified`, with actor, time, item kind and id, reason, counts (rows cleaned, copies found), and never any text.

### 7.5 Review and release

- A **Held for review** list on the project, for PM, Owner and Sponsor, shows open cases they can review (the item is in their audience). The reviewer sees the cleaned text with each `[credential removed]` highlighted, never the original.
- **Mark more**: the reviewer selects further text in the cleaned version; it is swept and cleaned as in §7.4 (its originals encrypted into the same case).
- **Release**: with a reason, the cleaned item returns to its audience; copies return with it. The case closes as `released`. Restored AI outputs do not come back (4b rule); a hidden summary stays hidden until confirmed.
- Authorised records stay visible during review once cleaned, labelled "Credential removed — under review", so reminders and work continue (Claude's call; while uncleaned for lack of the key they are hidden).
- The reporter and the PM are told when a case is released (in-app).

### 7.6 Security reviewers and grants (Q03)

- `users.security_reviewer boolean` with `security_reviewer_events` (designated/undesignated, by, at, reason). Set by an Enterprise Administrator on the Organisation page; nobody designates themselves.
- **Request**: a security reviewer picks open or closed cases (by case reference, project and item kind, never content), gives a purpose, and asks for a duration (default 24 hours, no maximum other than fresh approval for any extension). `quarantine_grants` rows record purpose, cases, requester, approver, decided at, expiry, decline/revoke reasons.
- **Approve**: any Enterprise Administrator other than the requester. If none is available, the request waits; there is no self-approval or emergency route. Approvers are notified in-app; the notice names the requester and case count only.
- **Open an original**: the holder presses **Reveal original**, confirms "I am viewing a quarantined credential for the stated purpose", and sees the original text of that item with the secret marked. Every reveal is a `quarantine_events` row. No copy, download, export, email or AI action is offered; the page sets no-store caching headers.
- **Release unchanged** (false alarm): the holder, with a reason, restores every original of the case (decrypting `quarantine_originals` back into place under the immutability exception, mapping offsets back). A value that has changed since cleaning (its SHA-256 no longer matches, e.g. a task amended during review) is not overwritten; the case lists it as "changed since cleaning — not restored" *(Claude's call)*. The case closes as `released_unchanged`. The encrypted rows are kept (nothing is deleted). Administrators are notified.
- Grants end at expiry or when revoked by any Administrator; expiry is elapsed time (Q02).

### 7.7 Notifications and known disclosures

- At report time (urgent, in-app and email; security notices do not wait for working days, Q02): all Enterprise Administrators; the author of the item (the message author, source creator, record's proposer or AI requester) if a person; and a credential holder the reporter may name from the organisation's people. Text: "A suspected [kind] was reported in [project] and held. If it is real, revoke or rotate it. Kainow cannot recall copies already sent." It never contains the secret or the item's text.
- **Known disclosures**, worked out at report time and shown on the case to Administrators and security reviewers: AI requests and extraction/analysis runs that sent the item or its passages (date, provider, model), emails sent containing the marked text (date, recipient count), and the item's audience size. Shown as "Known disclosures (copies outside Kainow cannot be recalled)".

## 8. Data model (migration `0027_history_deletion.sql`)

Additions only, apart from the narrow trigger and constraint changes listed. Nothing is physically deleted.

- `sources`: `deleted_by`, `deleted_at`, `delete_reason`; `source_events` (append-only: deleted, restored, with actor, reason, at).
- `tasks`, `decisions`, `questions`, `risks`: `deleted_at`, `deleted_by`, `delete_reason`; `task_events` and `record_events` kinds gain `deleted`, `restored`.
- `record_deletion_delegations` (§4.5).
- `access_grants.inspect_deleted`.
- `users.security_reviewer`, `security_reviewer_events`.
- `quarantine_cases` (id, project_id, item kind and id, reporter (null for Kainow), reason, marked length, detector kinds, credential holder user id, state `held`|`cleaned`|`released`|`released_unchanged`, waiting_for_key, timestamps), `quarantine_items` (case, item kind, id, role `reported`|`copy`), `quarantine_originals` (§7.4, with the cleaned value's SHA-256), `quarantine_possible_copies` (§7.4), `quarantine_events`, `quarantine_grants`, `quarantine_grant_cases`; `held_case_id` on the holdable item tables (§7.2); `deleted_with` on `tasks` (§4.3).
- `source_versions.quarantined_at`; relaxed `source_versions_upload_has_original`.
- Immutability trigger functions on the registered tables gain the `kainow.quarantine_write` exception (§7.4).
- `RemovalReason` gains `quarantined` and `record_deleted`; `ai_assist_events` causes as needed.

## 9. Screens

- **Item menus** gain Delete / Restore (where allowed) and **Report a suspected secret** (everyone who can read).
- **Delete and restore dialogs**: reason box; restore shows "These people will be able to see it again" with names.
- **Project page**: History → Deletions and restorations (§4.6); Record deletion delegation panel for Owners/Sponsors; **Held for review** list for PM/Owner/Sponsor; **Possible copies** on a case for PM/Deputy (tick and confirm, or dismiss); **Deleted items** for grant holders with Inspect Deleted Content.
- **Grant request form**: an "Include Inspect Deleted Content" tick-box with a plain explanation.
- **Organisation page (Administrators)**: Security reviewers; Quarantine cases (no content); Quarantined-original grant requests to approve; the protected-key warning when missing.
- **Security reviewer view**: my grants, request form, case list, Reveal original with confirmation, Release unchanged.
- Labels: "Held — suspected credential, under review"; "[credential removed]" in a distinct style with text equivalent; "Credential removed — under review". WCAG 2.2 AA; every action keyboard operable; the cleaned marker is not conveyed by colour alone.

## 10. Testing and measured aims

- **Unit:** final-state rules; subtask cascade; registry completeness against `information_schema`; sweep cleaning (plain and JSON, repeated occurrences, overlapping matches, offsets shift); encryption round trip and key id; immutability exception refused without the setting; the setting string used only in the quarantine module.
- **HTTP:** every new endpoint allowed and denied for each role, grant, project state and audience; D83 delegation set/revoke/ended by PM change; restore preview names; grant self-approval refused; no independent approver → waiting; reveal without a current grant refused; release unchanged.
- **Worker:** each runner blocks a deleted source and a held item at start without a charge; waiting-for-key cases cleaned when the key appears.
- **Leak tests (mandatory, one per surface):** a Deleted message, source and record, and a held item, never appear in: project lists, dashboards and counts, global search, the Ask panel's passages and record material, a new AI request, digests and queued emails, notifications, History lines (no title), direct links (404), or to a grant holder without Inspect Deleted Content. After quarantine, a search of every registered column of the reported item's rows and derived rows (and of each confirmed copy) for the marked text finds nothing, and the encrypted rows decrypt back to it; every other place holding it is masked at once and stays visible with its label; a dismissed place gets its original back and a confirmed one stays cleaned; the alert, the Possible copies list and every event row never contain the marked text.
- **Review focus for task reviews and the final whole-branch review:** (1) registry completeness, including JSON columns and copies in other items; (2) every runner's start check; (3) offsets and passages after cleaning; (4) the immutability exception cannot be reached from any other code path; (5) the key never appears in logs, errors or responses, and the marked text never appears in events, notifications or emails; (6) restore restarts nothing; (7) Deleted titles absent from History for ordinary viewers.
- **Measured aims on the 4b bench data** (50 projects, 100,000 messages, 440 large sources): report-to-cleaned for a secret in one large source (with its passages) plus the project-wide copy search finding three messages, under 2 s at p95 over 50 reports; confirming three copies under 2 s at p95; Deleted-item filtering adds under 10% to passage search p95 (66 ms today). Reported as found; a miss goes to the PO.

### 10.1 Measured aims as found

**After the fix wave (18 November 2026): all three aims met.** Same tool, same seeds and method as below, on a `kainow_bench` dropped and recreated for the run, with no other connection to the database container.

| Aim | Result | Verdict |
|---|---|---|
| Report-to-cleaned under 2 s at p95 over 50 reports | n=50: p50 409.1 ms, p95 445.5 ms, max 492.6 ms | Met |
| Confirming three copies under 2 s at p95 | n=50: p50 14.9 ms, p95 23.9 ms, max 27.1 ms | Met |
| Passage search p95 within 10% of 66 ms (under 72.6 ms) with the Deleted and held filters | 200 questions: p95 56.5 ms before any report (p50 45.0, max 68.2); 58.6 ms after the 55 reports (p50 44.5, max 65.6) | Met |

What changed (final review I1; exact matching unchanged, no index added): the sweep transaction runs with JIT off (`set_config('jit', 'off', true)`, set with the per-project sweep lock), because the project-wide copy search is one very large statement whose estimated cost passed every JIT threshold, so PostgreSQL spent seconds compiling it before executing it in about 100 ms; and the passages condition of the registry is one row comparison against one list (`(owner_kind, owner_id) IN (... UNION ALL ...)`), so it uses the passages owner index instead of scanning every passage. Back-fill for this run: 104,613 versions, 169,757 passages in 90.0 s.

**First measurement (17 November 2026), kept as history: report-to-cleaned missed.**

Measured with `npm run bench-history` (`app/src/quarantine/bench-cli.ts`) on a freshly created `kainow_bench` database, with no other process using the database container. Hardware: a Windows 11 machine, PostgreSQL 16 in Docker Desktop, Node, application and database on the same machine over loopback.

| Aim | Result | Verdict |
|---|---|---|
| Report-to-cleaned under 2 s at p95 over 50 reports | n=50: p50 9,404 ms, p95 10,462 ms, max 13,208 ms | **Missed** (about 5 times the aim); to the PO |
| Confirming three copies under 2 s at p95 | n=50: p50 15.8 ms, p95 20.8 ms, max 66.4 ms | Met |
| Passage search p95 within 10% of 66 ms (under 72.6 ms) with the Deleted and held filters | 200 questions: p95 58.6 ms before any report (p50 47.7, max 73.4); 48.8 ms after the 55 reports (p50 38.9, max 54.0) | Met |

Method:
- Data: the 4a and 4b seeds (401 users, 50 projects, 2,000 threads, 100,688 messages, 440 notes and minutes sources of 5,000 to 8,000 words, 2,000 records), then the passage back-fill (104,613 versions, 169,757 passages in 93.1 s).
- Passage search: the 4b bench's `findMaterial` measurement, unchanged (40 questions, three kinds of asker over the 38 Active projects, 10 warm-ups not counted), now with the Deleted and held filters in every branch. Run before the reports and again after them.
- Reports: 55 rounds over 34 Active projects (projects 3, 13, 23 and 33 left out), the first 5 not counted. In each round a PM imports a new note through the HTTP app: a seeded note's text (the longest first; 7,614 to 8,008 words, 114 to 222 passages) with a secret unknown to the credential check written in twice. A member then posts the same secret in three discussion messages of the project. Timed: a plain member's `POST /projects/:id/secret-reports` through the real HTTP app (Nest on loopback, signed-in session, anti-forgery token). That request holds the note, encrypts and cleans its version and passages, searches the project's registered columns and masks the three messages, all in one transaction. Each round checks that the case is `cleaned` with three masked places. Then the PM's single `POST /quarantine/cases/:id/copies` confirming the three places is timed.
- The protected key is generated for the run into a temporary file (never printed) and removed afterwards. Percentiles are nearest-rank.
- Where the time goes: on the bench data, `findPlaces` for one project of about 2,000 messages takes 6.6 to 7.0 s on its own (in a rolled-back transaction, with a string found nowhere). Each registered column's project scan alone takes at most 127 ms (`discussion_events.detail`). So most of the report time is the combined project-wide copy search, not the cleaning. The aim is not tuned or weakened here; the PO decides. The final review then found the cause: LLVM JIT compilation of that one statement (about 6.5 s of the 6.6 to 7.0 s; execution alone about 94 ms), plus a passages condition that scanned all 170,000 passages for each cleaned message. Both were fixed in the fix wave (above).

## 11. Documents updated in this branch

- Consolidated Specification §14: D79–D83.
- Permission Matrix: rows for source and record delete/restore (adding D83), delegation, secret reporting, release, security-reviewer designation.
- Configuration Catalogue C62 and C69: the protected-key file, `KAINOW_PROTECTED_KEY_FILE`, waiting-for-key behaviour.
- INSTALL.md: creating the protected key and keeping its recovery copy apart from backups.
- README feature list.

## 12. Left to the builder

- The exact order of tasks within 5a and 5b, and whether the registry lives in one file or beside each module (one completeness test either way).
- Visual layout within §9 and the existing design system.
- The short reference shown for a record in History (its number if it has one, otherwise kind and authorisation date).
- Batch sizes for the sweep on large projects, provided the report-to-hold step stays in one transaction and the aim in §10 is met.

## 13. Outside 5

Physical deletion; managed external source storage (9); key rotation and secret managers (6, 10); API-key storage (6); cross-project sweeps; recalling sent copies; retention settings by category; flags on 4a minutes drafts from later-hidden messages (PO to decide).
