# Supported browsers: the matrix

Kainow supports the **current and previous major releases of Edge, Chrome, Firefox and Safari** at each product release, on desktop, tablet and phone (decision D124). This page records what was checked for each release: one row per browser, major version and device class, with the exact version, how it was checked, the date, the result and any limitation. **A version not checked is recorded as "not checked", never as supported.**

How each is checked:

- **Automated**: the smoke run in `tests/browsers/` (README there): the same journey of 16 steps (19 since sub-project 11a.1: also a task's own page, My profile and each tab style) (sign in with a code, Projects from the side menu, a project, the Work tab, a task's progress saved, a discussion comment, a note, the AI review screen for a finished run (inserted into the test database by `tests/browsers/review-run.mjs`, since the test installation has no AI) with a decision authorised there, a person's proposal authorised, the personal and project dashboards, Analytics and Operations as Administrator, sign out from the person menu), each step checking what is on screen and that no console error was logged. Desktop is 1280×800, phone 390×844, tablet 820×1180 (Chrome and WebKit only). Results: `tests/browsers/results/<date>.md`.
- **By hand**: Safari on a Mac, iPhone and iPad, by the Product Owner with `docs/operations/safari-check.md` (the same steps; its setup makes the AI run with `review-run.mjs`).

## Sub-project 11a.1, the walkthrough changes (checked 25 November 2026)

The journey of 19 steps, which also fails on any 4xx or 5xx reply and on any sideways scroll, against a test installation of this branch with the load-test seed, on the development PC (Windows 11). Result: `tests/browsers/results/2026-11-25.md`.

| Browser | Major | Device class | Exact version | How checked | Date | Result | Limitation |
|---|---|---|---|---|---|---|---|
| Chrome | 157 (current) | desktop, phone, tablet | 157.0.8103.80 | automated | 2026-11-25 | passed (19/19 each) | phone and tablet are sized windows on Windows (no touch, desktop user agent) |
| Edge | 158 (current) | desktop, phone | 158.0.4370.33 | automated | 2026-11-25 | passed (19/19 each) | tablets are checked in Chrome and WebKit only |
| Firefox | 159 (current) | desktop, phone | 159.0 (Playwright 1.65.1 build) | automated | 2026-11-25 | passed (19/19 each) | Playwright's build of Firefox, not the Mozilla release |
| Firefox | 157 (older than supported) | desktop, phone | 157.0 (Playwright 1.64.1 build) | automated | 2026-11-25 | passed (19/19 each) | Not a supported version; evidence only. |
| WebKit engine, not Safari | 27.2 | desktop, phone, tablet | 27.2 (Playwright 1.65.1 build) | automated | 2026-11-25 | passed (19/19 each) | Not a Safari result. |
| Chrome 156, Edge 157, Firefox 158 (previous) | previous | all | — | not checked | — | not checked | Cannot be obtained on this PC, as before. |
| Safari (macOS, iOS, iPadOS) | current and previous | all | — | not checked | — | not checked yet | The Product Owner's check by hand (`safari-check.md`) is still to do; its steps were updated on 25 November 2026. |

## Sub-project 11a, the interface redesign (checked 24 November 2026)

The same 16 steps on the redesigned screens (side menu, binder tabs, person menu), against a test installation of this branch with the load-test seed, on the development PC (Windows 11). Result: `tests/browsers/results/2026-11-24.md`.

| Browser | Major | Device class | Exact version | How checked | Date | Result | Limitation |
|---|---|---|---|---|---|---|---|
| Chrome | 157 (current) | desktop, phone, tablet | 157.0.8103.80 | automated | 2026-11-24 | passed (16/16 each) | phone and tablet are sized windows on Windows (no touch, desktop user agent) |
| Chrome | 156 (previous) | desktop, phone, tablet | — | not checked | — | not checked | No Chrome 156 can be installed beside the current one on this PC. |
| Edge | 158 (current) | desktop, phone | 158.0.4370.33 | automated | 2026-11-24 | passed (16/16 each) | tablets are checked in Chrome and WebKit only |
| Edge | 157 (previous) | desktop, phone, tablet | — | not checked | — | not checked | No Edge 157 can be installed beside the current one on this PC. |
| Firefox | 159 (current) | desktop, phone | 159.0 (Playwright 1.65.1 build) | automated | 2026-11-24 | passed (16/16 each) | Playwright's build of Firefox, not the Mozilla release |
| Firefox | 158 (previous) | desktop, phone, tablet | — | not checked | — | not checked | No Playwright release ships Firefox 158. |
| Firefox | 157 (older than supported) | desktop, phone | 157.0 (Playwright 1.64.1 build) | automated | 2026-11-24 | passed (16/16 each) | Not a supported version; evidence only. |
| WebKit engine, not Safari | 27.2 | desktop, phone, tablet | 27.2 (Playwright 1.65.1 build) | automated | 2026-11-24 | passed (16/16 each) | Not a Safari result. |
| Safari (macOS, iOS, iPadOS) | current and previous | all | — | not checked | — | not checked yet | The Product Owner's check by hand (`safari-check.md`) is still to do; its steps were updated on 24 November 2026 for the side menu, binder tabs and person menu. |

The header overflow at 375 px seen in earlier runs is gone: the header was rebuilt as a slim top bar with a person menu. The automated accessibility pass now fails any screen that scrolls sideways at 375 px (151 screen states, none does), and a check by hand at widths from 375 to 1200 px found and fixed two more cases (the person button at 700 to 740 px, and wide tables between 640 and 1100 px, which now scroll inside their box).

## V1.0 (checked 23 November 2026)

Run against a test installation of this branch with the load-test seed ("Example Organisation"), on the development PC (Windows 11). Result: `tests/browsers/results/2026-11-23.md`.

| Browser | Major | Device class | Exact version | How checked | Date | Result | Limitation |
|---|---|---|---|---|---|---|---|
| Chrome | 157 (current) | desktop | 157.0.8103.80 | automated | 2026-11-23 | passed (16/16) | |
| Chrome | 157 (current) | phone | 157.0.8103.80 | automated | 2026-11-23 | passed (16/16) | phone-sized window on Windows (no touch, desktop user agent) |
| Chrome | 157 (current) | tablet | 157.0.8103.80 | automated | 2026-11-23 | passed (16/16) | tablet-sized window on Windows (no touch, desktop user agent) |
| Chrome | 156 (previous) | desktop, phone, tablet | — | not checked | — | not checked | No Chrome 156 can be installed beside the current one on this PC (Beta and Dev are newer, not previous). |
| Edge | 158 (current) | desktop | 158.0.4370.33 | automated | 2026-11-23 | passed (16/16) | |
| Edge | 158 (current) | phone | 158.0.4370.33 | automated | 2026-11-23 | passed (16/16) | phone-sized window on Windows |
| Edge | 158 (current) | tablet | — | not checked | — | not checked | The automated run checks tablets in Chrome and WebKit only (10b spec 14.1); Edge shares Chrome's engine. |
| Edge | 157 (previous) | desktop, phone, tablet | — | not checked | — | not checked | No Edge 157 can be installed beside the current one on this PC. |
| Firefox | 159 (current) | desktop | 159.0 (Playwright 1.65.1 build) | automated | 2026-11-23 | passed (16/16) | Playwright's patched build of Firefox, not the Mozilla release itself |
| Firefox | 159 (current) | phone | 159.0 (Playwright 1.65.1 build) | automated | 2026-11-23 | passed (16/16) | as above; phone-sized window on Windows |
| Firefox | 159 (current) | tablet | — | not checked | — | not checked | Tablets are checked in Chrome and WebKit only. |
| Firefox | 158 (previous) | desktop, phone, tablet | — | not checked | — | not checked | No Playwright release ships Firefox 158 (1.64.1 ships 157, 1.65.x ship 159). |
| Firefox | 157 (older than supported) | desktop, phone | 157.0 (Playwright 1.64.1 build) | automated | 2026-11-23 | passed (16/16, desktop and phone) | Not a supported version: recorded as evidence that the version below the previous one also works. |
| Safari (macOS) | current | desktop | awaiting the PO | by hand | — | not checked yet | `safari-check.md` |
| Safari (macOS) | previous | desktop | — | not checked | — | not checked | Only if a Mac on the previous macOS/Safari is available. |
| Safari (iOS) | current | phone | awaiting the PO | by hand | — | not checked yet | `safari-check.md` |
| Safari (iOS) | previous | phone | — | not checked | — | not checked | Only if an iPhone on the previous iOS is available. |
| Safari (iPadOS) | current | tablet | awaiting the PO | by hand | — | not checked yet | `safari-check.md` (if the PO has an iPad) |
| Safari (iPadOS) | previous | tablet | — | not checked | — | not checked | |
| WebKit engine, not Safari | 27.2 | desktop | 27.2 (Playwright 1.65.1 build) | automated | 2026-11-23 | passed (16/16) | Shows WebKit layout and script problems early; not a Safari result. |
| WebKit engine, not Safari | 27.2 | phone | 27.2 (Playwright 1.65.1 build) | automated | 2026-11-23 | passed (16/16) | as above |
| WebKit engine, not Safari | 27.2 | tablet | 27.2 (Playwright 1.65.1 build) | automated | 2026-11-23 | passed (16/16) | as above |

Defects the smoke run found and that were fixed before this result: every page load for anyone who is not a security reviewer asked `GET /security/cases` and was refused (403), and the first load asked for `/favicon.ico` (404); both were logged by the browsers as console errors. The header now asks `GET /security/me`, and the page names its tab icon.

A defect the smoke run showed that is **not fixed** in this result (recorded so the PO can decide): on phone-width screens (390 px) a proposal's details line runs into the "Report a suspected secret" link. The steps still passed: they check what is on screen, not the layout.

Not counted as a failure: before sign-in the page asks `GET /auth/me`, which answers 401; Chrome, Edge and Firefox log that answer as a console error by design.

## Build target

The web app is built by Vite 8.3.6 with its default target, `baseline-widely-available`, which Vite 8 sets to **Chrome 111, Edge 111, Firefox 114, Safari 16.4 and iOS 16.4** (for both the script and the CSS). Every supported version is above it:

| Browser | Oldest supported (previous major) | Build target | Below the target? |
|---|---|---|---|
| Chrome | 156 | 111 | no |
| Edge | 157 | 111 | no |
| Firefox | 158 | 114 | no |
| Safari (macOS, iOS, iPadOS) | the previous major (Safari 26 if the current is 27, as Playwright's WebKit 27.2 suggests; the PO's check records the exact versions) | 16.4 | no |

So the target is left at Vite's default (`app/web/vite.config.ts` does not set `build.target`). An iPhone or iPad that cannot update past iOS 16.3 is outside the supported versions; Kainow may not load there.

## Recording a new check

Add the run's date and rows above (or a new section per release), with the exact version string the browser reports, and link the `results/<date>.md` file. For the Safari check, copy the Product Owner's table into the Safari rows: device model, OS version, Safari version, date, and "passed" or the steps that failed.
