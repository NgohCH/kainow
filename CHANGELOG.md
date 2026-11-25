# Changelog

Each release has a section headed `## X.Y.Z`. The release script (`scripts/release.mjs`) uses that section as the release notes and as the message of the signed tag.

## Unreleased

- New look and navigation (D128): a side menu (Home, My tasks, Reviews, Projects and, for those who may use them, Leadership, Analytics, My AI use, Resource catalogue, Settings, Operations and Security review), a slim top bar, and a person menu with Customise, colour scheme, light or dark and Sign out. Home starts with a "Needs you" queue grouped by urgency (overdue, review and decisions, blocked, due soon and risk reviews). New pages: My tasks and Reviews.
- Settings hub (D128): the Enterprise Administrator's header links are now one Settings page of boxes, each showing the setting's current values and whether it is set up, needs attention, is failing or is not in use; every setting has its own page with "At a glance" first and a Change button per setting.
- Projects: a project header (name, state, departments, Project Manager and warnings) above binder tabs on every tab; Notes & discussion is now three tabs, Discussion, Notes and Proposals; the AI review screen opens inside the project.
- Colour schemes (D129): Red (the default), Teal, Blue, Plum and Slate, and light or dark, chosen in the person menu. An Enterprise Administrator can set the organisation's own colour, which becomes the default; Kainow refuses a colour that cannot carry white text. State colours never change and always come with a word and a symbol.
- Correcting a proposal (D130): a reviewer can change an AI proposal's type, wording, owner and due date beside its source, with a reason when the type changes; everyone sees who changed what and why in its Change history, ending with the AI's original.
- Stage templates (D131): seven ready-made stage lists (General, Software development, Product sales, Research project, Syllabus development, Marketing campaign, Event) chosen as the type of project when it is created; the Enterprise Administrator manages templates, and the Project Manager, Owner or Sponsor can add, reorder or retire a project's own stages (at most 20 in use), with a Change history in the project's Settings. Existing projects keep their five stages (as General).
- **Analytics progress CSV: a new Stage template column after Status.** Every later column moves one place to the right; adjust any spreadsheet or script that reads the columns by position.
- Proposals tab: lists the AI's proposals from discussions as well as from notes, each only to people who may read the source.
- Task page (D133): every task opens on its own page, with an optional description (up to 4,000 characters), what its status means, why it is blocked, its source, its proposal, its history and the same actions as in Work. Links to tasks open it; old addresses still work.
- My profile (D134): your details, department, projects and roles now and before, and how Kainow looks for you, in the person menu. The department is information only and gives no access.
- Tab style (D135): Boxes, Grey dividers or Tinted dividers, chosen by each person.
- Proposals, sources and records link to one another, to the exact passage or message (D136).
- Stages can be renamed, with a reason (D137). Projects shows Current projects first and a History of Deferred and Closed ones; a stage stops on the day its project is deferred or closed (D138).
- **"Due soon" now means up to seven working days ahead by the project's calendar, everywhere the words appear (D139); counts in the figures can change.** The reminder emails are unchanged.
- Duplicate project (D140): a Project Manager starts a new Draft project from an existing one, reviewing everything carried over before anything is created; and an Owner or Sponsor can authorise several proposals at once. A credential case names the projects its project was copied to or from.
- Home and My tasks are grouped by project, with a choice to group My tasks by due date (D141).
- The first resource catalogue item can be added with a new category in the same form.
- Two stage names that clean to the same text can no longer stop a credential from being removed.
- Four migrations: 0036 (interface), 0037 (stage templates), 0038 (project stage changes) and 0039 (a credential in a long stage name, correction reason or AI connection name can always be removed).
- Two more migrations: 0040 (task descriptions, a person's department, stage renames, and a unique rule that cannot stop cleaning) and 0041 (where a project and its proposals were copied from).
- Timeline bars (D132): each project's Timeline tab shows its stages as bars on a date axis with a Today line, and markers for task due dates, risk reviews, resources needed by and the planned end; read-only, built only from recorded dates, with a text summary for screen readers.
- The header no longer runs off the screen at 375 px; "Skip to content" moves to the page's content instead of going to Home.
- Releases are tags signed with the Product Owner's release key; an installation installs only a release whose signature verifies against its own trusted signers file (D119).
- Kainow checks for new releases daily, and an Enterprise Administrator can choose Check now; a new release notifies every Enterprise Administrator (D120).
- An Enterprise Administrator approves one release at a time, with a reason and a start time at least 15 minutes ahead; everyone active is emailed and sees a banner until it starts (D121).
- The updater (a cron-started container) prepares and builds the approved release while Kainow runs, then at the approved time takes a pre-update backup in read-only maintenance, migrates, restarts and checks health; a failure before the migration goes back by itself (D122).
- After a failed migration Kainow shows a fixed notice page, and the server operator's `recover` command restores the pre-update backup with the previous version (D123).
- A repeatable load test for 200 registered / 10 concurrent people, with its first result (`docs/operations/load-test.md`).
- Supported browsers: an automated smoke run, a Safari check by hand and the browser matrix (`docs/operations/browser-matrix.md`, D124).
- Installation: local changes now go in `compose.override.yaml` (never `compose.yaml`); `.env` gains the updater's `KAINOW_INSTALL_DIR`, `KAINOW_UID`, `KAINOW_GID` and `DOCKER_GID`; go-live step 13, Schedule the updater. `backup-cli.js` exits 3 when another backup, drill or restore holds the lock.
