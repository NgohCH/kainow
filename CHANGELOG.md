# Changelog

Each release has a section headed `## X.Y.Z`. The release script (`scripts/release.mjs`) uses that section as the release notes and as the message of the signed tag.

## Unreleased

- New look and navigation (D128): a side menu (Home, My tasks, Reviews, Projects and, for those who may use them, Leadership, Analytics, My AI use, Resource catalogue, Settings, Operations and Security review), a slim top bar, and a person menu with Customise, colour scheme, light or dark and Sign out. Home starts with a "Needs you" queue grouped by urgency (overdue, review and decisions, blocked, due soon and risk reviews). New pages: My tasks and Reviews.
- Settings hub (D128): the Enterprise Administrator's header links are now one Settings page of boxes, each showing the setting's current values and whether it is set up, needs attention, is failing or is not in use; every setting has its own page with "At a glance" first and a Change button per setting.
- Projects: a project header (name, state, departments, Project Manager and warnings) above binder tabs on every tab; Notes & discussion is now three tabs, Discussion, Notes and Proposals; the AI review screen opens inside the project.
- Colour schemes (D129): Red (the default), Teal, Blue, Plum and Slate, and light or dark, chosen in the person menu. An Enterprise Administrator can set the organisation's own colour, which becomes the default; Kainow refuses a colour that cannot carry white text. State colours never change and always come with a word and a symbol.
- Correcting a proposal (D130): a reviewer can change an AI proposal's type, wording, owner and due date beside its source, with a reason when the type changes; everyone sees who changed what and why in its Change history, ending with the AI's original.
- Stage templates (D131): seven ready-made stage lists (General, Software development, Product sales, Research project, Syllabus development, Marketing campaign, Event) chosen as the type of project when it is created; the Enterprise Administrator manages templates, and the Project Manager, Owner or Sponsor can add, reorder or retire a project's own stages. Existing projects keep their five stages (as General).
- The header no longer runs off the screen at 375 px; "Skip to content" moves to the page's content instead of going to Home.
- Releases are tags signed with the Product Owner's release key; an installation installs only a release whose signature verifies against its own trusted signers file (D119).
- Kainow checks for new releases daily, and an Enterprise Administrator can choose Check now; a new release notifies every Enterprise Administrator (D120).
- An Enterprise Administrator approves one release at a time, with a reason and a start time at least 15 minutes ahead; everyone active is emailed and sees a banner until it starts (D121).
- The updater (a cron-started container) prepares and builds the approved release while Kainow runs, then at the approved time takes a pre-update backup in read-only maintenance, migrates, restarts and checks health; a failure before the migration goes back by itself (D122).
- After a failed migration Kainow shows a fixed notice page, and the server operator's `recover` command restores the pre-update backup with the previous version (D123).
- A repeatable load test for 200 registered / 10 concurrent people, with its first result (`docs/operations/load-test.md`).
- Supported browsers: an automated smoke run, a Safari check by hand and the browser matrix (`docs/operations/browser-matrix.md`, D124).
- Installation: local changes now go in `compose.override.yaml` (never `compose.yaml`); `.env` gains the updater's `KAINOW_INSTALL_DIR`, `KAINOW_UID`, `KAINOW_GID` and `DOCKER_GID`; go-live step 13, Schedule the updater. `backup-cli.js` exits 3 when another backup, drill or restore holds the lock.
