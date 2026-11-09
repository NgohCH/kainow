# Kainow

**Kainow turns conversations into accountable execution.**

Meetings produce notes. Notes produce good intentions. Weeks later nobody is sure what was decided, who agreed to do what, or by when. Kainow closes that gap: you give it the notes, AI proposes the decisions, actions, open questions and risks it finds, and **people review and approve each one** before it becomes a record anyone relies on. Every proposal points back to the exact words in the notes that support it.

> **Status.** Kainow is being built as a **December 2026 MVP**: one working path from notes to reviewed proposals. The full product described in `docs/` (V1.0) is a design baseline, not something that has been built or accepted. This README says clearly which is which. The MVP has been installed with Docker on one Windows computer, and the AI step has been checked against the real model only with synthetic notes. See [Where things stand](#where-things-stand).

## The idea

```
  Meeting notes  ──►  AI proposes  ──►  People review  ──►  Accountable record
  (paste or file)     decisions,        approve / reject     who, what, by when,
                      actions,          each one, bound      with the source
                      questions,        to the exact          quote kept as
                      risks, each       version they          evidence
                      with a quote      looked at
```

Four rules shape everything:

1. **AI proposes; people decide.** An AI proposal is never an approved commitment. Nothing is created, assigned or sent on the AI's say-so.
2. **Every proposal shows its evidence.** Each one carries a quote from the notes. Kainow finds that quote in the stored text and highlights it. A quote that is not in the notes is shown with a warning and **cannot be approved**.
3. **No invented owners or dates.** If the notes do not say who or when, the field stays empty.
4. **History is kept.** Notes are stored as immutable versions, edits are recorded beside the original, and every change is written to an append-only audit trail.

## What the MVP does today

| Area | What works |
| --- | --- |
| **Sign-in** | Passwordless. A one-time code is emailed (10 minutes, 5 attempts, 30-minute lockout) and starts a 12-hour session. Anti-forgery protection on every change. |
| **People** | Enterprise Administrators are added, disabled and enabled again from a screen. The last active administrator cannot be disabled. Administrators keep the list of departments and of eligible email domains. |
| **Projects and roles** (V1.0 sub-project 1) | Notes live inside projects. Each project has an owning department, a status (Draft, Planned, Active, Deferred, Closed), a stage with optional substage and its history, and roles: exactly one Project Manager, optional Deputies, at most one Owner, Sponsors and Members. People join by an emailed invitation that expires after seven days; a new address gets its account when it accepts. Membership dates are worked out in UTC+8. Kainow checks the required roles before each status change and separates the Project Manager, Owner and Sponsors at seven people. Only the Owner or a Sponsor approves proposals; Deferred and Closed projects are read-only apart from lifecycle changes and repairing roles. |
| **Accounts, holds and access** (V1.0 sub-project 1b) | Disabling an account puts its project memberships On Hold and emails each Project Manager; the PM or a role manager records findings and restores or removes the membership. Audit and Oversight access is recorded by a manager, approved by a different one, read-only and time-limited (30 days by default, 90 at most). The Project Manager can hand over to someone who accepts. Closed projects can be archived, and are archived automatically twelve months after closing. The Administrator can move a project to another department. "Sign out everywhere" ends every session. |
| **Authorised records** (V1.0 sub-project 2a) | Authorising a proposal (Owner or Sponsor) creates one task, decision, question or risk; a repeated click returns the same record. A task has one accountable person and a due date: the Authorise form suggests the person named in the notes, invites by email someone not yet in the project (the task shows Awaiting Membership), and splits an action naming several people into subtasks. Tasks move Not Started, In Progress, Blocked, Completed with notes; a parent completes only when its subtasks are finished or with the Project Manager's recorded override; reopening a subtask reopens its completed parents. Questions are answered and then resolved; risks are mitigated, accepted with a review date, or resolved. People can propose without a discussion source. Everything is on the project's Work tab. |
| **Onboarding** | Each installation registers its own organisation: the first Enterprise Administrator is invited by a one-time setup link (`npm run setup-invite`), then gives the organisation's name, at least one email domain and one department, and optionally a wide and a square logo. Until setup is finished everything else is closed and Kainow shows its own name and logo; afterwards the organisation's name and logos appear in the page header, on the sign-in page and in every email. The product names no organisation of its own. |
| **Changes, closure and approvals** (V1.0 sub-project 2b) | Authorised records can now be changed, always by a proposal that an Owner or Sponsor authorises. A task's due date, title or assignee can be amended, and a task (with each unfinished subtask kept or cancelled) can be cancelled, with a follow-up task proposed from a cancelled one. A decision can be replaced or withdrawn; the work it affected is flagged "Review: decision changed" until the Project Manager clears each flag with a note. **Closing** is prepared on its own screen: every open task, question and risk needs a disposition (keep a task outstanding, resolve or leave a question unresolved, finally accept a risk or hand it over to another Active project, whose Owner or Sponsor accepts or declines it), and Delivered is offered only when the objectives were met and nothing is kept outstanding. An Owner or Sponsor can let the Project Manager prepare and close (delegated closure, D72); approvals stay with Owners and Sponsors, who are emailed when the Project Manager closes. Tasks left unfinished when a project is deferred or closed need a **deadline review** before work restarts: new due dates are authorised (all or in part), or work finished during the pause is reconciled with its actual date. An Administrator sets how many Owners or Sponsors must approve a change (1, 2 or 3; the default is 1) under **Approvals**, optionally letting each project set its own; changes of the count are kept in a history and pending requests are kept or restarted. |
| **Notes intake** | Paste text, or upload TXT, Markdown, DOCX or text-based PDF. Files are checked for safety, text is normalised, and each change to a note is a new, immutable version. Originals are kept. |
| **AI extraction** | A background worker sends the note to the configured model and gets back proposals. A basic credential check runs first and blocks sending if it finds keys, tokens or passwords. Quotes are located in the stored text by character position. |
| **Review screen** | The notes on the left with every proposed passage highlighted, the proposals on the right. Approve or reject each one with the keyboard or mouse. A quote that repeats must be resolved by choosing which place was meant. A proposal's wording, owner and due date can be edited; the model's original is kept beside it and the proposal goes back to review. |
| **Spending control** | A monthly AI spending cap (MYR 20 by default, reset on the first of the month, UTC+8). Each call reserves its worst-case cost before it runs and is refused if it would not fit. An optional per-person monthly limit. Administrators see and change the settings. |
| **Languages** | English, Bahasa Melayu and mixed-language notes. |
| **Audit** | Sign-ins, decisions, edits, settings changes and administration are recorded and cannot be changed or deleted. |
| **Install** | A Docker Compose package for a single computer (built and run on Windows with Docker Desktop on 8 November 2026). |

Dates and times are shown in UTC+8.

## Where Kainow is going (V1.0, not built yet)

The V1.0 design in [`docs/`](docs/) goes much further than the MVP. In summary, it adds:

- **The rest of accountable work (sub-project 2b):** amendments and cancellation of authorised records, replacing or withdrawing decisions, accounting for unfinished work at closure, and new due dates before a paused project resumes.
- **Reminders and escalation:** reminders before a deadline, and escalation to the right person when work is overdue.
- **Dashboards:** personal, project and leadership views of progress, deadlines, risks and resource use.
- **Reporting and outputs:** consolidated action-item emails and exports to Markdown, DOCX, PDF and CSV, with managed storage on SharePoint or OneDrive.
- **More access and privacy controls:** restricted sources, sanitised summaries, and separate handling for content that may contain credentials.

The MVP and the deferrals are recorded in [`docs/MVP-DECISIONS.md`](docs/MVP-DECISIONS.md).

## Who it is for, and how it gets used

- **Turning a meeting into follow-up.** A coordinator pastes the notes from a weekly meeting. Kainow proposes the actions with owners and deadlines the notes actually state, the decisions that were made (with conditions like "subject to the Head of Department's approval" kept), and the risks. The coordinator approves or corrects each, and what is left is a clear list of who owes what.
- **Cross-department work.** Course registration, timetable changes or a document-system pilot involve several people in several offices. The quoted passage behind each proposal settles later arguments about what was actually said.
- **Notes in more than one language.** Teams that switch between English and Bahasa Melayu in the same meeting get proposals from the notes as written.
- **Small teams.** One installation serves a single organisation, and a small team can combine roles while still keeping the approver and the person who does the work distinct where it matters.
- **Oversight and audit.** Leaders and auditors see what was decided and who approved it, with the evidence and history preserved, without being able to rewrite it.
- **Controlling AI cost.** Administrators set the model, prices and spending limits, and every call is counted against the cap.

## What Kainow is not

Kainow does not take minutes, record or transcribe meetings, or read scanned documents (no OCR). It is not a chat app, calendar, email client, document repository, Gantt or portfolio planner, resource-booking system or accounting package. It does not run actions on its own. Plugins and a public API are outside V1.0.

## How it works

One TypeScript application and one worker, one PostgreSQL 16 database, one organisation per installation.

- **API:** NestJS. Every route must declare how it is protected, and anything not granted is denied. It also serves the review screen.
- **Worker:** pg-boss jobs on the same database run the AI requests, at most two at a time.
- **Review screen:** React and Vite, with bundled fonts and nothing loaded from the internet.
- **Database:** triggers in the database itself refuse the update or deletion of note versions, audit events and proposal edits, so even a bug in the application cannot rewrite them.
- **AI:** the OpenAI API, with the model pinned in settings (currently `gpt-6.1-sol`). Each call records its token counts, and the full text of a note is sent to the provider, so use notes you are comfortable sending.

## Try it

- **Install on one computer with Docker Compose:** see [`INSTALL.md`](INSTALL.md). It needs Docker, a database password, a secret, a way to send sign-in codes, and an OpenAI key if you want extraction to run.
- **Run it for development:** see [`app/README.md`](app/README.md). It covers the environment variables, the database, the tests and each part of the app in detail.
- **Check the AI quality:** see [`tests/extraction/README.md`](tests/extraction/README.md). A script runs the model on sample notes and scores whether its quotes are real and whether it finds the expected items.

## Where things stand

| Item | State |
| --- | --- |
| Sign-in, people, notes intake, spend cap, review screen | Built and tested against PostgreSQL 16; the review screen has been checked in a real browser, not yet used by a person on a real installation |
| AI extraction | Built, tested with a stand-in model, and run against the real `gpt-6.1-sol` inside the Docker install on synthetic and real notes. The standalone check has run against the real `gpt-6.1-sol` on three synthetic notes, with all quotes verbatim ([review record](docs/MVP-EXTRACTION-REVIEW-2026-11-07.md)). The application's own AI adapter reached the real model on 8 November 2026 (`probe-ai` in the Docker worker, one small request). One full extraction inside the Docker install (synthetic note SYN-02) returned 11 proposals, all quotes found, for MYR 0.06 |
| Docker Compose install | Built and run on Windows 11 with Docker Desktop (8 November 2026): the install steps, sign-in in a browser, a Word upload, the backup, and extraction and review of one synthetic note with the real model all work |
| Real meeting notes | Seven sets of real minutes run in the Docker install (8 November 2026), three times: all quotes found each time. Sub-actions listed in one row now become one proposal each. Due dates are now read as a day, a range or an event, and an action without one cannot be approved ([record](docs/MVP-EXTRACTION-REVIEW-2026-11-08-DUE-DATES.md)). The human review of the real-note results is not yet done |
| Authorised records (2a) | Built and tested against PostgreSQL 16 (9 November 2026), walked through in the Docker install (a split action, an approved-before-records action, a question and a risk authorised; the task lifecycle with a refused parent completion and a reopen; question resolved; risk accepted); the accessibility pass is clean on 58 screen states |
| Onboarding | Built and tested against PostgreSQL 16 (9 November 2026); see the walk-through note in the plan ledger |
| Changes, closure and approvals (2b) | Built and tested against PostgreSQL 16 (9 November 2026); walked through on a scratch database with an approval count of 2 (a date amended, a task cancelled, a decision replaced and a flag cleared, a deferral, a partial deadline review, a reconciliation, a resumption, and a closure keeping a task, leaving a question unresolved and handing a risk over); the accessibility pass is clean on 102 screen states |
| Cross-project search | Built on branch `v1/search` and tested against PostgreSQL 16 (10 November 2026); not yet merged to `main` or used by a person on a real installation |
| Accounts, holds and access (1b) | Built and tested against PostgreSQL 16 (8 November 2026), walked through in the Docker install (disable and restore, a finding, an Audit grant, a handover to a new address, department move, archive, sign out everywhere); the accessibility pass is clean on 46 screen states |
| Projects and roles | Built and tested against PostgreSQL 16 (8 November 2026), and walked through in the Docker install with four test accounts: organisation set-up, first project, invitations, the lifecycle including deferral and resumption, notes and review inside a project. The automated accessibility pass is clean on every screen at desktop and phone widths |
| One administrator | The MVP names two administrators, but there is no separate recovery custodian yet; that must be fixed before production |

The accuracy target is 95% of proposals supported by a real quote and 90% of expected items captured. A good score on synthetic notes does not show the rate on real ones.

## Repository layout

| Path | What is in it |
| --- | --- |
| `app/` | The application: API, worker, SQL migrations, and the review screen in `app/web/` |
| `docs/` | The V1.0 product baseline and the MVP decisions |
| `tests/extraction/` | The AI extraction quality check |
| `technical-baseline/` | An earlier library spike, not product code |
| `compose.yaml`, `INSTALL.md` | The single-computer install |

## Reading the documents

Start with [`docs/Kainow-V1.0-START-HERE.md`](docs/Kainow-V1.0-START-HERE.md), then the [Product Summary](docs/Kainow-V1.0-Product-Summary.md) for the concept and the rules, and [`docs/MVP-DECISIONS.md`](docs/MVP-DECISIONS.md) for what the MVP covers and what was deferred.

## Repository

https://github.com/NgohCH/kainow

## Licence

GNU Affero General Public License version 3 only (AGPL-3.0-only). See [`LICENSE`](LICENSE). Checking the repository's licence notices is a task before go-live and has not been done for the MVP.
