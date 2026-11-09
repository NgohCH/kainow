# Automated accessibility pass

`audit.mjs` runs axe-core (WCAG 2.0/2.1/2.2 A and AA rules, plus best-practice rules) in headless Chrome over every screen, at 1200 px and 375 px wide: sign-in, the code step, the wrong-code error, an invitation while signed out, My Projects (and the new-project form), a project's overview (and the defer form and department move), people (with a held member, a grant request, the finding, handover and grant forms) and notes, a Closed project's archive panel, a handover invitation while signed out, a note, the review screen, the wording editor, administrators, departments, domains AI spending, and (sub-project 2b) the Approvals settings, the Work tab with change requests waiting (0 of 2 and 1 of 2 approvals) and a decision replaced with its review flags, the amend, cancel, decision-replacement, flag-clearing and request-rejection forms, the Closing screen not ready and ready (with the disposition form open and delegation), a deferred project's Deadline review (a request waiting, new due dates, and the finished-during-the-pause form) and the Overview of those projects. The audit sets the organisation's approval count to 2 and lets projects override it, and adds a second Sponsor account directly in the database.

It needs no Docker and no AI key. It needs a scratch database and the API running against it:

```
createdb kainow_a11y
export DATABASE_URL=postgres://.../kainow_a11y AUTH_SECRET=<32+ random characters> LOG_SIGN_IN_CODES=true COOKIE_SECURE=false PORT=3066 APP_URL=http://localhost:3066
cd app && npm run build && npm run build:web && npm run migrate
npm run setup-invite -- a11y@example.org "Access Check" > /tmp/a11y/setup.log   # the one-time setup link
node dist/main.js > /tmp/a11y/api.log 2>&1 &        # keep this running
curl -s -XPOST localhost:3066/auth/request-code -H 'content-type: application/json' -d '{"email":"a11y@example.org"}'
cd ../tests/a11y && npm install && node audit.mjs
```

The script signs in with the code printed in the API log (which uses the setup link), audits the used setup link, the sign-in page with Kainow's defaults and the onboarding screen empty, then gives the name "Example Organisation", the domain example.org, a department and both logos, audits onboarding filled, finishes setup, and then creates a project (making the administrator its Project Manager and Owner, with a separate Member, directly in the database), invites a Sponsor, disables and re-enables the Member so their membership is On Hold, records an Audit request, issues a handover, creates a Closed project, adds one note, and inserts one finished extraction run with four proposals (a repeated quote, a quote that is not in the notes, an owner and a deadline) so the review screen has something to check. After the other screens it audits the Organisation screen, the sign-in page with the organisation's logos, the header with the wide logo only, and sign-in with the square logo only. Settings: `KAINOW_URL`, `KAINOW_EMAIL`, `KAINOW_API_LOG`, `KAINOW_SETUP_LOG`, `CHROME`, and `DATABASE_URL` (for the inserted run). Never point it at a real database.

## What a clean result means

Run on 7 November 2026: 0 violations across 18 screen states. Run on 8 November 2026 (with projects): 0 violations across 34 screen states, after moving the sign-in form on the invitation page out of a second main landmark. With sub-project 1b's screens: 0 violations across 46 screen states. With sub-project 2a (the Work tab, people's proposals, the Authorise form with subtasks, the task complete and risk accept forms, in an extra "Records access check" project): 0 violations across 58 screen states. After the review fixes (with a task's History open): 0 violations across 60 screen states. With onboarding (the setup link page, sign-in with Kainow's defaults, onboarding empty and filled, the Organisation screen, and the header and sign-in with each logo shape): 0 violations across 76 screen states. With sub-project 2b (the screens listed above): 0 violations across 102 screen states.

Automated rules find only a part of the real problems (missing names and labels, colour contrast, bad structure). A clean run does not show the product is accessible. Still to do by hand, as part of the January accessibility audit: keyboard-only use of every screen, focus order and visible focus, a screen reader on the review screen (the marked passage and the repeated-passage chooser), zoom to 200%, and reduced motion. The app has no dark theme, so none was tested.
