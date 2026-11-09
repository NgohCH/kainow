# Onboarding: organisation, logos and setup invitation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each installation registers its own organisation (name, domains, departments, optional wide and square logos) through a one-time setup invitation and an onboarding screen; until then only setup is open and Kainow's default name and logos are shown.

**Architecture:** A new `src/organisation/` module owns the organisation row, logos, branding, the setup invitation and the "set up first" gate. The gate lives in the existing `AuthGuard`, keyed by a new `@BeforeSetup()` route marker. Branding is decided on the server (which logo goes in which place) and read by the web app and the email composer, so the choice rule exists once.

**Tech Stack:** TypeScript, NestJS, PostgreSQL 16 (plain SQL migrations), nodemailer, React + Vite, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-v1-onboarding-design.md`

## Global Constraints

- No organisation's real name or domain anywhere committed; tests and demos use `example.com`, `example.org`, `*.test` and "Example Organisation".
- Default branding: name `Kainow`; default wide and square Kainow logos shipped as files with the product, never in the database.
- Gate refusal: **409** `Set up the organisation first.`
- Setup command closed message: `Setup is closed: an Enterprise Administrator already exists. Add Administrators from the Administrators screen.`
- Setup link messages: used → `This setup link has been used. Sign in instead.`; expired or superseded → `This setup link is no longer valid. Ask whoever installed Kainow to run the setup command again.`
- Setup invitation valid 7 days; one open at a time.
- Finish setup refusals: `Give the organisation a name.`, `Add at least one email domain.`, `Add at least one department.`
- Organisation name: NFC, whitespace collapsed, trimmed, 1–200 characters.
- Logos: PNG or JPEG by first bytes, ≤ 512 KB (524 288 bytes); square: |w−h| ≤ 2% of the larger side and ≥ 64×64; wide: 2 ≤ w/h ≤ 6 and h ≥ 40. Refusals: `Use a PNG or JPEG file.`, `A logo can be at most 512 KB.`, `A square logo must be square and at least 64 × 64 pixels.`, `A wide logo must be 2 to 6 times as wide as it is high and at least 40 pixels high.`
- Placement table (first choice → fallback): header square 32×32 → wide 96×32; tab icon square → square default; sign-in wide 160×56 → square 72×72; email and report wide 120×40 → square 48×48. The organisation's own logo of either shape beats a default.
- After setup: `The organisation needs at least one email domain.` / `The organisation needs at least one active department.`
- Every email: plain-text part opening with the organisation name; HTML part with the inline logo; closing `Sent by Kainow for <name>.` (before setup: defaults and `Sent by Kainow.`).
- Logo bytes never go into the audit log.
- The worker has no scheduled jobs yet; every email or analysis is started through the API, so the API gate covers spec §4's worker rule. A later sub-project adding scheduled jobs must check `OrganisationState.isRegistered()`.

## Review Focus

1. A request that reaches a gated route through an unusual method (HEAD, OPTIONS, a 404 route) before setup — must not leak data or crash; the gate applies to every route without `@BeforeSetup()`.
2. Two Administrators (upgraded install) pressing Finish setup at once — exactly one `organisation.registered` audit entry, no 500.
3. A logo upload with a correct PNG signature but a truncated header — refused with `Use a PNG or JPEG file.`, never a 500.
4. The setup command re-run with the same email after the first link was opened but before sign-in — the old link becomes superseded, the account is reused, not duplicated.
5. Branding read while a logo is being replaced — the image endpoint returns either the old or the new image with matching type, never a type mismatch.

Tests for each are named in Tasks 3, 3, 2, 5 and 4.

---

### Task 1: Records and the test app's organisation

**Files:**
- Create: `app/migrations/0016_organisation.sql`
- Modify: `app/src/db/migrate.test.ts` (`REAL_FILES` gains `'0016_organisation.sql'`)
- Modify: `app/src/testing/http.ts` (`startTestApp` option), `app/src/testing/projects.ts` (`seedOrganisation`)
- Modify: `app/src/projects/organisation.http.test.ts` (keep a second domain where it removes one; see Task 3)
- Test: `app/src/db/organisation-schema.test.ts`

**Interfaces:**
- Produces: tables `organisation(id smallint PK CHECK (id = 1), name text NOT NULL, registered_by uuid NULL REFERENCES users, registered_at timestamptz NULL, updated_by uuid NOT NULL REFERENCES users, updated_at timestamptz NOT NULL)` — the row is created on the first name save; `registered_at IS NOT NULL` means set up. `organisation_logos(shape text PK CHECK (shape IN ('wide','square')), content bytea NOT NULL, mime text NOT NULL CHECK (mime IN ('image/png','image/jpeg')), width int, height int, byte_size int CHECK (byte_size <= 524288), uploaded_by uuid, uploaded_at timestamptz)`. `setup_invitations(id uuid PK, user_id uuid NOT NULL REFERENCES users, email text NOT NULL, token_hash text NOT NULL UNIQUE, created_at, expires_at, accepted_at NULL, superseded_at NULL)` with `CREATE UNIQUE INDEX setup_invitations_one_open ON setup_invitations ((true)) WHERE accepted_at IS NULL AND superseded_at IS NULL`.
- Produces: `seedOrganisation(pool: Pool, name = 'Example Organisation'): Promise<void>` (inserts a registered row; `registered_by`/`updated_by` = the first Enterprise Administrator, creating `setup-admin@example.org` if none); `startTestApp(startAt?, opts?: { organisation?: boolean })`, default `true` → calls `seedOrganisation` after migrating.

- [ ] **Step 1: Write failing schema tests**: `a second organisation row is refused` (insert id 2 → SQLSTATE `23514`); `only one setup invitation may be open` (second open insert → `23505`; after setting `superseded_at` on the first, it succeeds); `a logo over 512 KB is refused` (`byte_size` 524289 → `23514`).
- [ ] **Step 2: Run** `npx tsc -p tsconfig.json && node --test dist/db/organisation-schema.test.js` — Expected: FAIL, relation "organisation" does not exist.
- [ ] **Step 3: Write the migration** and add it to `REAL_FILES`; add `seedOrganisation` and the `startTestApp` option.
- [ ] **Step 4: Run** the schema test and `node --test dist/db/migrate.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `Add records for the organisation, its logos and the setup invitation`.

### Task 2: Images, defaults and the placement rule

**Files:**
- Create: `app/src/organisation/image.ts`, `app/src/organisation/branding.ts`
- Create: `app/scripts/make-default-logos.mjs`, `app/assets/branding/kainow-wide.png` (240×80), `app/assets/branding/kainow-square.png` (128×128)
- Test: `app/src/organisation/image.test.ts`, `app/src/organisation/branding.test.ts`

**Interfaces:**
- Produces in `image.ts`: `type ImageInfo = { mime: 'image/png' | 'image/jpeg'; width: number; height: number }`; `readImage(buf: Buffer): ImageInfo | null` (PNG: signature + IHDR; JPEG: SOI then scan to SOF0–SOF15 except DHT/JPG/DAC markers C4, C8, CC; null on anything else or truncation); `checkLogo(shape: LogoShape, buf: Buffer): ImageInfo` throwing `BadRequestException` with the Global Constraints messages, size checked first.
- Produces in `branding.ts`: `type LogoShape = 'wide' | 'square'`; `type Place = 'header' | 'tab' | 'signIn' | 'email' | 'report'`; `type LogoSource = { shape: LogoShape; isDefault: boolean }`; `chooseLogo(place: Place, uploaded: { wide: boolean; square: boolean }): LogoSource & { box: { width: number; height: number } }` implementing the placement table; `DEFAULT_NAME = 'Kainow'`; `defaultLogo(shape): { content: Buffer; mime: 'image/png'; width; height }` reading the asset once.
- `make-default-logos.mjs` draws a flat geometric "K" mark (teal on white) with `node:zlib` and writes both PNGs; the PNGs are committed, the script kept for regeneration.

- [ ] **Step 1: Write failing tests**: `readImage` returns size for a 64×64 PNG and a 120×40 baseline JPEG (build both in the test with `node:zlib` / a minimal JFIF); returns null for an SVG text, a GIF, a PNG cut after 20 bytes (**Review Focus 3**). `checkLogo('square', …)` accepts 64×64 and 100×98, refuses 63×63, 100×90, and an SVG; `checkLogo('wide', …)` accepts 80×40 (exactly 2:1), 120×40 and 240×40 (exactly 6:1), refuses 79×40, 241×40 and 120×39; 524 289 bytes → `A logo can be at most 512 KB.` `chooseLogo` table: every place with `{wide,square}` in each of the four combinations, e.g. `header, {wide:true,square:false}` → `{shape:'wide', isDefault:false, box:{width:96,height:32}}`; `header, {false,false}` → `{shape:'square', isDefault:true, box:{32,32}}`; `signIn, {false,true}` → `{shape:'square', isDefault:false, box:{72,72}}`; `email, {false,false}` → `{shape:'wide', isDefault:true, box:{120,40}}`; `tab, {true,false}` → `{shape:'square', isDefault:true}`.
- [ ] **Step 2: Run** them — Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** `image.ts`, `branding.ts`; run the script to produce the assets; make sure `assets/` is copied into the Docker image (check `Dockerfile` COPY lines).
- [ ] **Step 4: Run** the tests — Expected: PASS; `readImage(defaultLogo('square').content)` is 128×128.
- [ ] **Step 5: Commit** `Read logo files safely and choose a logo for each place`.

### Task 3: The organisation, the gate and Finish setup

**Files:**
- Create: `app/src/organisation/organisation.service.ts`, `organisation.controller.ts`, `organisation.module.ts`, `app/src/organisation/state.ts`
- Modify: `app/src/auth/access.ts` (`BeforeSetup` marker), `app/src/auth/auth.guard.ts` (gate), `app/src/auth/auth.controller.ts` and `app/src/projects/organisation.controller.ts` (mark routes), `app/src/projects/organisation.service.ts` (last-domain and last-department guards), `app/src/app.module.ts`
- Test: `app/src/organisation/onboarding.http.test.ts`

**Interfaces:**
- Produces: `BEFORE_SETUP_KEY`, `BeforeSetup = () => SetMetadata(BEFORE_SETUP_KEY, true)`. `OrganisationState` (singleton) `isRegistered(): Promise<boolean>` caching `true` once seen; `markRegistered()`.
- Gate: in `AuthGuard.canActivate`, after the access lookup and before session resolution, if the route lacks `BeforeSetup` and `!(await state.isRegistered())` → `ConflictException('Set up the organisation first.')`. Marked `@BeforeSetup()`: all of `auth/*`, `GET/POST departments`, `POST departments/:id/rename`, `GET/POST domains`, `POST domains/:id/remove`, everything in the new controller, `GET setup/:token` (Task 5).
- Routes (new controller, `organisation.manage` unless stated): `GET /organisation` → `{ registered: boolean; name: string | null; logos: { wide: LogoMeta | null; square: LogoMeta | null } }` with `LogoMeta = { width; height; byteSize; uploadedAt }`; `POST /organisation/name {name}` → 200 `{ name }` (creates or renames; after registration audits `organisation.renamed {from,to}`); `POST /organisation/finish` → 200 `{ registered: true }`, checking name, ≥1 domain, ≥1 active department in that order and refusing 400 with the first missing message; runs in one transaction with `SELECT … FOR UPDATE` on the organisation row; when already registered returns 200 without a second audit entry; audits `organisation.registered`.
- Guards in the existing service: after registration, removing the last domain → 409 `The organisation needs at least one email domain.`; retiring the last active department → 409 `The organisation needs at least one active department.` Before registration both are allowed.

- [ ] **Step 1: Write failing HTTP tests** (start with `startTestApp(undefined, { organisation: false })`):
  - `before setup, project and note routes answer 409 Set up the organisation first.` (`GET /projects`, `POST /projects`, `GET /people`) while `POST /auth/request-code`, `GET /auth/me`, `GET /domains`, `POST /departments` work (**Review Focus 1**: also `HEAD /projects` → 409 and an unknown route → 404, not 500).
  - `Finish setup names what is missing` — with nothing: 400 `Give the organisation a name.`; after name: `Add at least one email domain.`; after domain: `Add at least one department.`; then 200 and `GET /projects` → 200.
  - `the name is cleaned and limited` — `'  Example   Organisation '` stored as `Example Organisation`; 201 chars → 400.
  - `two Finish setup requests at once register once` (**Review Focus 2**) — `Promise.all` of two finishes from two admins → both 200, one `organisation.registered` audit row.
  - `after setup the last domain and the last department stay` — the two 409 messages; with two domains, removing one succeeds.
  - `renaming after setup is audited with from and to`.
  - Update `organisation.http.test.ts` so its remove/re-add check keeps a second domain.
- [ ] **Step 2: Run** `node --test dist/organisation/onboarding.http.test.js` — Expected: FAIL (routes 404, no gate).
- [ ] **Step 3: Implement** the marker, gate, state, service, controller, guards; register the module in `AppModule`.
- [ ] **Step 4: Run** the new test, then `npm --prefix app test` — Expected: all PASS (existing tests start registered by default).
- [ ] **Step 5: Commit** `Keep everything closed until the organisation is set up`.

### Task 4: Logos and the public branding read

**Files:**
- Modify: `app/src/organisation/organisation.service.ts`, `organisation.controller.ts`; `app/src/bootstrap.ts` (raw body parser for `image/png` and `image/jpeg`, limit 600 KB, only on the logo route)
- Test: `app/src/organisation/logos.http.test.ts`

**Interfaces:**
- Consumes: `checkLogo`, `chooseLogo`, `defaultLogo`, `DEFAULT_NAME` (Task 2).
- Routes: `PUT /organisation/logos/:shape` (body = the file, `Content-Type: image/png|image/jpeg`; `organisation.manage`; `@BeforeSetup()`) → 200 `{ logo: LogoMeta }`, audit `organisation.logo_set {shape, byteSize, width, height}`; `POST /organisation/logos/:shape/remove` → 200, audit `organisation.logo_removed {shape}`; `GET /organisation/logos/:shape/preview` (admin) → the uploaded image regardless of registration, 404 if none.
- Public (`@Public() @BeforeSetup()`): `GET /organisation/branding` → `{ registered: boolean; name: string; places: Record<Place, { url: string; width: number; height: number; isDefault: boolean }> }` — before registration `name = 'Kainow'` and every place uses defaults even if logos are uploaded; `url` = `/organisation/logo/<shape>?v=<version>` where version is the upload time (or `default`). `GET /organisation/logo/:shape` → the image in use for that shape (uploaded and registered, else default) with `Content-Type`, `Cache-Control: no-cache`, `ETag` = version; 304 on a matching `If-None-Match`. Shape not `wide|square` → 404.
- Service: `letterhead(place: Place): Promise<{ name: string; registered: boolean; logo: { content: Buffer; mime: string; box: { width: number; height: number } } }>` — used by Task 6. Reads the logo row and its bytes in one query so type and bytes always match (**Review Focus 5**).

- [ ] **Step 1: Write failing tests**: upload refusals (each Global Constraints message, an SVG sent as `image/png`); `before Finish setup branding shows Kainow and defaults even with logos uploaded`; `after Finish setup the organisation name and uploaded logos replace the defaults, a missing shape keeps its default` (header with only wide → wide 96×32 not default; tab → square default); `removing a logo brings its default back`; `the image route serves what branding names, with a matching type` (**Review Focus 5**: replace the logo with a JPEG, then the route returns `image/jpeg` and the new ETag); `a member cannot upload a logo` (403); audit rows carry no bytes.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file, then the full suite — Expected: PASS.
- [ ] **Step 5: Commit** `Upload wide and square logos and serve the branding in use`.

### Task 5: The setup invitation, its command and the demo seed

**Files:**
- Create: `app/src/organisation/setup.service.ts`, `app/src/users/setup-invite-cli.ts`, `app/src/users/seed-demo-cli.ts`
- Delete: `app/src/users/create-admin-cli.ts`
- Modify: `app/package.json` (`setup-invite`, `seed-demo` scripts; remove `create-admin`), `app/src/auth/auth.service.ts` (mark the invitation accepted on sign-in), `app/src/auth/tokens.ts` (`CodeSender.sendSetupInvitation`), `app/src/auth/code-senders.ts` (log sender), `app/src/testing/fakes.ts` (`CaptureSender.setupInvitations`)
- Test: `app/src/organisation/setup.http.test.ts`

**Interfaces:**
- Produces: `CodeSender.sendSetupInvitation(email: string, link: string, expiresAt: Date): Promise<void>`.
- `SetupService.issue(input: { email: unknown; displayName: unknown }, at: Date): Promise<{ link: string; email: string }>` — refuses with the closed message when an **active** `enterprise_administrator` exists; in one transaction supersedes any open invitation (disabling its Invited account if its email differs), reuses or creates the Invited Enterprise Administrator for the email, stores `sha256(token)`, audits `setup.invitation_issued` (and `setup.invitation_superseded`); after commit sends the email. Link: `${APP_URL}/#/setup/<token>`, token 32 random bytes base64url.
- `SetupService.status(token: string, at: Date): Promise<{ state: 'valid' | 'used' | 'expired' | 'superseded'; email: string | null }>` behind `GET /setup/:token` (`@Public() @BeforeSetup()`); email returned only when `valid`.
- `AuthService.verify`: inside its existing transaction, after a successful code, `UPDATE setup_invitations SET accepted_at = $at WHERE user_id = $id AND accepted_at IS NULL AND superseded_at IS NULL AND expires_at > $at` and audit `setup.accepted` when a row changed.
- `setup-invite-cli.ts` usage `npm run setup-invite -- <email> "<display name>"`; prints `Setup invitation sent to <email>. It expires on <UTC time>.` (log delivery also prints the link via the sender).
- `seed-demo-cli.ts`: refused (`The demo seed needs an empty database.`) unless no users and no organisation row; creates Active admin `admin@example.com` "Demo Administrator", domain `example.com`, department `Operations`, registered organisation `Example Organisation`; prints `Demo data only: …`.

- [ ] **Step 1: Write failing tests**: `the first setup invitation is sent and its link is valid`; `signing in through it closes setup` (sign in as that email → `GET /setup/:token` → `used`; `issue` again → closed message); `re-running before acceptance supersedes the old link` (same email: one user row, old link `superseded`; different email: old Invited account `disabled`) (**Review Focus 4**); `an expired link says so` (advance clock 7 days + 1 s); `setup is closed once any Administrator is active` (seeded active admin → refused); `the demo seed refuses a non-empty database` (call the seed function, not the CLI).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; delete `create-admin-cli.ts`; update scripts.
- [ ] **Step 4: Run** the file and the full suite — Expected: PASS.
- [ ] **Step 5: Commit** `Create the first Administrator through a one-time setup invitation`.

### Task 6: Branded emails

**Files:**
- Create: `app/src/organisation/email.ts`
- Modify: `app/src/auth/code-senders.ts` (`SmtpCodeSender` composes every message through `composeEmail` with the `email` letterhead), the place that builds the sender (`bootstrap.ts` / module wiring) so the SMTP sender receives `() => organisation.letterhead('email')`
- Test: `app/src/organisation/email.test.ts`

**Interfaces:**
- Produces: `composeEmail(letterhead: Letterhead, subject: string, body: string): { subject: string; text: string; html: string; attachments: { filename: string; content: Buffer; contentType: string; cid: 'logo' }[] }`. Text = `<name>\n\n<body>\n\n<closing>`; HTML escapes the name and body (body paragraphs split on blank lines), shows `<img src="cid:logo" width height alt="<name>">` in the letterhead box, and the closing line (`Sent by Kainow for <name>.` when registered, `Sent by Kainow.` otherwise).
- `Letterhead` is the type returned by `letterhead(place)` in Task 4.

- [ ] **Step 1: Write failing tests**: registered letterhead → text starts with `Example Organisation\n\n`, ends `Sent by Kainow for Example Organisation.`, HTML contains `cid:logo` with width 120 height 40 and one attachment; unregistered → `Kainow` and `Sent by Kainow.`; a name with `<b>&` is escaped in HTML and unchanged in text.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; every `SmtpCodeSender` method (code, invitation, hold alert, setup invitation) builds its body text as now and sends `composeEmail(...)`. The log sender is unchanged.
- [ ] **Step 4: Run** the file and the full suite — Expected: PASS.
- [ ] **Step 5: Commit** `Put the organisation's name and logo on every email`.

### Task 7: The web app

**Files:**
- Create: `app/web/src/branding.ts` (fetch + types), `app/web/src/views/Onboarding.tsx`, `app/web/src/views/Setup.tsx`, `app/web/src/views/Letterhead.tsx` (logo + name block for a place)
- Modify: `app/web/src/App.tsx` (load branding; header; tab icon `<link rel="icon">` from `places.tab.url`; route `#/setup/<token>`; admins on an unregistered install see only `Onboarding`, others `Kainow is being set up. Try again later.` with Sign out), `app/web/src/views/Organisation.tsx` (name and the two logos after setup), `app/web/src/styles.css`
- Test: `app/web/src/branding.test.ts`

**Interfaces:**
- Consumes: `GET /organisation/branding`, `GET /organisation`, `POST /organisation/name`, `PUT/POST …/logos/:shape…`, `GET …/preview`, `POST /organisation/finish`, `GET /setup/:token`, existing domain and department routes.
- `branding.ts`: `type Branding` mirroring Task 4; `logoUploadError(file: { type: string; size: number }): string | null` (client-side early check: type not PNG/JPEG → `Use a PNG or JPEG file.`; size > 524 288 → `A logo can be at most 512 KB.`; the server stays the authority).
- `Letterhead({ branding, place })` renders `<img alt={name}>` at the place's box with `object-fit: contain`, then the name; header order: logo, name, Kainow wordmark, navigation. Sign-in shows logo, name, "Sign in to Kainow".
- Onboarding: four sections (name, domains, departments, logos with previews in header, sign-in and email boxes) and **Finish setup**; server refusals shown in `role="alert"`.
- Setup page: shows the state message for `used`, `expired`, `superseded`; for `valid`, the sign-in form with the email pre-filled.

- [ ] **Step 1: Write failing test** for `logoUploadError` (svg, gif, 524 289-byte PNG, valid JPEG → null).
- [ ] **Step 2: Run** `npm --prefix app/web test` — Expected: FAIL.
- [ ] **Step 3: Implement** the helper and the views.
- [ ] **Step 4: Run** `npm --prefix app/web test` and `npm --prefix app/web run build` — Expected: PASS, build succeeds.
- [ ] **Step 5: Commit** `Show the organisation's branding and add the onboarding and setup screens`.

### Task 8: Docs, accessibility, the Docker walk-through and the Decision Register

**Files:**
- Modify: `README.md`, `app/README.md`, `INSTALL.md` (setup-invite replaces create-admin; onboarding steps; demo seed), `tests/a11y/audit.mjs` and `tests/a11y/README.md` (start from `setup-invite`, audit the setup page, the onboarding screen empty and filled, and the header and sign-in with wide-only, square-only and both logos), `docs/Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md` (D71 from spec §11, appended to the §14 register table)

- [ ] **Step 1:** Update the docs and the audit.
- [ ] **Step 2: Run** the accessibility audit on a scratch database — Expected: `TOTAL violations: 0`.
- [ ] **Step 3: Walk through** in Docker: (a) upgrade the existing install → the Administrator meets onboarding, finishes, lands on My Projects; (b) fresh database → `setup-invite` → link → sign in → onboarding → My Projects; the sign-in page shows defaults before and the organisation after. Record both in the ledger.
- [ ] **Step 4: Run** `npm --prefix app test` and `npm --prefix app/web test` — Expected: all PASS.
- [ ] **Step 5: Commit** `Document onboarding and add it to the accessibility pass`.
