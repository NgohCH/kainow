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
| 4 | `recovery` | Nominate the recovery custodian and test the recovery procedure | Confirm |
| 5 | `mailbox` | Set up the Microsoft 365 sender mailbox and its permissions (INSTALL.md), with an auto-reply saying it is not monitored | Confirm |
| 6 | `test_email` | Send a test email and check that it arrived | Confirm. The button is enabled only after a test email has reached "sent". |
| 7 | `calendar` | Set the working weekdays and this year's holidays | Confirm |
| 8 | `backups` | Configure daily encrypted backups and complete a test restore | Confirm |
| 9 | `department` | Create a real department | Auto, when a department exists |
| 10 | `users` | Admit real users | Auto, when at least one account that is not an Enterprise Administrator is Active |
| 11 | `project` | Launch the first real project | Auto, when any project has reached Active |

Each step shows a one-line explanation and a link to the page where the work is done.

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
  - only Active Enterprise Administrators can tick, and others get a 404.
- **Web:** the banner count, the step states, and the closed view.

## 8. Out of scope

- Deleting data from an existing database. Go-live always uses a new database.
- Rewriting the git history that holds the organisation's domain. That is a developer step before go-live, tracked separately.
- AI provider keys and spending caps. They are added to the checklist when sub-project 6 is built.
- Reopening a closed checklist.
