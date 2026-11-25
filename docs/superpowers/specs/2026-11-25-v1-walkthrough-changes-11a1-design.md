# Sub-project 11a.1: changes from the demo walkthrough

Status: Approved by the Product Owner, 25 November 2026 (in conversation, after the demo walkthrough of 11a).

## 1. Why

The Product Owner walked through the redesigned interface before v0.1 and asked for more detail on tasks, a page about the person, clearer tabs, links between proposals and where they came from, renaming of stages, and a clear separation of current projects from Deferred and Closed ones. v0.1 goes to testers; these are the gaps a new person would meet first.

## 2. Goals, non-goals, anti-goals

**Goals:** everything about a task on one page; a page about me; tabs that read as separate at a glance; one click from a proposal to its source and to the record it became, and back; stages that can be renamed; a project list that shows what is current.

**Non-goals:** start dates, effort or dependencies on tasks; AI-written task descriptions; departments that change what a person can see; editing one's own name or email; new notifications.

**Anti-goals:** no permission, audience or lifecycle rule becomes wider. A person's department never grants access. No old address stops working.

## 3. Approaches

1. **Pages added to the existing screens (chosen by the Product Owner).** A task page and a My profile page at their own addresses. They can be linked from emails and work on phones.
2. A panel over the current screen. Quicker to open, but has no address to link to and is poor at 375 px.

## 4. Task page and description (D133)

- Address `#/projects/<id>/tasks/<taskId>`, inside the project frame with the Work tab open. `#/projects/<id>/work/<taskId>` still opens the Work tab at the row.
- Shows: title, description, status with its symbol and word, and one sentence on what the status means; assignee; due date with overdue or due-soon label; who authorised it and when; parent and subtasks (linked); follows and followed-by (linked); source quote and link; link to its proposal; history; the same actions as the Work row, under the same rules.
- **Blocked** wording: "Blocked: the work cannot continue. The due date has not moved." with the latest reason, who blocked it and when.
- Task links on Home, My tasks, Needs you, the Overview, Timeline, search, digests and notifications open this page. Links to other record kinds are unchanged.
- Read access is exactly that of `GET /records/tasks/:id` today.
- **Description:** optional text of up to 4,000 characters. Given when a person proposes an action or a subtask, or by the authoriser when authorising an action; changed through "Propose a change" (`amend_task`), with previous and new values in the history. The AI never fills it. Existing tasks have none, shown as "No description".
- The description is checked for credentials on entry and is in the quarantine registry like a task title.

## 5. My profile (D134)

- Address `#/me`, opened by "My profile" in the person menu. The menu keeps Customise, Sign out and Sign out everywhere; the colour choices move to the page.
- Shows: name, email, department; **Projects and roles** now (project, role, since, until or "No end date"); **Past roles** (with the day each ended); **Appearance** (theme, colour scheme, tab style).
- "Since" is the membership's start date, "until" its expiry. A role is past when it expired or was revoked. A project the person can no longer open shows its name and role without a link.
- **Department:** a person chooses one active department from the central list, or none, on this page. An Enterprise Administrator can change anyone's from the Administrators and people page. Changes are audited by ids only. A department later retired still shows, marked "(retired)", until changed. It is information only and gives no access.

## 6. Tab style (D135)

Three styles, a personal preference: **Boxes** (default; separate boxed buttons with a strong edge, the open one filled), **Grey dividers** (open tab raised and filled) and **Tinted dividers** (open tab joined to its page). Every style works in all six colour schemes, Light and Dark, with edges at least 3:1 against the page and text at least 4.5:1, and the open tab never shown by colour alone. A count badge stays readable in each.

## 7. Proposals, sources and Work (D136)

- Proposals tab: each row links to its source (the note version, minutes or discussion) as well as to its review.
- Review screen: each proposal links to the exact place it came from, when the reader may open it.
- An authorised proposal links straight to its record: a task to its page, other kinds to their row in Work.
- Every Work item and the task page link back to the proposal they came from. A person's own proposal has no source and says so as today; it links to its record, and the record back to it.
- Every link follows the existing access rules; someone who may not open a source sees what they see today.

## 8. Stages (D137)

- **Rename** a stage in a project, with a reason, by the people who may already change stages. Same limits as adding: 1–80 characters, not a name already used in the project, not while the project is Closed, Deferred or archived.
- The new name shows everywhere, past periods included; the change history keeps the old and new names, the person, the date and the reason. Renaming does not alter the template the project came from.

## 9. Current projects and history (D138)

- Projects shows **Current projects** (Draft, Planned, Active) first. Below it, **History** has two tables: **Deferred** (with deferred-on date and reason) and **Closed** (with closed-on date and outcome). Archived projects stay behind "Include archived". The state tiles still filter.
- Home's project section lists current projects only, with a line linking to History when there are others.
- A Deferred or Closed project's last stage stops on the day it was deferred or closed: Timeline bars end there and say "Stopped when deferred" or "Stopped when closed"; it is not called Current, and the number of days stops. A stage that ran through an earlier deferral ends its bar at that deferral. Stored periods do not change.

## 10. Due soon (D139)

"Due soon" means due from today to seven working days ahead by the project's calendar, in every place the words appear: Needs you, My tasks, Home and the project figures. The seven-day reminder email is a separate rule and does not change.

## 11. Cleaning and unique names

Unique-name rules on swept columns ignore values holding the credential marker, so two names that clean to the same text cannot stop the cleaning. A permanent test checks every unique index on a registered text column.

## 12. Verification

Server and web tests for every rule above; leak tests for the task page, description and links; accessibility audit of the new pages and all three tab styles at 1200 and 375 px, Light and Dark; browser smoke; walkthrough on the demo; full server suite. Catalogue: C114 (person's department), C115 (tab style). Migrations 0040 and 0041.

## 13. Builder's own calls

The address names; description length; renaming past periods as well as the current one; Draft and Planned counting as current; "Past roles" listing revoked roles without their reason.

## 14. Duplicate project (D140; added by the Product Owner, 25 November 2026)

**Why.** Work repeats for another customer or another year with small differences. Starting from a blank project wastes the Project Manager's time; carrying everything over would leak one customer's information to another's members.

**Approaches.** (1) Duplicate from a project, with a review page (chosen). (2) Save a project as a reusable template: one more thing to maintain, and duplicating covers the cases given.

- **Who:** a current Project Manager of the original who may also create projects (the existing eligibility rule). The original may be in any state, archived included. An Enterprise Administrator without the Project Manager role may not.
- **Result:** one new Draft project with that person as its only member (Project Manager), created all at once or not at all. Nothing exists before Create; leaving the page warns of unsaved input. The original is not changed, apart from an audit entry.
- **Must be decided before Create (checked by the server too):** a name different from the original's, ignoring case and surrounding spaces; a planned end date that differs from the original's, or "No planned end" chosen; the purpose edited or ticked "still correct".
- **Old terms:** the Project Manager may list up to ten words or phrases (customer, year). Every carried text holding one is highlighted; each must be changed or confirmed as still correct. Matching ignores case. The terms themselves are not stored.
- **Copied, editable before Create:** purpose; owning and contributing departments (a retired one must be replaced or removed); stages and substages in use, starting in the first; project holidays; required approvals; notification settings; output settings. Output settings copy only choices that do not name a person, address, folder or connection.
- **Tasks and subtasks:** title and description, the Project Manager choosing which; a subtask needs its parent. Cancelled and Deleted tasks, and anything held or under quarantine, are not offered. Each kept task becomes a **human proposal** in the new project with its subtasks, an optional new due date and no assignee; assignee and any missing due date are given at authorisation. Old dates, assignees, status, history and evidence are not copied.
- **Risks:** offered, none ticked; kept ones become proposals with their wording only.
- **Resources:** planned lines copied as item and quantity, without dates, people or amounts of money. A line whose catalogue item is retired is not offered.
- **Never copied:** people, roles, invitations, access grants; notes, minutes, discussions, decisions, questions, outputs, drafts, summaries, files, history; budget and spending; AI connection, limits and analysis settings; leadership access; audiences; change requests; feedback.
- **Approval:** copied proposals carry "Copied from <original>" and follow the normal authorisation rules, the required number of approvals included. An Owner or Sponsor can authorise several at once on one page, each needing its assignee and due date; each is authorised separately, so one failure does not undo the others and is named.
- **Leak rule:** the original's name and a link appear only to someone who may open the original. Everyone else sees "Copied from another project".
- **Limits:** 500 tasks and subtasks, 200 risks, 200 resource lines per duplication; more is refused with the counts and nothing is created.

## 15. Needs you and tasks by project (D141; asked for by the Product Owner, 25 November 2026)

**Why.** Needs you and My tasks mix every project in one long list; the Product Owner found it messy and disorienting.

- **Home, Needs you:** one box per project, headed by the project's name (a link) and its counts by urgency (symbol, word and number). Inside, the items keep the urgency order Overdue, Review and decisions, Blocked, Due soon, each with its symbol and word.
- **Home, My tasks, and the My tasks page:** one box per project in the same way, each with its own table: overdue first, then by due date. The project column goes, since the box says it.
- **Order of projects:** most overdue items first, then most items needing review, then most due soon, then by name.
- Each box opens and closes with a button. On Home and on the page the first three are open to start with; a box shows its first five rows with "Show all n".
- **My tasks page:** a "Group by" choice, Project (default) or Due date (today's single table). Status and project filters stay and apply to both; a project left with no match is not shown.
- With one project only, its box is open and the "Group by" choice stays.
- Inside a project, the project's own Needs attention list is unchanged.
- Nothing is added or hidden: the same items, counts and links as before.
