# V1.0 go-live checklist and go-live database — design

**Date:** 11 November 2026
**Status:** Approved in conversation by the Product Owner on 11 November 2026; this document records that design.
**Builds on:** sub-project 3, reminders and email (PR #11, branch `v1/reminders`). Branch `v1/golive`. Part of sub-project 10 (operations).
**Authority:** D71 (organisation registration at onboarding, one-time setup invitation), O07 (multiple Administrators, recovery custodian verified before go-live), A07 (daily encrypted backups, test restore before go-live), Q06 (approved email sender), sub-project 3 spec §4.8 and §7.1, and the Product Owner's decisions below.

## 1. Purpose

Kainow goes live on a new, empty database holding no real or test records. The Enterprise Administrator is then walked through every step needed before real people use it, and each step is recorded as done. The checklist closes itself once real people are working in a real project.

## 2. Decisions taken with the Product Owner

| Question | Decision |
|---|---|
| History at go-live | Nothing dated before go-live produces a notice. Go-live starts from a new, empty database, so no earlier records exist. |
| Form of the go-live steps | An Administrator-only checklist page, not a Kainow project. A project would need roles and authorised due dates that one Administrator cannot legitimately hold. |
| Starting data | Empty, apart from the schema, the checklist and the one-time setup invitation for the first real Enterprise Administrator. No dummy organisation, users or projects. |
| Steps and closing rule | The 11 steps in §4. The checklist closes when steps 9, 10 and 11 are done. |

## 3. The go-live database

A new command, `npm run golive-init -- <email> "<display name>"`, prepares a go-live database:

1. It refuses unless the database named by `DATABASE_URL` is empty. Empty means no `users` rows and no `projects` rows, either before or after migrations. It never deletes anything. Development and test databases, and the old backup dump file in the repository root, are not carried over. Removing them is a manual step outside Kainow.
2. It applies all migrations.
3. It sets **Notices start from** to the current time. The value is the new `notification_settings.notices_from` (timestamptz). The sweep then ignores every trigger whose fire time is earlier; such triggers are neither fired nor recorded (spec §4.8 of sub-project 3, as amended here).
4. It issues the one-time setup invitation to the named person, exactly as `npm run setup-invite` does (D71).
5. It prints what it did and the next step: "Open the link in the email to start the go-live checklist."

`notices_from` is shown read-only to the Administrator under Notifications and email, as "Notices start from <date, time> (UTC+8)". It is null on databases not made by `golive-init`, in which case no cutoff applies.

## 4. The checklist

The steps are seeded by migration in this order. A step is ticked either automatically or by confirmation:

- **Auto:** Kainow sets the tick when it sees the result.
- **Confirm:** the Administrator ticks it.

Every tick records who ticked it and when. An automatic tick records "Kainow" and the time it was seen.

| # | Key | Step (shown text) | Ticked by |
|---|---|---|---|
| 1 | `organisation` | Register your organisation: its name and email domains | Auto, when the organisation is registered (D71) |
| 2 | `logos` | Upload your organisation's logos (optional) | Auto, when a logo is uploaded; or Confirm as "Skipped" |
| 3 | `second_admin` | Appoint a second Enterprise Administrator | Auto, when there are 2 or more Active Enterprise Administrators |
| 4 | `recovery` | Nominate the recovery custodian and test the recovery procedure | Confirm. Refused until both recovery custodian fields are recorded (§9). |
| 5 | `mailbox` | Set up the Microsoft 365 sender mailbox and its permissions (INSTALL.md), with an auto-reply saying it is not monitored | Confirm |
| 6 | `test_email` | Send a test email and check that it arrived | Confirm. The button is enabled only after a test email has reached "sent". |
| 7 | `calendar` | Set the working weekdays and this year's holidays | Confirm |
| 8 | `backups` | Configure daily encrypted backups and complete a test restore | Confirm |
| 9 | `department` | Create a real department | Auto, when a department exists |
| 10 | `users` | Admit real users | Auto, when at least one account that is not an Enterprise Administrator is Active |
| 11 | `project` | Launch the first real project | Auto, when any project has reached Active |

Each step shows a one-line explanation and a link to the page where the work is done. Step 4's explanation is "Record the custodian on the Organisation page, then test recovery on the server with recover-admin --dry-run." and its link is the Organisation page (`#/organisation`). Step 8 links to the INSTALL.md section "Back up".

Rules:

- **Who:** the checklist is visible and editable only by Active Enterprise Administrators. Everyone else gets a 404.
- **Undo:** a Confirm step can be marked not done again, and both actions are recorded. Automatic steps are never unticked.
- **Note:** an optional note of up to 200 characters is allowed on a Confirm tick, for example "Restore tested on 3 Dec".
- **History:** every tick, untick and close is recorded in an append-only history (who, when, step, action, note).
- **Closing:** the checklist **closes** as soon as steps 9, 10 and 11 are done. The close time is recorded. Steps not done at that moment are listed under "Not done at close", and they cannot be ticked afterwards. The page becomes a read-only record.
- **When the automatic checks run:** each time the checklist page is opened, and each time the worker's sweep runs. Both use the same function, so the result is always the same.

## 5. Screens

- **Banner.** While the checklist is open, an Administrator's My Projects page shows a banner: "Go-live: <n> of 11 steps done", with a link.
- **The page** is `#/go-live`. It has the heading "Go-live checklist" and lists the steps in order. Each step shows its number, text, explanation and link. A done step shows "Done by <name> on <date>" ("Kainow" for automatic ticks), and a Confirm step adds Mark done / Mark not done and its note. The closing rule is shown above the list. When closed, the page reads "Closed on <date>" followed by the "Not done at close" list.
- **Accessibility.** The steps are an ordered list. A step's state is given in text, never by colour alone. Status changes are announced in a polite live region. The page works by keyboard and at phone width.

## 6. Data

Migration `0021_golive.sql`, additions only:

- `notification_settings.notices_from timestamptz NULL`.
- `golive_steps`: `key` (primary key), `position`, `ticked_by` (null = Kainow), `ticked_at`, `note`, `skipped`. Seeded with the 11 keys.
- `golive_checklist`: a single row holding `closed_at`.
- `golive_events`: append-only (step key or null, action `ticked | unticked | closed`, actor, note, at).

## 7. Testing

- **`golive-init`:**
  - refuses a database holding users or projects;
  - on an empty database it migrates, sets `notices_from`, and issues the setup invitation;
  - it deletes nothing.
- **Sweep:** a trigger due before `notices_from` is neither recorded nor fired; one due after it fires normally.
- **Automatic ticks:** each automatic step ticks when its condition becomes true. The "users" step does not count Administrators. The "project" step needs a project in the Active state.
- **Closing:** the checklist closes when 9, 10 and 11 are done, with the open steps listed. Ticking is refused after closing.
- **Confirm steps:**
  - tick, untick, notes and skip are recorded in the history;
  - the test-email step is refused until a test email has reached "sent";
  - the recovery step is refused until both recovery custodian fields are recorded (409 "Record the recovery custodian on the Organisation page first."), and its Mark done waits the same way as the test-email step's;
  - only Active Enterprise Administrators can tick, and others get a 404.
- **Web:** the banner count, the step states, and the closed view.

## 8. Out of scope

- Deleting data from an existing database. Go-live always uses a new database.
- Rewriting the git history that holds the organisation's domain. That is a developer step before go-live, tracked separately.
- AI provider keys and spending caps. They are added to the checklist when sub-project 6 is built.
- Reopening a closed checklist.

## 9. Administrator recovery

Approved by the Product Owner on 11 November 2026. Authority: O07, Permission Matrix §2, C13.

**Decision.** Recovery is for when no Administrator can sign in. The everyday safeguard is a second Administrator (step 3): if one loses mailbox access, the other disables that account. There is no public self-service promotion route. Because the last Active Administrator can never be disabled from the People page, "no Active Administrator" does not arise on its own; so, by the Product Owner's decision of 11 November 2026 (option a), `recover-admin` first disables every still-Active Enterprise Administrator, when the custodian asks for it with `--disable-active-administrators`, and then issues the link.

**Custodian recorded in Kainow.** Migration `0022_recovery_custodian.sql` (additions only) adds `organisation.recovery_custodian_name` and `organisation.recovery_custodian_contact` (text, null, each at most 200 characters); changes reuse `updated_by` and `updated_at`. `GET` and `PUT /organisation/recovery-custodian` `{ name, contact }` are for Active Enterprise Administrators only, guarded like the other organisation settings. On `PUT` both fields are required and trimmed non-empty (400 "Give the custodian's name and how to reach them.") and each is at most 200 characters (400). Every change writes the audit event `organisation.recovery_custodian_changed` with the old and new values. The Organisation page has a "Recovery custodian" section showing the current values, an edit form and the line "The person who can restore Administrator access if every Administrator is locked out. See INSTALL.md: Recovery custodian."

**The `recover-admin` command.** `npm run recover-admin -- <email> "<name>" --reason "<why>" [--disable-active-administrators] [--dry-run]` (`app/src/golive/recover-admin.ts`, `recover-admin-cli.ts`). Checks, in order, each with no change on refusal:

1. a non-blank reason, else "Give a reason with --reason "<why>".";
2. the organisation is registered, else "Kainow is not set up yet; use golive-init or setup-invite instead.";
3. no Active Enterprise Administrator exists, or `--disable-active-administrators` is given, else "An Administrator is still active; recovery is only for when none is. If no Administrator can sign in, add --disable-active-administrators to disable them first.";
4. the email's domain is a current eligible domain, else "That email is not on an eligible domain.";
5. the recipient is not one of the Administrators being disabled, else "The recovery link cannot go to an Administrator who is being disabled.";
6. an address with no account has a display name, else "A display name of 1 to 200 characters is required for a new person.".

On success, in one transaction under the `kainow.setup` advisory lock, it disables each still-Active Enterprise Administrator through the same code as the People page (`app/src/users/disable.ts`, shared with `UsersService.disable`; only the last-Administrator guard is bypassed): sessions revoked, unused codes consumed, current memberships placed On Hold with hold alerts queued to the projects' Project Managers (or Owner and Sponsors), and `user.disabled` audited with actor null and detail `{ heldProjects, by: 'recovery', reason }`. Each disabled Administrator is queued an email (outbox kind `recovery_notice`, to their address with no recipient account and no eligibility scope): subject "Your Kainow Administrator access was disabled", body "Your Kainow Administrator account was disabled on <date, time> (UTC+8) so that Administrator access could be restored. Reason given: <reason>. If you did not expect this, contact your organisation's recovery custodian."; it never carries the recovery link or the recipient's address. It then issues a one-time recovery link (valid 7 days; issuing again supersedes the earlier link) and writes `admin.recovery_issued` (actor: system; detail reason, recipient user id and email, `priorRole`, `priorStatus`, `disabledAdministrators` as user ids). After commit the email worker is nudged and the link is emailed. It prints "These Administrators were disabled first: <name> <email>, ..." when any were, then "Recovery link sent to <email>. It expires on <UTC date time> UTC." and "When they sign in with it, they become an Enterprise Administrator. Their project roles are not restored." If the email fails it prints "The recovery link was recorded, but the email could not be sent: the email service did not accept it. Run the same command again to send a new link." (after the disabled line, if any) and exits non-zero.

**Recovery links.** Migration `0023_recovery_links.sql` (additions only) adds `setup_invitations.kind` (`'setup'` or `'recovery'`, default `'setup'`) and `prior_role` and `prior_status` (null when the link created the account). An existing account is reused (same id) and is not changed before acceptance: an Active account keeps its role and status (and its memberships), a disabled account becomes Invited so it can sign in but keeps its role; its display name is kept unless one is given. Memberships, holds and grants are never touched, so no project access is restored. When the link is superseded by a run for another address, or found expired at the next run, a reused account gets its prior role and status back (only while it is still the Invited account the link left), and an account the link created is disabled; a run for the same address carries the prior state over. A recovery email has the subject "Restore your Kainow Administrator access" and the body "Kainow Administrator access is being restored for you. Open this link and sign in with the code Kainow emails you; you will then be an Enterprise Administrator: <link> The link works once and expires on <date> UTC. If you did not expect this, contact your organisation's recovery custodian." `GET /setup/:token` returns the kind; for a recovery link the page says "You are restoring Administrator access to Kainow. Sign in with the code Kainow emails you." and, once it has expired or been replaced, "This link has expired. Ask your recovery custodian to run recover-admin again."

**Acceptance.** Signing in with an open link sets the role to Enterprise Administrator and the account Active. A recovery link first re-checks that no other Enterprise Administrator is Active; if one is, the sign-in is refused with 409 "This recovery link can no longer be used: an Administrator is active.", the link is superseded and the account put back as above. Acceptance of a recovery link is audited as `admin.recovery_accepted`; a setup link keeps `setup.accepted`.

`--dry-run` runs every check except that check 3 is reported instead of refused. With Active Administrators it first prints "Dry run: these Administrators would be disabled first: <name> <email>, ..."; with the flag it then prints "Dry run: all checks passed; a recovery link would be sent to <email>.", and without it "Would be refused now: an Administrator is active. All other checks passed." and "With --disable-active-administrators, they would be disabled first and a recovery link would be sent to <email>." With no Active Administrator it prints only "Dry run: all checks passed; a recovery link would be sent to <email>.". It changes nothing, sends nothing and writes no audit.

`setup-invite` (and the setup invitation generally) is refused once the organisation is registered: "Kainow is already set up. To restore Administrator access, use recover-admin." Saving the custodian before the organisation row exists is refused with 409 "Set up the organisation first."

**Checklist step 4** links to the Organisation page and can be marked done only once both custodian fields are recorded (§4). **INSTALL.md** "Recovery custodian" gives the procedure: two Administrators first, record the custodian, the dry-run test before go-live, the real recovery with `--disable-active-administrators` when no Administrator can sign in, the npm and Docker Compose forms, what happens to the disabled Administrators (memberships held, alerts sent, re-enabled later on the People page), what recovery does and does not restore, and that every use is in the audit trail.
