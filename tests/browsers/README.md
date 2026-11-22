# Supported-browsers smoke run

`smoke.mjs` drives one journey through Kainow in every browser this PC can run, at a desktop and a phone size (and a tablet size in Chrome and WebKit), with [Playwright](https://playwright.dev) pinned in `package.json` (10b spec §14.1, decision D124). Each step does what a person does, then checks that the expected heading or text is on screen and that the browser logged no console error, and takes a screenshot.

| # | Step | What it checks |
|---|---|---|
| 1 | Sign-in page | "Sign in to Kainow" and the Work email box |
| 2 | Sign in with a code | the code step, then My Projects after the code from the API log is entered |
| 3 | My Projects | the project list with Load Project 01 |
| 4 | Open a project | the project's heading and About |
| 5 | Work tab | Tasks |
| 6 | Open a task and save a progress change | blocks an In progress task with a reason ("Block: done.", the task shows Blocked); when none is left, unblocks a Blocked one ("Unblock: done.", In Progress) |
| 7 | Post a discussion comment | the comment appears under Messages |
| 8 | Open a note | the note's heading |
| 9 | Review screen with a proposal | Load Project 06, or the next project the Administrator owns once 06 has none waiting: Proposals from people, with a decision waiting |
| 10 | Approve a proposal | Authorise: "Authorised: it is now on the Work tab." |
| 11 | Personal dashboard | My Projects: Needs you and My tasks |
| 12 | Project dashboard | the project's Figures |
| 13 | Analytics as Administrator | Analytics and Saved views |
| 14 | Operations page | Operations and Backups |
| 15 | Sign out | the sign-in page again |

**Browsers** (`BROWSERS`, a comma list; the default is all of them):

| Name | What runs | Sizes |
|---|---|---|
| `chrome` | the installed Chrome | desktop, phone, tablet |
| `msedge` | the installed Edge | desktop, phone |
| `firefox` | Playwright's Firefox build | desktop, phone |
| `webkit` | Playwright's WebKit build, labelled **"WebKit engine, not Safari"**: it shows WebKit layout and script problems, but Safari itself is checked by hand (`docs/operations/safari-check.md`) | desktop, phone, tablet |
| `firefox-previous` | the Firefox build of the previous Playwright release (`playwright-previous` in `package.json`) | desktop, phone |
| `chrome-previous`, `msedge-previous` | a previous major installed side by side, given as `CHROME_PREVIOUS` / `MSEDGE_PREVIOUS` (the path of its `chrome.exe` / `msedge.exe`). Without it the run records "not checked" and the reason. Beta and Dev channels are newer, not previous. | desktop, phone |

Sizes: desktop 1280×800, phone 390×844, tablet 820×1180 (the viewport only: no touch or mobile user agent, so the same settings work in every engine).

## Running it

It needs no Docker, no AI key and no worker. It needs a scratch database, seeded with the load-test seed (`docs/operations/load-test.md`: "Example Organisation", example.org, `load-001@example.org` is the Enterprise Administrator, the Project Manager of Load Project 01 and the Owner of Load Project 06), and the API running against it with its output in a file:

```
createdb kainow_browsers                                  # a throwaway database; never a real one
export DATABASE_URL=postgres://.../kainow_browsers
cd app && npm run build && npm run build:web && npm run migrate
npm run load-test -- --seed                               # about 30 s; refuses a database that is not empty
AUTH_SECRET=<32+ random characters> PORT=3312 APP_URL=http://localhost:3312 LOG_SIGN_IN_CODES=true COOKIE_SECURE=false \
  KAINOW_RELEASE_API=http://127.0.0.1:9 node dist/main.js > /tmp/browsers/api.log 2>&1 &     # keep this running
cd ../tests/browsers && npm install && npx playwright install firefox webkit
node node_modules/playwright-previous/cli.js install firefox                                 # the previous Firefox
KAINOW_API_LOG=/tmp/browsers/api.log node smoke.mjs
```

Settings: `KAINOW_URL` (default `http://localhost:3312`), `KAINOW_EMAIL` (default `load-001@example.org`), `KAINOW_API_LOG`, `BROWSERS`, `KAINOW_PROJECT` (default Load Project 01), `KAINOW_REVIEW_PROJECTS` (default Load Project 06, 16, 26, 36: the first with a decision waiting; each journey authorises one, and each project has 20), `CHROME_PREVIOUS`, `MSEDGE_PREVIOUS`.

Afterwards stop the API and drop the database. A run changes the data (it blocks one task, posts a comment and authorises one proposal per browser and size); the seed has enough for many runs.

Notes:

- The API sends one sign-in code a minute per person, so each journey waits up to a minute before asking for its code. A full run (12 journeys) takes about 20 minutes.
- One console error is expected and not counted: before sign-in (and after sign-out) the page asks `GET /auth/me`, the API answers 401, and Chrome, Edge and Firefox log any 4xx answer as "Failed to load resource". Every other console error or page error fails the step.
- No Playwright release ships every Firefox major: `firefox-previous` runs whatever the previous Playwright release ships (on 23 November 2026, Firefox 157, two majors behind 159), so the matrix records the previous major (158) as not checked and 157 as an older version checked.
- If Firefox fails with `spawn UNKNOWN` and Windows logs "side-by-side configuration is incorrect … mozglue", the browsers were installed from an app whose `%LOCALAPPDATA%` is redirected (a packaged app). Install and run with `PLAYWRIGHT_BROWSERS_PATH` set to an ordinary folder (the same value for `npx playwright install`, the `playwright-previous` install and `node smoke.mjs`).
- Each step's console errors are collected before its screenshot: in WebKit, Playwright's screenshot inserts a style of its own, which Kainow's Content Security Policy (`style-src 'self'`) refuses and WebKit logs ("Refused to apply a stylesheet …"). It happens only while Playwright takes the screenshot, so it is not counted.
- After a failed step the rest of that journey is skipped (and Sign out still runs when the sign-in worked).

## Output

`results/<date>.md` (the PC's date): each browser's exact version, the size, every step's result and every failure. The screenshots go in `results/<date>/<browser>-<size>/` and are not committed (`.gitignore`). The script exits 0 when every journey passed, 1 otherwise. The supported-browsers matrix (`docs/operations/browser-matrix.md`) records each run.
