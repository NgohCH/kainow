# V1.0 Sub-project 9: External Outputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the output register, DOCX/PDF/Markdown/CSV generation, project exports, SharePoint/OneDrive filing with folder sharing and checks, the A13 managed source area, and owning-department transfer.

**Architecture:** A provider-neutral `StorageConnector` contract (`app/src/storage/`) with a Microsoft Graph connector and a development-only local connector; all storage side effects run as durable pg-boss jobs on a new `storage` queue, fed by a transactional `storage_outbox`. Outputs (`app/src/outputs/`) build on D77 drafts, the existing `change_requests` approval machinery, `audiences`, `onMaterialRemoved` and the quarantine registry.

**Tech Stack:** NestJS 12, PostgreSQL 16, pg-boss 12, node:test, React 19/Vite; new dependencies `marked`, `docx`, `pdfkit` (exact pinned versions).

**Spec:** `docs/superpowers/specs/2026-11-20-v1-external-outputs-design.md` (approved 20 November 2026). Section references below (§n) are to that spec. Read it before any task.

## Global Constraints

- Migration file is `app/migrations/0031_external_outputs.sql`. Never edit 0001–0030.
- Decision Register IDs D100–D108; Configuration Catalogue IDs C85–C92.
- Test database: `postgres://postgres:test@127.0.0.1:15432/kainow_test_sp9` in container `kainow-testdb`; create with `CREATE DATABASE kainow_test_sp9` if missing. Set `KAINOW_TEST_DATABASE_URL` to it. Never use `kainow_test` or `kainow_test_sp8`.
- Focused test run (from `app/`): `npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/<path>.test.js`. Full server suite `npm test` takes over 10 minutes: run it in the background. Web: `npm test` in `app/web`.
- No real organisation names or domains anywhere (code, tests, docs, fixtures). Test accounts only `*@example.org|com|net` or `*@kainow.test`.
- Never print or open `.env` files, API keys or the protected key file. Never use git stash.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every listed order comes from a stable `ORDER BY` that never ends on a uuid alone where order is visible to people (use names, times, then id).
- Any test whose only pending work is an `AbortSignal.timeout` keeps `const keepAlive = setInterval(() => undefined, 1_000)` alive in `try/finally` (Node 22 Linux CI).
- Secrets (client secret, tokens) never appear in logs, audit `detail`, event rows, job data, responses, errors or notices. Request bodies of secret endpoints are never logged or echoed.
- Nothing is reported filed, stored, moved or relinked until the provider confirms it and size plus QuickXorHash match.
- Kainow grants only on folders, only read (outputs) or write (storage Administrators on the source area), and only ever revokes permissions recorded in `storage_grants`.
- All dates UTC+8 (`todayUtc8`); file names and folder names made safe by one helper (`safeName`, Task 11).
- Plain-English UI copy exactly as quoted in the spec where the spec quotes it.
- Every new plain-text column is registered in `app/src/quarantine/registry.ts` (`TEXT_COLUMNS`) or listed in `NO_USER_TEXT` with a reason; every new `writeAudit` action and event-table CHECK value is added to `app/src/analytics/catalogue.ts`. Their completeness tests must pass at the end of every task that adds either.
- Sub-project 8 edits `matrix.ts`, `permissions.ts`, `analytics/catalogue.ts`, `quarantine/registry.ts`, web `App.tsx`, `ProjectPage.tsx` and the 0030 `change_requests` CHECKs concurrently: add rows, never reorder or reformat existing ones.

## Review Focus

1. **A person losing access while a sharing job is failing** (Microsoft throttling or down): they must lose the output in Kainow at once and the files must leave the shared project folder before anything else; the failing move must be listed under "Sharing to repair". Test added to Task 13 (`narrowing with a failing move keeps output hidden and listed to repair`).
2. **Two people submit or file the same output version at the same moment / a job retried after a lost reply**: exactly one stored file, never `v1 (2)` for the same version. Test added to Task 12 (`concurrent file requests produce one stored file`).
3. **Titles with SharePoint-illegal characters, Malay diacritics, emoji or 300 characters**: filing succeeds with a safe name under the 400-character path limit, and the register still shows the original title. Test added to Task 11 (`safeName handles illegal characters, diacritics, emoji and length`).
4. **A project whose only Owner is also the PM approving their own output under a two-approval policy**: the existing distinct-people rule applies, no double count. Test added to Task 14 (`combined PM-Owner counts once toward a two-approval policy`).
5. **The protected key file missing or replaced after storage was configured**: storage jobs wait as `waiting_for_key`, Kainow keeps working, nothing is marked failed, and the Storage page says why. Test added to Task 6 (`jobs wait without protected key and resume when it returns`).

---

## File structure

```
app/migrations/0031_external_outputs.sql                 schema (Task 1)
app/src/storage/
  types.ts            StorageError, refs, results (Task 2)
  connector.ts        StorageConnector interface (Task 2)
  quickxor.ts         quickXorHash (Task 2)
  connectors/local.ts LocalConnector (Task 2)
  connectors/contract-suite.ts  shared contract tests, run by local and graph tests (Task 2)
  connectors/graph.ts GraphConnector (Task 3)
  secret.ts           sealStorageSecret / openStorageSecret (Task 4)
  settings.ts         loadStorageSettings, validation (Task 4)
  settings.service.ts, storage.controller.ts, storage.module.ts (Task 4, extended later)
  destinations.service.ts (Task 5)
  connector-factory.ts STORAGE_CONNECTORS token + factory (Task 5)
  outbox.ts, jobs.ts, retry.ts, storage-worker.ts (Task 6)
  sources.ts          storeSourceVersion, backfillSources (Task 7)
  source-files.ts     openOriginal, checkSourceFiles (Task 8)
  withhold.ts         withholdStoredFile, restoreWithheld (Task 17)
  admins.service.ts   storage Administrators (Task 19)
  relocate.ts, manifest.ts (Task 20)
  summary.service.ts  Storage page summary (Task 23)
  probe-storage-cli.ts, bench-cli.ts (Task 26)
app/src/testing/fake-graph.ts                            (Task 3)
app/src/outputs/
  render/blocks.ts, render/markdown.ts, render/docx.ts, render/pdf.ts, render/header.ts (Task 10)
  report-types.service.ts, output-settings.service.ts, formats.ts (Task 9)
  readers.ts, outputs.service.ts, outputs.controller.ts, outputs.module.ts (Task 11)
  naming.ts, filing.ts (Tasks 11–12)
  sharing.ts (Task 13)
  approval-handler.ts (Task 14)
  audience.ts, removal.ts (Task 15)
  checks.ts (Task 16)
  holds.ts (Task 17)
  exports.ts, exports.controller.ts (Task 18)
app/src/projects/department-transfer.service.ts (Task 21)
app/assets/fonts/NotoSans-{Regular,Bold,Italic}.ttf + OFL.txt (Task 10)
app/web/src/views/{StorageSettings,ReportTypes,ProjectOutputs,OutputPage,ProjectOutputSettings}.tsx, app/web/src/outputs.ts, app/web/src/storage.ts (Tasks 24–25)
```

---

### Task 1: Migration 0031 and registry baseline

**Files:**
- Create: `app/migrations/0031_external_outputs.sql`
- Modify: `app/src/quarantine/registry.ts` (register new text columns; add item kind `output`), `app/src/analytics/catalogue.ts` (new event CHECK values), `app/src/changes/handlers.ts` (`TargetKind` adds `'output_version'`), `app/src/changes/rules.ts` (`ChangeKind` adds `'approve_output'`), `app/src/changes/changes.service.ts` (`TARGET_KINDS`, `TARGET_SQL` entry for `output_version`)
- Test: `app/src/storage/migration.test.ts`

**Interfaces:**
- Produces: every table and column in spec §13.1 exactly as sketched there, plus: `storage_settings.directory_lookup`; `storage_grants` folder-only with unique live index; `source_versions.original_stored_file_id`, `text_stored_file_id`; `access_settings.project_exports_allowed boolean NOT NULL DEFAULT false`; `golive_steps` row (`'storage'`, position 12); `report_types` seeded in this order: Status reports, Decisions and actions, Risk summaries, Specifications, Minutes, Exports, Other (positions 1–7).
- Produces: `ItemKind` gains `'output'`; `TargetKind` gains `'output_version'`; `ChangeKind` gains `'approve_output'`.

- [ ] **Step 1: Create the test database** (once): `docker exec kainow-testdb psql -U postgres -c "CREATE DATABASE kainow_test_sp9"` (ignore "already exists"), and export `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:15432/kainow_test_sp9`.

- [ ] **Step 2: Write the failing test** `app/src/storage/migration.test.ts`:
  - `migration 0031 creates the storage and output tables` — after `runMigrations`, each of `report_types, storage_settings, storage_settings_changes, storage_connection_secrets, storage_destinations, storage_destination_events, storage_folders, stored_files, stored_file_moves, storage_outbox, storage_attempts, storage_grants, storage_admins, storage_admin_events, project_output_settings, project_output_settings_changes, outputs, output_categories, output_contributors, output_versions, output_version_bytes, output_events, project_department_transfers` exists.
  - `seeds report types and storage settings` — `report_types` names ordered by position equal the seven above; `storage_settings` has one row with `approved_input_formats = {txt,md,docx,pdf}`, `approved_output_formats = {md,docx,pdf,csv}`, `directory_lookup = false`, `scheduled_checks = false`; `access_settings.project_exports_allowed = false`.
  - `only one approved source area` — inserting two `storage_destinations` rows with purpose `source_area`, status `approved` fails with unique violation.
  - `append-only event tables` — UPDATE on `output_events`, `storage_destination_events`, `stored_file_moves`, `storage_admin_events`, `storage_settings_changes`, `project_output_settings_changes` raises.
  - `output_versions content is immutable` — UPDATE of `sha256` or `version_no` raises; UPDATE of `status`, `stored_file_id`, `approval_request_id`, `held_case_id` succeeds.
  - `change_requests accepts approve_output on output_version` — insert succeeds; and the CHECK still accepts every kind and target from 0017–0030 present in the database at migration time (read the existing list from `pg_constraint` before 0031 in the test's own fresh run and assert it is a subset afterwards).
  - `upload versions may hold bytes or a stored file` — an `origin='upload'` version with `original_bytes NULL` and `original_stored_file_id` set is accepted; with both NULL and `quarantined_at` NULL it is refused.
  - `go-live has the storage step at position 12`.

- [ ] **Step 3: Run it to verify it fails**: `npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/storage/migration.test.js` → FAIL (relations missing).

- [ ] **Step 4: Write `0031_external_outputs.sql`** following spec §13.1, the project's append-only trigger style (see `0029_dashboards.sql`), and §13.3: drop and re-add the `change_requests` kind and target CHECKs as the union of the values present in the migrated database (read them in the migration with a `DO` block from `pg_constraint`, add `approve_output` / `output_version`, re-create), so it is correct whether or not sub-project 8's 0030 has run.

- [ ] **Step 5: Register the new text columns** in `registry.ts` (titles, reasons, labels, names, paths, folder names, check details; `output_version_bytes.bytes` as `binary`), add item kind `output` with `ITEM_PROJECT.output` and its `itemSql`, and add the new event CHECK values and tables to `analytics/catalogue.ts`.

- [ ] **Step 6: Run** the new test plus `dist/quarantine/registry.db.test.js` and `dist/analytics/catalogue.db.test.js` → all PASS.

- [ ] **Step 7: Commit** `feat(storage): migration 0031 for outputs, storage and source area`.

---

### Task 2: Connector contract, QuickXorHash and the local connector

**Files:**
- Create: `app/src/storage/types.ts`, `app/src/storage/connector.ts`, `app/src/storage/quickxor.ts`, `app/src/storage/connectors/local.ts`, `app/src/storage/connectors/contract-suite.ts`
- Test: `app/src/storage/quickxor.test.ts`, `app/src/storage/connectors/local.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `type StorageErrorCode = 'unreachable'|'timeout'|'throttled'|'unauthorised'|'forbidden'|'not_found'|'conflict'|'too_large'|'quota'|'server'|'invalid'|'unsupported'`
  - `class StorageError extends Error { code; status?: number; retryAfterMs?: number }` — message is a fixed text per code, never provider text.
  - `interface DestinationRef { id: string; connector: 'graph'|'local'; driveId: string; rootItemId: string }`
  - `interface StoredRef { itemId: string; parentId: string; name: string; path: string; size: number; providerHash: string|null; etag: string|null; ctag: string|null; webUrl: string|null }`
  - `type ItemState = StoredRef`
  - `interface FolderRef { itemId: string; name: string }`
  - `interface ItemVersion { id: string; size: number; providerHash: string|null; modifiedAt: string }`
  - `interface PermissionInfo { id: string; kind: 'owner_group'|'site_admin'|'app'|'user'|'group'|'link'; principal: string; roles: string[] }`
  - `type GrantResult = { permissionId: string } | { notFound: true }`
  - `interface DestinationCheck { ok: boolean; lines: Array<{ key: 'reachable'|'folder'|'upload'|'delete'|'permissions'|'library_permissions'|'sharing_capability'; ok: boolean; detail: string }>; quotaBytes: number|null; usedBytes: number|null; others: PermissionInfo[] }`
- Produces (`connector.ts`): `interface StorageConnector` exactly as spec §5.1 (`checkDestination, ensureFolder, upload, findChild, getItem, download, move, copyTo, removePermanently, listVersions, restoreVersion, lookupPerson, grant, revoke, listPermissions, resolveLink`), `kind: 'graph'|'local'`. `ensureFolder(dest, parentId | null, name)` with `null` meaning the destination root.
- Produces: `quickXorHash(bytes: Buffer): string` (base64, Microsoft's QuickXorHash).
- Produces: `class LocalConnector implements StorageConnector { constructor(rootDir: string, opts?: { lookup?: Record<string,'account'|'not_found'> }) }` storing files under `rootDir/<driveId>/…`, item ids as stable random ids in a JSON index, versions kept on overwrite, grants and permissions in a JSON sidecar; `removePermanently` deletes the file and its versions.
- Produces: `runContractSuite(name: string, make: () => Promise<{ connector: StorageConnector; dest: DestinationRef; seedPermission(itemId: string, p: Omit<PermissionInfo,'id'>): Promise<string>; close(): Promise<void> }>): void` — registers node:test cases.

- [ ] **Step 1: Write failing tests.**
  - `quickxor.test.ts`: `quickXorHash of empty buffer is AAAAAAAAAAAAAAAAAAAAAAAAAAA=`; `quickXorHash matches published vectors` (use the vectors from Microsoft's QuickXorHash documentation for `"abc"` and a 1,000-byte buffer; copy them into the test as constants with a comment naming their source); `hash is stable across chunk boundaries` (hashing 160 KiB in one call equals the incremental API fed 7-byte chunks).
  - `contract-suite.ts` cases (each runs against `make()`): `ensureFolder creates once and returns the same item for the same name`; `upload returns size and provider hash equal to quickXorHash`; `upload with conflict fail rejects an existing name with code conflict`; `findChild returns null for a missing name`; `getItem reflects move and rename with the same itemId`; `download returns the exact bytes`; `copyTo across destinations preserves bytes`; `removePermanently leaves no version to restore`; `listVersions and restoreVersion bring back earlier content`; `grant on a folder returns a permission id and listPermissions shows it`; `revoke removes only that permission` (a seeded owner_group and group permission survive); `lookupPerson returns not_found for an unknown address`.
  - `local.test.ts`: `runContractSuite('local', …)` in a temp dir.

- [ ] **Step 2: Run** `dist/storage/quickxor.test.js dist/storage/connectors/local.test.js` → FAIL.

- [ ] **Step 3: Implement** `types.ts`, `connector.ts`, `quickxor.ts` (incremental class `QuickXorHasher { update(b: Buffer): void; digest(): string }` plus `quickXorHash`), `LocalConnector`, `contract-suite.ts`.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(storage): connector contract, QuickXorHash and local connector`.

---

### Task 3: Fake Graph server and the Graph connector

**Files:**
- Create: `app/src/testing/fake-graph.ts`, `app/src/storage/connectors/graph.ts`
- Modify: `app/src/email/m365-token.ts` (constructor takes `scope`; email passes `https://outlook.office365.com/.default`)
- Test: `app/src/storage/connectors/graph.test.ts`, existing `app/src/email/*.test.ts` keep passing

**Interfaces:**
- Consumes: Task 2 types and `runContractSuite`.
- Produces: `M365TokenSource(cfg, fetchFn?, clock?, timeoutMs?, scope = 'https://outlook.office365.com/.default')` — new last parameter, existing callers unchanged.
- Produces: `class GraphConnector implements StorageConnector { constructor(tokens: { token(): Promise<string> }, opts: { fetchFn?: typeof fetch; graphBase?: string; lookup: boolean; allowedDomains: () => Promise<string[]>; callTimeoutMs?: number; chunkTimeoutMs?: number }) }`. Defaults: `graphBase = 'https://graph.microsoft.com/v1.0'`, 30 s per call, 120 s per chunk, 4 MiB simple-upload threshold, 5 MiB (16 × 320 KiB) chunks.
- Produces: `resolveSharePointLibrary(siteUrl: string, libraryName: string): Promise<{ siteId: string; driveId: string; rootItemId: string }>` and `resolveOneDrive(email: string, folderPath?: string)` as methods on `GraphConnector` (used by Task 5).
- Produces: `startFakeGraph(): Promise<FakeGraph>` with `{ graphBase: string; tokenUrl: string; fetch: typeof fetch; addDrive(opts?): { driveId: string; rootItemId: string; siteId: string }; addUser(email: string, opts?: { userType?: 'Member'|'Guest'; enabled?: boolean }): void; seedPermission(driveId, itemId, p): string; fault(match: { method?: string; pathIncludes: string }, kind: 'timeout'|'drop_after_body'|'429'|'503'|'401'|'403'|'404'|'500', times?: number): void; changeContent(driveId, itemId, bytes: Buffer): void; moveItem(driveId, itemId, newParentId, newName?): void; deleteItem(driveId, itemId): void; calls: Array<{ method: string; path: string }>; recycleBin(driveId): string[]; close(): Promise<void> }`. It implements every call in spec §5.3, `@microsoft.graph.conflictBehavior`, upload sessions with 320 KiB-multiple enforcement, `file.hashes.quickXorHash`, `copy` with a monitor URL, `permanentDelete` (no recycle bin, no versions) vs `DELETE` (recycle bin), versions on overwrite, `invite` returning 404-style error for unknown users, and `GET /users/{email}` returning `userType` and `accountEnabled`.

- [ ] **Step 1: Write failing tests** in `graph.test.ts`:
  - `runContractSuite('graph', …)` against the fake server (token URL pointed at the fake).
  - `token request uses the Graph scope` — the fake records `scope=https://graph.microsoft.com/.default`.
  - `uploads above 4 MiB use an upload session in 5 MiB chunks` — `calls` shows `createUploadSession` and chunk PUTs; hash matches.
  - `429 maps to throttled with retryAfterMs from Retry-After`; `401 → unauthorised`; `403 → forbidden`; `404 → not_found`; `503 → server`; network drop → `unreachable`; slow reply → `timeout` (keep-alive interval).
  - `upload with dropped reply leaves the file findable by findChild` — `drop_after_body` fault, then `findChild` returns the item with the same hash.
  - `lookupPerson with lookup on: member → account, guest → not_found, disabled → not_found, unknown → not_found`.
  - `lookupPerson with lookup off returns unknown and makes no call`.
  - `grant refuses an address outside allowed domains with lookup off` — returns `{ notFound: true }` and no invite call is made.
  - `grant invites with requireSignIn true and sendInvitation false and roles read`.
  - `no error message or log contains the bearer token` — capture every thrown `StorageError.message` across the fault cases and assert none contains the fake token.
  - `listPermissions classifies owner group, site admin, app, user, group and link`.

- [ ] **Step 2: Run** `dist/storage/connectors/graph.test.js` → FAIL.

- [ ] **Step 3: Implement** `fake-graph.ts`, the `scope` parameter, and `GraphConnector` (one private `call(method, path, body?, { timeoutMs })` that maps statuses to `StorageError`, never includes response text).

- [ ] **Step 4: Run** graph tests and `dist/email/*.test.js` → PASS.

- [ ] **Step 5: Commit** `feat(storage): Microsoft Graph connector and fake Graph server`.

---

### Task 4: Storage connection settings and secret sealing

**Files:**
- Create: `app/src/storage/secret.ts`, `app/src/storage/settings.ts`, `app/src/storage/settings.service.ts`, `app/src/storage/storage.controller.ts`, `app/src/storage/storage.module.ts`
- Modify: `app/src/app.module.ts` (import `StorageModule`), `app/src/auth/permissions.ts` (action `storage.manage` for enterprise_administrator)
- Test: `app/src/storage/settings.http.test.ts`, `app/src/storage/secret-imports.test.ts`

**Interfaces:**
- Consumes: `ProtectedKey` (`PROTECTED_KEY`), `GraphConnector`, `M365TokenSource`.
- Produces: `sealStorageSecret(key: ProtectedKey, secret: string, connectionId: string): Sealed & { keyId: string }`, `openStorageSecret(key: ProtectedKey, sealed: Sealed & { keyId: string }, connectionId: string): string` with AAD `kainow.storage-secret:<connectionId>`; throws `StorageSecretUnreadable`. The connection id is the constant `'storage'` (single connection).
- Produces: `interface StorageSettings { tenantId: string|null; clientId: string|null; hasSecret: boolean; approvedInputFormats: InputFormat[]; approvedOutputFormats: OutputFormat[]; projectsMayChangeFormats: boolean; projectsMayChooseDestination: boolean; projectsMaySetExportRoles: boolean; directoryLookup: boolean; scheduledChecks: boolean }`, `loadStorageSettings(db): Promise<StorageSettings>`, `type InputFormat = 'txt'|'md'|'docx'|'pdf'`, `type OutputFormat = 'md'|'docx'|'pdf'|'csv'`.
- Produces endpoints: `GET /admin/storage` (settings + connection state), `PUT /admin/storage` (`{ reason, …non-secret fields }`), `POST /admin/storage/secret` (`{ reason, clientSecret }`), `POST /admin/storage/check` → `{ state: 'connected'|'refused'|'unreachable'|'not_configured'|'protected_key_missing' }`.
- Produces: `StorageCredentials` provider `storageTokenSource(pool, key): Promise<M365TokenSource | null>` (null when not configured or no key).

- [ ] **Step 1: Write failing tests** (`settings.http.test.ts`, using `startTestApp` with a protected key file from `testing/ai-runners.ts`):
  - `only an Enterprise Administrator reads or changes storage settings` (member → 403).
  - `changes need a reason and record previous and next without the secret` — `storage_settings_changes` row; `writeAudit` `storage.connection_changed`; grep of the row JSON, every audit row and the response for the secret finds nothing.
  - `secret is sealed, never returned and replaced append-only` — `GET` shows `hasSecret: true` and no secret field; second save supersedes the first row.
  - `secret save refused without protected key` with the exact text "Storage credentials cannot be saved until the protected key is installed. See INSTALL.md."
  - `secret length 10–200 printable characters` (9 and 201 refused).
  - `check connection reports connected, refused and unreachable` against the fake Graph server (token 200, token 401, fake closed).
  - `turning directory lookup on runs a lookup of the Administrator's own address`; `turning it off is refused while an OneDrive destination is approved` (insert one directly).
  - `approved formats must keep at least one input format`.
  - `secret-imports.test.ts`: `only the connector factory and the connection check import openStorageSecret` (scan `dist/**/*.js` like `ai/key-imports.test.ts`).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** the files above; the controller never logs bodies (follow `ai/connections.controller.ts`).

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(storage): storage connection settings with sealed secret`.

---

### Task 5: Destinations and the connector factory

**Files:**
- Create: `app/src/storage/destinations.service.ts`, `app/src/storage/connector-factory.ts`
- Modify: `app/src/storage/storage.controller.ts`, `app/src/storage/storage.module.ts`, `app/src/testing/http.ts` (`startTestApp` option `storageConnectors?: StorageConnectorFactory`)
- Test: `app/src/storage/destinations.http.test.ts`

**Interfaces:**
- Produces: `const STORAGE_CONNECTORS = Symbol('STORAGE_CONNECTORS')`, `interface StorageConnectorFactory { forDestination(destinationId: string): Promise<{ connector: StorageConnector; dest: DestinationRef }>; forNew(kind: 'sharepoint_library'|'onedrive'|'local'): Promise<StorageConnector> }` — throws `StorageError('invalid')` when not configured, `StorageWaitingForKey` when the protected key is missing.
- Produces: `class DestinationsService { add(user, input: { kind; purpose: 'source_area'|'outputs'; label; siteUrl?; libraryName?; accountEmail?; folderPath?; reason }): Promise<Destination>; check(user, id): Promise<DestinationCheck>; approve(user, id, reason): Promise<Destination>; withdraw(user, id, reason): Promise<Destination>; list(): Promise<Destination[]> }` (list ordered by purpose, lower(label), id).
- Produces: `libraryPermissionProblems(perms: PermissionInfo[], allowed: { storageAdminUserEmails: string[]; kainowGrantPermissionIds: Set<string> }): PermissionInfo[]` — everything except `owner_group`, `site_admin`, `app` and Kainow's own grants (and, for the source area, storage Administrators).
- Endpoints: `GET/POST /admin/storage/destinations`, `POST /admin/storage/destinations/:id/{check,approve,withdraw}`.
- The local connector is chosen by the factory for destinations with `connector = 'local'`, rooted at `KAINOW_LOCAL_STORAGE_DIR`; adding one through the API is allowed only when `NODE_ENV !== 'production'` and the variable is set.

- [ ] **Step 1: Write failing tests:**
  - `adding a SharePoint library resolves its ids and runs the check` (fake Graph).
  - `OneDrive destinations are refused while directory lookup is off`.
  - `approval requires a passing check and a reason`.
  - `a library readable by a Members group is refused with the exact text` "Others can open everything in this library: <who>. Limit the library to site owners before approving it." — also for a named user and an organisation sharing link; an owner group and site admin alone pass.
  - `only one approved source area` → 409 with a clear message on the second.
  - `withdrawing keeps stored files and their references` (seed a `stored_files` row; still there, destination `withdrawn`).
  - `events recorded for proposed, checked, approved, withdrawn`.
  - `the local connector is never offered when NODE_ENV is production` (factory `forNew('local')` throws `invalid`).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(storage): approved destinations with library permission check`.

---

### Task 6: Storage jobs: outbox, queue, retries and worker

**Files:**
- Create: `app/src/storage/outbox.ts`, `app/src/storage/jobs.ts`, `app/src/storage/retry.ts`, `app/src/storage/storage-worker.ts`
- Modify: `app/src/worker/queues.ts` (`QUEUES.storage = 'storage'`), `app/src/worker/main.ts` (register worker), `app/src/worker/schedules.ts` (one-minute outbox tick and the 02:30 UTC+8 daily storage tick)
- Test: `app/src/storage/jobs.db.test.ts`, `app/src/storage/retry.test.ts`

**Interfaces:**
- Produces: `type StorageJob = 'file-output'|'store-source'|'share-sync'|'place-output'|'check'|'register-changed'|'relocate'|'withhold'|'restore-withheld'|'backfill-sources'`.
- Produces: `queueStorageJob(c: PoolClient, job: StorageJob, subjectId: string, opts?: { priority?: 'urgent'|'normal' }): Promise<void>` (inserts `storage_outbox`); `sendStorageOutbox(pool, boss): Promise<number>` (sends unsent rows with `singletonKey = job:subjectId`, `retryLimit: 4`, marks `sent_at`).
- Produces: `retryDelayMs(failedAttempts: number, retryAfterMs?: number): number` — 60_000, 300_000, 1_800_000, 7_200_000 measured from the first failure (so delays between attempts are 1 min, 4 min, 25 min, 90 min), the later of that and `retryAfterMs`.
- Produces: `type StorageHandler = (deps: StorageDeps, subjectId: string, attempt: number) => Promise<void>`; `registerStorageHandler(job, handler)`; `registerStorageWorker(boss, deps: StorageDeps)` with `localConcurrency: 2`; `interface StorageDeps { pool: Pool; connectors: StorageConnectorFactory; key: ProtectedKey | null; clock: Clock; notify: (c: PoolClient, n: StorageNotice) => Promise<void> }`.
- Behaviour: a handler throwing `StorageError` with code `unauthorised|forbidden|invalid|too_large` is final (marks the subject failed through `onFinalFailure(job, subjectId, code)` hooks the subject modules register); others re-send with `startAfter = retryDelayMs`; `StorageWaitingForKey` re-sends after 5 minutes without counting an attempt. Each attempt writes `storage_attempts` (job, subject, outcome, provider status, duration).

- [ ] **Step 1: Write failing tests:**
  - `retry.test.ts`: `retryDelayMs schedule is 1, 5, 30 and 120 minutes after the first failure`; `Retry-After later than the schedule wins`.
  - `jobs.db.test.ts` (pg-boss on the test database, a stub handler): `outbox row written in the caller's transaction is not sent if it rolls back`; `outbox tick sends each row once`; `temporary failure retries then succeeds`; `final failure codes are not retried and call onFinalFailure`; `attempts are recorded without names or content` (detail columns only); **`jobs wait without protected key and resume when it returns`** (Review Focus 5: factory throws `StorageWaitingForKey`; job re-sent, attempt count unchanged, subject not failed; after a key is provided the next run succeeds).
  - `urgent jobs are sent with higher priority`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/worker/*.test.js`.

- [ ] **Step 5: Commit** `feat(storage): durable storage jobs with outbox and bounded retries`.

---

### Task 7: Managed source area: storing source versions

**Files:**
- Create: `app/src/storage/sources.ts`
- Modify: `app/src/notes/notes.service.ts` (`insertVersion` adds `stored_files` rows and outbox), every other `source_versions` writer found by `grep -rn "INSERT INTO source_versions" app/src` (minutes publication, meetings, summaries), `app/src/notes/notes.controller.ts` / service read model (version `storage: 'stored'|'waiting'|'failed'|null`, non-null only for PM/Deputy/Owner/Sponsor)
- Test: `app/src/storage/sources.db.test.ts`, `app/src/storage/sources.http.test.ts`

**Interfaces:**
- Consumes: Task 6 `queueStorageJob`, `registerStorageHandler`.
- Produces: `addSourceVersionFiles(c: PoolClient, versionId: string, projectId: string, hasOriginal: boolean): Promise<void>`; handler `store-source` = `storeSourceVersion(deps, versionId)`; `backfillSources(deps, limit = 100): Promise<number>` (handler `backfill-sources`, re-queues itself while rows remain).
- Paths: `projects/<project id>/sources/<source id>/v<version no>/original.<ext>` and `…/text.txt`, under folders created with `ensureFolder` from the source-area root (`storage_folders` level `source_root` for `projects`).

- [ ] **Step 1: Write failing tests:**
  - `importing an upload creates pending original and text files and an outbox row in the same transaction`.
  - `pasted text creates a text file only`.
  - `store-source uploads both files, verifies hashes, marks them stored and clears original_bytes keeping original_sha256`.
  - `a hash mismatch from the provider fails the attempt and keeps the bytes` (fake returns altered hash once).
  - `without an approved source area versions stay pending with bytes and Kainow keeps working` (download still served from bytes).
  - `backfill creates stored_files rows for versions from before 0031 and stores them oldest first, 100 per run`.
  - `storage state shows Stored, Waiting to store, Storage failed to PM, Deputy, Owner and Sponsor only` (HTTP; member sees no field).
  - `minutes publication, meeting publication and approved summaries store text.txt`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/notes/*.test.js`.

- [ ] **Step 5: Commit** `feat(storage): preserve source versions in the managed source area`.

---

### Task 8: Source downloads from storage and the source check

**Files:**
- Create: `app/src/storage/source-files.ts`
- Modify: `app/src/notes/notes.service.ts` (`getOriginal`), `app/src/worker/schedules.ts` (daily check hook)
- Test: `app/src/storage/source-files.http.test.ts`

**Interfaces:**
- Produces: `openOriginal(deps, versionId): Promise<{ filename; mediaType; bytes: Buffer } | { refused: 'changed'|'unreachable'|'missing' }>`; `checkSourceFiles(deps, now: Date, limit = 2000): Promise<{ checked: number; flagged: number }>`.
- Copy: "This file has changed in storage since Kainow recorded it. It has been flagged for the storage Administrators." / "The file store cannot be reached right now".

- [ ] **Step 1: Write failing tests:**
  - `download after storage streams the stored file with the existing headers`.
  - `download refuses a changed file with the exact text, marks it changed and never serves it again`.
  - `download refuses when the provider is unreachable` (503 with the exact text).
  - `daily check flags changed and missing files, oldest check first, at most 2,000` (seed 2,001 rows; one stays unchecked).
  - `daily check checks never-checked files even when scheduled checks are off`.
  - `each newly flagged file notifies Administrators and storage Administrators once, naming the source only to readers` (others get "a source in <project>").
  - `working text, quotes and search are unaffected by a flagged file`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(storage): serve and check source originals from the source area`.

---

### Task 9: Report types, project output settings and formats

**Files:**
- Create: `app/src/outputs/report-types.service.ts`, `app/src/outputs/output-settings.service.ts`, `app/src/outputs/formats.ts`, `app/src/outputs/outputs.module.ts` (start), `app/src/outputs/settings.controller.ts`
- Modify: `app/src/projects/matrix.ts` (action `outputs.settings`: roles pm, owner, sponsor; states OPEN), `app/src/notes/readers.ts` or the import path (effective input formats check)
- Test: `app/src/outputs/report-types.http.test.ts`, `app/src/outputs/output-settings.http.test.ts`, `app/src/outputs/formats.test.ts`

**Interfaces:**
- Produces: `effectiveFormats(storage: StorageSettings, project: ProjectOutputSettingsRow | null): { input: Array<{ format: InputFormat; source: 'organisation'|'project' }>; output: Array<{ format: OutputFormat; source: 'organisation'|'project' }> }` (intersection).
- Produces: `ReportTypesService { list(includeRetired: boolean); add(user, name, reason); rename(user, id, name, reason); retire(user, id, reason) }` ordered by position, lower(name), id. Endpoints `GET/POST/PUT /admin/report-types` (`organisation.manage`), `GET /report-types` (signed-in, active only).
- Produces: `OutputSettingsService { get(user, projectId): Promise<{ destination; formats; exportRoles; editable: { destination: boolean; formats: boolean; exportRoles: boolean }; sources }>; update(user, projectId, patch, reason) }`; endpoints `GET/PUT /projects/:id/output-settings`.
- Copy: "This project does not accept PDF files. A PM, Owner or Sponsor can change this in Project settings › Outputs."

- [ ] **Step 1: Write failing tests:**
  - `formats.test.ts`: `null project lists mean all approved`; `project subset is intersected with approved`; `sources are labelled organisation or project`.
  - report types: `Administrator adds, renames and retires; retired types are not offered but keep history`; `names unique and 1–100 characters`; `members cannot manage`.
  - output settings: `PM, Owner or Sponsor edit when delegated; Deputy and Member cannot`; `Administrator always may`; `delegation switches off make it Administrator-only`; `read-only while Deferred or Closed`; `destination must be an approved outputs destination`; `export roles limited to pm, deputy, owner, sponsor, member, audit, oversight`; `changes need a reason and are versioned`.
  - `importing a PDF is refused with the exact text when the project removed pdf`; `pasted text is always allowed`; `removing a format leaves earlier sources readable`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/notes/*.test.js`.

- [ ] **Step 5: Commit** `feat(outputs): report types, project output settings and format catalogue`.

---

### Task 10: Renderers (Markdown, DOCX, PDF) with letterhead

**Files:**
- Create: `app/src/outputs/render/blocks.ts`, `markdown.ts`, `docx.ts`, `pdf.ts`, `header.ts`; `app/assets/fonts/NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `NotoSans-Italic.ttf`, `OFL.txt`
- Modify: `app/package.json` (`marked`, `docx`, `pdfkit`, `@types/pdfkit` pinned exact)
- Test: `app/src/outputs/render/render.test.ts`

**Interfaces:**
- Produces: `type Block = { kind: 'heading'; level: 1|2|3; inlines: Inline[] } | { kind: 'paragraph'; inlines: Inline[] } | { kind: 'list'; ordered: boolean; items: Block[][] } | { kind: 'table'; header: Inline[][]; rows: Inline[][][] } | { kind: 'quote'; blocks: Block[] } | { kind: 'rule' } | { kind: 'footnotes'; items: Array<{ label: string; inlines: Inline[] }> }`; `type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }`.
- Produces: `parseBlocks(markdown: string, appUrl: string): Block[]` (marked lexer only; `#/…` links → `${appUrl}/#/…`; unknown tokens → paragraph text; lists deeper than two levels flattened to two).
- Produces: `interface DocumentHeader { organisationName: string; logo: { content: Buffer; mime: string; box: { width: number; height: number } } | null; title: string; projectName: string; reportType: string; versionNo: number; issueDate: string; aiAssisted: boolean; generatedAt: Date }`; `headerLines(h): string[]` returning exactly: title; `<project> · <report type> · Version <n> · Issued <d MMMM yyyy>`; `Draft — not approved`; `Prepared with AI assistance; facts from Kainow records` (only when aiAssisted); `Generated by Kainow on <d MMMM yyyy HH:mm> UTC+8`.
- Produces: `renderMarkdown(h, blocks|markdown): Buffer`, `renderDocx(h, blocks): Promise<Buffer>`, `renderPdf(h, blocks): Promise<Buffer>`; all refuse over 25 MiB with `RenderTooLarge` ("This document is too large to generate").
- Produces: `loadDocumentHeader(db, opts): Promise<DocumentHeader>` using `loadLetterhead(db, 'report')`.

- [ ] **Step 1: Write failing tests** (`render.test.ts`):
  - `parseBlocks covers headings, emphasis, code, links, two-level lists, tables, quotes, rules and footnotes`.
  - `Kainow record links become absolute`.
  - `docx contains header lines and every block's text in order` (read with `mammoth.extractRawText`).
  - `pdf contains header lines, body text and page numbers` (read with `pdfjs-dist`, existing `notes/readers.ts` pattern).
  - `Malay text with diacritics round-trips in docx and pdf` (e.g. "Mesyuarat jawatankuasa — kemaskini", "café", "naïve").
  - `AI line appears only when aiAssisted`.
  - `letterhead uses Kainow's own name before registration and the organisation's after` (seed `organisation` row with a dummy name, e.g. "Example Organisation").
  - `over 25 MiB is refused`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (DOCX styles Heading 1–3, Normal, List Bullet, List Number, Table Grid; PDF A4, 20 mm margins, Noto Sans, footer title · version · page). **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(outputs): Markdown, DOCX and PDF renderers with letterhead`.

---

### Task 11: Output register core: submit, register, decline, versions, readers

**Files:**
- Create: `app/src/outputs/readers.ts`, `app/src/outputs/naming.ts`, `app/src/outputs/outputs.service.ts`, `app/src/outputs/outputs.controller.ts`
- Modify: `app/src/projects/matrix.ts` (actions `output.submit`: pm, deputy_pm, owner, sponsor, member, states OPEN; `output.manage`: pm, deputy_pm, states OPEN; `output.approve_request`: pm, deputy_pm, states `['planned','active']`; `output.audience`: pm, owner, sponsor, states ALL), `app/src/outputs/outputs.module.ts`
- Test: `app/src/outputs/naming.test.ts`, `app/src/outputs/readers.db.test.ts`, `app/src/outputs/register.http.test.ts`

**Interfaces:**
- Consumes: Task 10 renderers and `loadDocumentHeader`; Task 9 `effectiveFormats`; `draftAccess` from `assist/reports.service.ts`; existing credential check used by notes import (`findSecret` or its current name — locate with `grep -rn "D79\|credential check" app/src/notes`).
- Produces: `safeName(name: string, max = 100): string` (replace `" * : < > ? / \ |` with `-`, strip leading/trailing spaces and dots, collapse whitespace, cut at `max` code points without splitting surrogate pairs, empty → `Untitled`); `outputFileName(title: string, versionNo: number, ext: string, suffix?: number): string`; `fitPath(parts: string[], fileName: string, limit = 400): string[]` (shortens the title part first).
- Produces: `materialReaders(db, draftVersionId: string, projectId: string): Promise<Set<string>>` — user ids who `draftAccess` would allow, for every project content reader; `outputReaders(db, outputId: string, at: Date): Promise<Set<string>>` (spec §4.6 and §4.5 review rule); `isWholeProject(db, outputId, at): Promise<boolean>` (Project-wide, not in review, not withdrawn/deleted/held).
- Produces: `OutputsService { submit(user, projectId, input: SubmitInput): Promise<OutputDetail>; register(user, projectId, outputId, input: RegisterInput): Promise<OutputDetail>; decline(user, projectId, outputId, reason); update(user, projectId, outputId, patch, reason?); addVersion(user, projectId, outputId, input: SubmitInput); list(user, projectId, filters): Promise<OutputSummary[]>; get(user, projectId, outputId): Promise<OutputDetail> }` where `SubmitInput = { kind: 'draft'; draftVersionId: string; format: 'md'|'docx'|'pdf'; title: string; reportTypeId?: string } | { kind: 'upload'; filename: string; bytes: Buffer; title: string; reportTypeId?: string } | { kind: 'link'; url: string; title: string; reportTypeId?: string }` (export kind added in Task 18). Lists order by issue_date desc nulls last, lower(title), id.
- Endpoints per spec §14 for submit, register, decline, update, versions, list, detail. Upload is multipart with the notes upload limits.

- [ ] **Step 1: Write failing tests:**
  - `naming.test.ts`: **`safeName handles illegal characters, diacritics, emoji and length`** (Review Focus 3: `'Q3: "Plan" <draft>?'` → `'Q3- -Plan- -draft--'` (each illegal character becomes one `-`; dashes are not collapsed; whitespace runs become one space); `'Kemaskini café 📎'` keeps diacritics and emoji; 300 characters cut to 100 without a broken surrogate); `fitPath keeps the total under 400 by shortening the title`; `outputFileName adds (2) suffix`.
  - `readers.db.test.ts`: `materialReaders matches draftAccess for every project reader` (seed a draft using a restricted source; compare per person); `outputReaders is project content readers for Project-wide, the audience intersection for Restricted, and PM/Deputy/Owner/Sponsor among material readers in review`; `Audit grant holders read within scope; leadership grant holders never`.
  - `register.http.test.ts`: `each participant role may submit from a readable draft; Deferred and Closed refuse`; `submitting a draft the person cannot read is 404`; `upload accepts md, docx, pdf, csv in project formats and refuses txt`; `upload with a suspected secret is refused naming only the kind`; `a link outside approved destinations is refused with the exact text` "Kainow can only register documents in approved storage locations."; `a link inside one is registered as Kept at its existing location with sharing managed outside Kainow`; `submitted outputs are visible to submitter, PM and Deputies only`; `PM or Deputy registers with type, categories, issue date, contributors and audience; a Member cannot`; `contributor departments are recorded as at registration and not rewritten when the person moves department`; `AI-assisted is set from an AI draft version`; `decline needs a reason and leaves the output visible to the submitter`; `restricted material forces a Restricted audience within material readers, default PM, Deputies, Owner and Sponsors among them`; `adding a version whose material is narrower than the audience is refused until narrowed`; `draft report kinds map to default report types`; `output_events written for submitted, registered, declined, version_added`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(outputs): output register with submission, registration and readers`.

---

### Task 12: Filing output versions

**Files:**
- Create: `app/src/outputs/filing.ts`
- Modify: `app/src/outputs/outputs.service.ts` (`file(user, projectId, outputId, versionNo)`), controller, `app/src/worker/schedules.ts` (daily drop of unfiled bytes past `kept_until`)
- Test: `app/src/outputs/filing.http.test.ts`

**Interfaces:**
- Consumes: Task 11 `safeName`, `outputFileName`, `fitPath`, `isWholeProject`; Task 6 jobs; Task 5 factory.
- Produces: handler `file-output` = `fileOutputVersion(deps, versionId)`; `ensureOutputFolder(deps, dest, projectId, outputId, wholeProject: boolean): Promise<FolderRef>` (creates and records `storage_folders` department/project/year/report_type or restricted_root/output, reused by id); `onFiled` queues `share-sync` for the folder.
- Copy: "Choose where this project files its outputs first (Project settings › Outputs)."; "Filing failed — <reason>"; "A different file already has this name"; "Not filed — file no longer kept; generate or upload it again".

- [ ] **Step 1: Write failing tests** (fake Graph via `storageConnectors` option):
  - `filing needs a project destination` (exact text).
  - `Project-wide output files under Department / Project / Year / Report Type with Title vN.ext`.
  - `Restricted output files under Department / Project (restricted) / Output title`.
  - `folders are created once and reused by id after the project and department are renamed`.
  - `issue year comes from the issue date in UTC+8` (issue date 2026-12-31 → 2026; 2027-01-01 → 2027).
  - `filed only after hash confirmation; bytes then removed from the database`.
  - `uncertain upload adopts the matching file on retry and never creates a second`.
  - **`concurrent file requests produce one stored file`** (Review Focus 2: two simultaneous POSTs → one `stored_files` row, one provider item, the second request 409 or the same result).
  - `a different file with the same name gives (2), never overwrites`.
  - `final failure shows Filing failed with reason and Try again works`.
  - `linked versions cannot be filed`.
  - `unfiled draft bytes are dropped after 90 days and the version says so`.
  - `Deferred and Closed refuse filing`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(outputs): confirmed filing under department, project, year and type`.

---

### Task 13: Folder sharing and placement

**Files:**
- Create: `app/src/outputs/sharing.ts`
- Modify: membership, grant, account and audience writers to queue sync (find with `grep -rn "INSERT INTO membership_events\|INSERT INTO grant_events\|accounts.*disabled\|INSERT INTO audience_events" app/src`), `app/src/worker/schedules.ts` (02:30 UTC+8 reconciliation)
- Test: `app/src/outputs/sharing.http.test.ts`

**Interfaces:**
- Consumes: Task 11 `outputReaders`, `isWholeProject`; Task 12 `ensureOutputFolder`; connector `grant/revoke/lookupPerson/move`.
- Produces: `desiredFolderGrants(db, folderId, at): Promise<Map<string /*userId*/, string /*email*/>>`; handler `share-sync` = `syncFolderGrants(deps, folderId)` (revocations first); handler `place-output` = `placeOutput(deps, outputId)` (moves every stored file of the output to the place `isWholeProject` dictates; narrowing jobs urgent); `queueProjectSharing(c, projectId)` and `queueOutputPlacement(c, outputId, direction: 'narrow'|'widen')` for triggers; `reconcileSharing(deps, at)`.
- Copy: "Not shared in SharePoint — no Microsoft account found for <email>"; notice "Kainow could not remove SharePoint access for a person who has left <project>".

- [ ] **Step 1: Write failing tests:**
  - `the project folder is granted read to exactly the project's content readers` (PM, Deputy, Owner, Sponsor, Member, active Audit grant; not Scheduled, On Hold, Expired, Revoked, leadership).
  - `restricted output folders are granted to the output's readers only and the restricted root to nobody`.
  - `no file ever carries a Kainow grant` (fake records invite targets; all are folders).
  - `membership ending, On Hold, account disabled and Audit grant end revoke at once; expiry by date revokes at the daily reconciliation`.
  - `joining grants`.
  - `narrowing an audience moves the files out of the project folder before revoking or granting anything` (assert call order in `calls`).
  - **`narrowing with a failing move keeps output hidden and listed to repair`** (Review Focus 1: fault on PATCH; Kainow GET by the removed person → 404 immediately; Storage "Sharing to repair" lists it; after the fault clears, retry completes).
  - `widening moves files back and never revokes first`.
  - `not_found with lookup on (guest, disabled, unknown) and off (domain not approved) is shown to PM, Deputy, Owner, Sponsor`.
  - `permissions Kainow did not create are never revoked` (seeded owner group and a named user survive every operation).
  - `revocation that keeps failing raises the Administrator notice once and stays listed`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/projects/*.test.js`.

- [ ] **Step 5: Commit** `feat(outputs): folder sharing kept in step with readers`.

---

### Task 14: Output approval

**Files:**
- Create: `app/src/outputs/approval-handler.ts`
- Modify: `app/src/changes/changes.module.ts` / handler registry (register the handler), `app/src/outputs/outputs.service.ts` (`requestApproval`)
- Test: `app/src/outputs/approval.http.test.ts`

**Interfaces:**
- Consumes: `ChangeHandler` from `changes/handlers.ts`.
- Produces: `approveOutputHandler: ChangeHandler` with `kind: 'approve_output'`, `targetKind: 'output_version'`; `mayPropose` allows PM/Deputy; `validate` refuses unless the version is filed (`stored`) or a checked link, its check is not `changed|missing|access_denied`, the output is Registered and not in review/held/deleted; `apply` sets Approved with `approval_request_id`, sets earlier Approved versions Superseded, writes `output_events` and History.
- Endpoint: `POST /projects/:id/outputs/:outputId/versions/:n/approval`.
- Copy on approval screen data: "Approving this document does not approve the commitments it mentions."

- [ ] **Step 1: Write failing tests:**
  - `PM requests approval of a filed version; Owner approves; version Approved with reference`.
  - `approving v2 supersedes approved v1; a draft v1 stays draft`.
  - `unfiled, changed, missing and access-denied versions cannot be put for approval`.
  - `two-approval policy needs two distinct people`.
  - **`combined PM-Owner counts once toward a two-approval policy`** (Review Focus 4).
  - `rejection leaves the version Draft`.
  - `Member cannot request; Deputy can; Owner and Sponsor approve; Planned and Active only`.
  - `approval response carries the does-not-approve-commitments text`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/changes/*.test.js`.

- [ ] **Step 5: Commit** `feat(outputs): approve output versions through project approval policy`.

---

### Task 15: Audience changes and removed material

**Files:**
- Create: `app/src/outputs/audience.ts`, `app/src/outputs/removal.ts`
- Modify: `app/src/assist/removal.ts` (`onMaterialRemoved` calls `outputsOnMaterialRemoved(db, what, reason, at)` after drafts, keeping the documented lock order: outputs locked last, in id order)
- Test: `app/src/outputs/audience.http.test.ts`

**Interfaces:**
- Produces: `setOutputAudience(user, projectId, outputId, input: { kind: 'project' } | { kind: 'restricted'; userIds: string[] }, reason, preview: boolean): Promise<{ gaining: string[]; losing: string[] }>` (preview returns names without saving); `outputsOnMaterialRemoved(db, what: RemovedMaterial, reason: RemovalReason, at): Promise<number>`; `clearReview(user, …)`, `withdrawForReview(user, …)`.
- Endpoints: `PUT /projects/:id/outputs/:outputId/audience`, `POST …/review/{clear,withdraw}`.
- Label: "Access review required".

- [ ] **Step 1: Write failing tests:**
  - `PM, Owner or Sponsor change the audience with a reason; widening preview lists names gaining access`.
  - `audience cannot include people outside material readers`.
  - `audience change queues placement and sharing; Kainow access changes at once`.
  - `deleting a source a version used sets review_required and limits readers to PM, Deputies, Owner and Sponsors who can still read it`; same for a hidden message, a held source and a tightened source audience.
  - `clear returns the audience; withdraw ends the output`.
  - `onMaterialRemoved still behaves as before for answers, drafts and summaries` (run `dist/assist/removal.db.test.js`).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(outputs): output audiences and review after material removal`.

---

### Task 16: Opening, checks and reconciliation of output files

**Files:**
- Create: `app/src/outputs/checks.ts`
- Modify: `app/src/outputs/outputs.controller.ts` (open, download, relink, register-changed), `app/src/worker/schedules.ts` (daily output check when scheduled checks are on)
- Test: `app/src/outputs/checks.http.test.ts`

**Interfaces:**
- Produces: `checkStoredFile(deps, storedFileId): Promise<'ok'|'changed'|'moved'|'missing'|'access_denied'|'unverified'>` (records result, events, PM/Deputy notice on newly found changed/moved/missing); handler `check`; handler `register-changed` = `registerChangedContent(deps, versionId, actorId)` (download current → upload `<Title> v<n+1>` → new Draft version origin `changed_file` → look for matching version via `listVersions` → `restoreVersion` or leave Changed with "The approved content could not be recovered from storage"); `relink(user, projectId, outputId, versionNo, url)`; `checkOutputs(deps, at, limit = 2000)`.
- Endpoints: `GET …/versions/:n/open` (303 to web URL after a check at most once a minute per file; shows state instead when not ok), `GET …/versions/:n/download`, `POST …/versions/:n/{relink,register-changed}`.
- Label: "File changed since approval — this is not the approved content".

- [ ] **Step 1: Write failing tests:**
  - `open checks then redirects with 303 for a reader; 404 for a non-reader`; `a second open within a minute does not call the provider again`.
  - `open shows Changed, Missing or Access denied instead of redirecting`.
  - `daily check runs only with scheduled checks on, oldest first, at most 2,000`.
  - `changed approved version stays Approved as a record, shows the label and blocks approval requests`.
  - `register-changed makes a separate file and restores the original from version history`; `when no matching version exists the original stays Changed with the exact text`; `two versions never share a stored file`.
  - `moved within an approved destination is relinked by PM or Deputy with old and new recorded`; `moved outside approved destinations shows Missing or Access denied and is relinkable only after the place is approved as a destination`.
  - `registered links are checked when their document is in an approved destination`.
  - `download streams the file to readers only`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(outputs): open, check and reconcile filed outputs`.

---

### Task 17: Withdraw, delete, restore and holds (outputs and source files)

**Files:**
- Create: `app/src/storage/withhold.ts`, `app/src/outputs/holds.ts`
- Modify: `app/src/quarantine/clean.ts` (withholding `original_bytes` and output versions queues `withhold`; release queues `restore-withheld`), `app/src/history/` deletion services or the outputs service (logical delete/restore per sub-project 5 pattern), `app/src/outputs/outputs.service.ts`
- Test: `app/src/storage/withhold.http.test.ts`, `app/src/outputs/lifecycle.http.test.ts`

**Interfaces:**
- Produces: handler `withhold` = `withholdStoredFile(deps, storedFileId, caseId)` (output files under the project folder are first moved to the output folder; download → SHA-256 check → encrypt into `quarantine_originals` with state `withheld` in one transaction → `removePermanently` → for source versions upload cleaned `text.txt`); handler `restore-withheld` = `restoreWithheld(deps, storedFileId, caseId)`; `withdrawOutput`, `deleteOutput`, `restoreOutput` on the service.
- Copy: "A held file could not be removed from storage"; held-link notice text exactly as spec §4.7.

- [ ] **Step 1: Write failing tests:**
  - `withdraw needs a reason, is final, moves files to the output folder with no grants`.
  - `delete hides the output from views, search and exports and moves files out of shared folders; restore brings them back; the external file is never deleted`.
  - `a held source upload is encrypted then permanently deleted, never in the recycle bin, and a cleaned text file replaces the old one`.
  - `a held output file leaves the project folder first, then is encrypted and permanently deleted`.
  - `removal failure keeps the item hidden, notifies Administrators without the secret and shows Still in storage`.
  - `false-alarm release re-uploads the original to the same folder and re-syncs sharing`.
  - `a held link is hidden in Kainow, never deleted, and the notice goes to Administrators, storage Administrators and the PM`.
  - `quarantine originals for files carry no plain copy anywhere else` (grep `stored_files`, `output_version_bytes`, events).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/quarantine/*.test.js`.

- [ ] **Step 5: Commit** `feat(storage): withhold held files and output lifecycle`.

---

### Task 18: Project exports

**Files:**
- Create: `app/src/outputs/exports.ts`, `app/src/outputs/exports.controller.ts`
- Modify: `app/src/organisation/access-settings.ts` (`project_exports_allowed` in `ACCESS_KEYS`, validation, load), `app/src/analytics/csv.ts` (export a `toCsv` option `bom: boolean`), `app/src/projects/matrix.ts` (no role list for `output.export`; decided by policy), `app/src/outputs/outputs.service.ts` (`SubmitInput` kind `export`)
- Test: `app/src/outputs/exports.http.test.ts`

**Interfaces:**
- Produces: `type ExportKind = 'tasks'|'decisions'|'questions'|'risks'|'outputs'`; `mayExport(ctx: ProjectContext, policy: { allowed: boolean; roles: string[] }): boolean`; `buildExport(db, projectId, kind, filters, viewer, at): Promise<{ filename: string; csv: Buffer; rows: number }>` with columns exactly as spec §7.2, cells cut at 2,000 characters, `#` lines Export, Project, Filters, Computed at (UTC+8), Coverage "All authorised records in the project except deleted ones and any under credential review".
- Endpoints: `GET /projects/:id/export?kind=&…filters` and `POST /projects/:id/export/save` (`{ kind, filters, outputId? }`).

- [ ] **Step 1: Write failing tests:**
  - `exports refused while project exports are off` (default).
  - `with exports on, default roles PM, Deputy, Owner, Sponsor may export; Member may not until chosen`; `Audit and Oversight via their grant kind when chosen`.
  - `allowed while Deferred, Closed and archived`.
  - `columns per kind exactly as specified`.
  - `Deleted records and uncleaned held records are absent; cleaned held show Credential removed — under review`.
  - `no source text, message text, quotes or AI questions appear` (seed them with marker strings; grep the CSV).
  - `formula guard, BOM, CRLF and # lines`.
  - `each export writes project.exported with kind, filters and row count and no data`.
  - `save as output creates a submitted CSV output with type Exports and Project-wide audience`.
  - `the Access and records setting changes with a reason through access settings history`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/analytics/csv.test.js` and `dist/organisation/access-settings*.test.js`.

- [ ] **Step 5: Commit** `feat(outputs): project CSV exports under export policy`.

---

### Task 19: Storage Administrators

**Files:**
- Create: `app/src/storage/admins.service.ts`
- Modify: `app/src/storage/storage.controller.ts`, account-disable path (queue revoke), `app/src/storage/destinations.service.ts` (source-area permission warning in daily check)
- Test: `app/src/storage/admins.http.test.ts`

**Interfaces:**
- Produces: `StorageAdminsService { list(); designate(user, userId, reason); end(user, designationId, reason) }`; grants `write` on the source-area root folder through `storage_grants` and `share-sync` of that folder; `sourceAreaOthers(deps): Promise<PermissionInfo[]>`.
- Endpoints: `GET/POST /admin/storage/admins`, `POST /admin/storage/admins/:id/end`.
- Copy: "The source area is also open to: <names or 'a sharing link'>".

- [ ] **Step 1: Write failing tests:**
  - `an Enterprise Administrator designates another active person with a reason; not themselves`.
  - `designation grants write on the source-area root; ending or account disable revokes it`.
  - `Enterprise Administrator standing alone gives no grant`.
  - `daily check warns about anyone else with access and never removes it`.
  - `events recorded and listed ordered by name`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(storage): storage Administrators with direct source-area access`.

---

### Task 20: Relocation, moving the source area and the manifest

**Files:**
- Create: `app/src/storage/relocate.ts`, `app/src/storage/manifest.ts`
- Modify: `app/src/storage/storage.controller.ts`
- Test: `app/src/storage/relocate.http.test.ts`

**Interfaces:**
- Produces: `relocateStoredFile(deps, storedFileId, target: { destinationId: string; folderId: string; name?: string }, reason: string, actorId: string | null): Promise<void>` (set `relocating` → `move` same drive or `copyTo` → verify size and hash (SHA-256 by download when no provider hash) → switch reference and insert `stored_file_moves` in one transaction → remove old copy: permanently for source files, only after confirmation for outputs); handler `relocate`; `moveSourceArea(user, newDestinationId, reason)`; `buildManifest(db): Promise<Buffer>` with columns purpose, project id, project name, source or output id, version, destination label, connector, drive id, item id, path, size, SHA-256, provider hash, state, last check; restricted titles as "Restricted item"; `writeAudit` `storage.manifest_downloaded`.
- Endpoints: `POST /admin/storage/source-area/move`, `GET /admin/storage/manifest`.

- [ ] **Step 1: Write failing tests:**
  - `relocation verifies before switching and keeps the old reference on failure at each step` (fault on copy, on verify mismatch, on removal).
  - `moving the source area relocates every file, shows progress and downloads use the current copy throughout`.
  - `the old source area stays approved for reading until the move completes`.
  - `manifest lists every stored file with neutral references, hides restricted titles and records the download`.
  - `only Enterprise Administrators may move or download`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(storage): verified relocation, source-area move and manifest`.

---

### Task 21: Owning department transfer

**Files:**
- Create: `app/src/projects/department-transfer.service.ts`
- Modify: `app/src/projects/projects.controller.ts` (route), `app/src/history/history.service.ts` (union adds transfers and output events)
- Test: `app/src/projects/department-transfer.http.test.ts`

**Interfaces:**
- Produces: `transferDepartment(user, projectId, input: { departmentId: string; reason: string; folderChoice?: 'move'|'keep' }): Promise<{ transferId: string; state: 'done'|'moving' }>`; `folderChoice` required when the project has stored output files; the `relocate` job for `project_department_transfers` moves the project folder and `(restricted)` folder per destination and refreshes paths, verifying every item id resolves.
- Endpoint: `PUT /projects/:id/owning-department`. Audit `project.department_transferred`.
- Labels: "Moving files", "Files not moved — still at <old path>", "Kept at its existing location (filed under <old department>)".

- [ ] **Step 1: Write failing tests:**
  - `only an Enterprise Administrator transfers, in any project state, with a reason`.
  - `folder choice required only when outputs are filed`.
  - `move relocates both folders, keeps grants and item ids, refreshes paths`; `failure leaves the old paths and offers Try again`.
  - `keep labels filed outputs and files new ones under the new department`.
  - `history shows the old department, reason and choice`; `leadership department scope follows the new owner` (reuse sub-project 7 assertion).
  - `contributor attribution is unchanged`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/leadership/*.test.js`.

- [ ] **Step 5: Commit** `feat(projects): owning department transfer with folder choice`.

---

### Task 22: Search, history, catalogue and analytics system panel

**Files:**
- Modify: `app/src/search/search.service.ts` (+ index writer) to index output title, report type and categories filtered by `outputReaders`; `app/src/history/history.service.ts` (output events); `app/src/analytics/system.service.ts` (counts: storage failures, waiting files, withheld-removal failures, sharing to repair); `app/src/analytics/catalogue.ts` (all actions added in Tasks 4–21)
- Test: `app/src/outputs/search.http.test.ts`, existing catalogue completeness test

**Interfaces:**
- Produces: search results of kind `output` with `{ projectId, outputId, title }`; system panel fields `storageFailures`, `storageWaiting`, `withholdFailures`, `sharingToRepair`.

- [ ] **Step 1: Write failing tests:** `outputs are found by title and category by their readers only`; `deleted, held and withdrawn outputs are not found`; `restricted outputs are not found by non-readers`; `history lists output events in time order`; `system panel counts storage problems`; catalogue completeness test passes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `dist/search/*.test.js`, `dist/analytics/*.test.js`.
- [ ] **Step 5: Commit** `feat(outputs): search, history and storage problems in analytics`.

---

### Task 23: Go-live step and Storage page summary

**Files:**
- Create: `app/src/storage/summary.service.ts`
- Modify: `app/src/golive/checklist.ts` (step `storage`, mode `auto_or_skip`, text "Connect storage and approve the source area"), `app/src/storage/storage.controller.ts` (`GET /admin/storage/summary`)
- Test: `app/src/storage/summary.http.test.ts`, existing go-live tests

**Interfaces:**
- Produces: `storageSummary(db): Promise<{ connection: 'connected'|'not_configured'|'protected_key_missing'|'refused'; destinations: Destination[]; sourceArea: { files: number; bytes: number; quotaBytes: number|null }; waiting: number; failed: number; withheld: number; sharingToRepair: Array<{ project: string; folder: string; since: string }>; storageAdmins: Array<{ name: string; since: string }>; scheduledChecks: boolean }`. Quota null shows "Unavailable", never 0.

- [ ] **Step 1: Write failing tests:** `go-live storage step auto-ticks when the connection checks and a source area is approved`; `the step can be skipped with a note and closing keys are unchanged`; `summary counts and quota Unavailable`; existing `dist/golive/*.test.js` pass with 12 steps.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(storage): go-live storage step and storage summary`.

---

### Task 24: Web: System Settings › Storage, Report types, Access and records

**Files:**
- Create: `app/web/src/storage.ts` (API helpers), `app/web/src/views/StorageSettings.tsx`, `app/web/src/views/ReportTypes.tsx`
- Modify: `app/web/src/App.tsx` (routes `#/storage`, `#/report-types`, nav items "Storage", "Report types"), `app/web/src/views/AccessSettings.tsx` ("Project exports allowed")
- Test: `app/web/src/storage.test.ts` (helpers and labels)

**Interfaces:**
- Consumes: endpoints from Tasks 4, 5, 9, 19, 20, 23.
- Produces: `storageStateLabel(state)`, `checkLineLabel(key, ok)`, `quotaLabel(bytes: number|null)` ("Unavailable" for null).

- [ ] **Step 1: Write failing tests:** label helpers (`quotaLabel(null) === 'Unavailable'`, never `'0'`); destination form validation (OneDrive hidden when lookup off); permission instructions list shows `Sites.Selected` and, only with lookup on, `User.ReadBasic.All`.
- [ ] **Step 2: Run** `npm test` in `app/web` → FAIL. **Step 3: Implement** the pages (summary first; secret field write-only, cleared after save; every change asks for a reason; states in words). **Step 4: Run** → PASS; `npm run build:web` succeeds.
- [ ] **Step 5: Check** at desktop width and 375 px, keyboard only, both themes (start the app with the local connector via `KAINOW_LOCAL_STORAGE_DIR`).
- [ ] **Step 6: Commit** `feat(web): storage settings, report types and project exports switch`.

---

### Task 25: Web: project Outputs tab, output page, exports, settings, sources, transfer

**Files:**
- Create: `app/web/src/outputs.ts`, `app/web/src/views/ProjectOutputs.tsx`, `app/web/src/views/OutputPage.tsx`, `app/web/src/views/ProjectOutputSettings.tsx`
- Modify: `app/web/src/views/ProjectPage.tsx` (tab "Outputs"), the D77 draft view ("Submit as output"), Work and Records views ("Export CSV", "Save as output" when allowed), `NotificationSettings.tsx`'s `ProjectSettings` (Outputs section), the source version panel (storage state), the Administrator project organisation panel ("Change owning department")
- Test: `app/web/src/outputs.test.ts`

**Interfaces:**
- Produces: `versionStatusLabel`, `filingLabel`, `checkLabel(status, checkedAt)`, `notSharedLabel(email)`, `effectiveSourceLabel('organisation'|'project')`.

- [ ] **Step 1: Write failing tests:** labels match the spec's copy ("Draft — not approved", "File changed since approval — this is not the approved content", "Not shared in SharePoint — no Microsoft account found for <email>", "Access review required", "Kept at its existing location"); export button hidden when not allowed; approval dialog shows "Approving this document does not approve the commitments it mentions."
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; build succeeds.
- [ ] **Step 5: Check** screens at desktop and 375 px, keyboard, both themes; WCAG 2.2 AA (labels, focus order, states in words).
- [ ] **Step 6: Commit** `feat(web): project outputs, exports and output settings`.

---

### Task 26: Probe, bench and documents

**Files:**
- Create: `app/src/storage/probe-storage-cli.ts`, `app/src/storage/bench-cli.ts`, `app/src/storage/probe-storage.test.ts`
- Modify: `app/package.json` scripts `probe-storage`, `bench-outputs`; `app/README.md`; `INSTALL.md`; `docs/Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md` (D100–D108 verbatim from spec §2.1); `docs/Kainow-V1.0-Permission-Matrix.md` (rows of spec §11); `docs/Kainow-V1.0-Configuration-Catalogue.md` (C85–C92 as spec §17; C21, C48, C50, C56, C57, C68 point to the design); `docs/Kainow-V1.0-Remaining-Design-and-Verification-Register.md` (R14, R15, A13/A14 status); spec §15 bench results

**Interfaces:**
- Produces: `npm run probe-storage -- --destination <label>` printing one line per check (token, destination, folder, small upload, chunked upload, hashes, move, invite and revoke a named test account given by `--test-account`, permanent delete, whether `write` sufficed); never prints the secret or token. `npm run bench-outputs` on its own database (`kainow_bench_sp9`).

- [ ] **Step 1: Write failing test** `probe-storage.test.ts`: `probe against the fake Graph prints every check line and no token or secret`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** probe and bench (data per spec §15).
- [ ] **Step 4: Run** the probe test → PASS. Run the bench; record p50/p95/max and met/missed in spec §15 in the sub-project 7 table style.
- [ ] **Step 5: Update the documents** listed above (dummy names only; keep sub-project 8 rows if present).
- [ ] **Step 6: Run the full server suite in the background** (`npm test` from `app/`, KAINOW_TEST_DATABASE_URL set) and `npm test` in `app/web`; both must pass.
- [ ] **Step 7: Commit** `docs: sub-project 9 register, matrix, catalogue, README, INSTALL and bench results`.
