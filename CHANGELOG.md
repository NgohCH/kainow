# Changelog

Each release has a section headed `## X.Y.Z`. The release script (`scripts/release.mjs`) uses that section as the release notes and as the message of the signed tag.

## Unreleased

- Releases are tags signed with the Product Owner's release key; an installation installs only a release whose signature verifies against its own trusted signers file (D119).
- Kainow checks for new releases daily, and an Enterprise Administrator can choose Check now; a new release notifies every Enterprise Administrator (D120).
- An Enterprise Administrator approves one release at a time, with a reason and a start time at least 15 minutes ahead; everyone active is emailed and sees a banner until it starts (D121).
- The updater (a cron-started container) prepares and builds the approved release while Kainow runs, then at the approved time takes a pre-update backup in read-only maintenance, migrates, restarts and checks health; a failure before the migration goes back by itself (D122).
- After a failed migration Kainow shows a fixed notice page, and the server operator's `recover` command restores the pre-update backup with the previous version (D123).
- A repeatable load test for 200 registered / 10 concurrent people, with its first result (`docs/operations/load-test.md`).
- Supported browsers: an automated smoke run, a Safari check by hand and the browser matrix (`docs/operations/browser-matrix.md`, D124).
- Installation: local changes now go in `compose.override.yaml` (never `compose.yaml`); `.env` gains the updater's `KAINOW_INSTALL_DIR`, `KAINOW_UID`, `KAINOW_GID` and `DOCKER_GID`; go-live step 13, Schedule the updater. `backup-cli.js` exits 3 when another backup, drill or restore holds the lock.
