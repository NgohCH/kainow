# V1.0 sub-project 9: external outputs — output register, generated files, exports, SharePoint/OneDrive filing and the managed source area — design

**Date:** 20 November 2026
**Status:** Approved by the Product Owner on 20 November 2026, including the design calls in §16 and the bench aims in §15. Scope and approach were agreed in conversation on 20 November 2026 (§2), including the builder-check answers on directory lookup and folder sharing.
**Build rulings:** decisions taken while building (20–21 November 2026) are written into the sections they change and marked "(build ruling, 20–21 November 2026)"; where one conflicts with earlier text in the same section, the ruling wins.
**Builds on:** `main` at 3df1dc1 (sub-projects 1–7 merged). Branch `TheLord/subproject-9-external-outputs-56227e`. Migration `0031_external_outputs.sql` (0030 is sub-project 8's). Decision Register D100 onward; Configuration Catalogue C85 onward.
**Runs alongside:** sub-project 8 (shared resources and budget), built at the same time. Its migration 0030 rebuilds the `change_requests` kind and target CHECK lists; this sub-project's migration must rebuild them as the union of both lists (§13.3).
**Authority:**
- Intent Card principles 2, 4, 6, 7 and 8; "Included in V1.0" (managed external outputs; SharePoint/OneDrive initially); "Accepted runtime direction" (managed sources).
- Product Summary §6 (O14 Export row), §13 (O03), §18 (Q01, Q04, Q06), §20.
- Consolidated Specification: §3, §10, §12; D31, D32, D55, D56, D57, D58, D60, D71, D77, D80–D82; O01, O03, O09, O13, O14; Q01, Q06; A11, A13, A14, A15, A17.
- Action-Item Emails, External Outputs and Department Attribution (§§3, 5–8, 10, 11).
- Managed Sources, Credentials, Storage and Recovery Rules (§§1–3, 7).
- Permission Matrix §2 row "Export visible data", §5 rows "Draft/submit output" and "Register/file/move/rename output", §8 rows on connections and export policy, §9.
- Configuration Catalogue C21, C48, C50, C56, C57, C68.
- Remaining Design and Verification Register R14 (report types, formats), R15.
- Earlier designs this extends: the sub-project 4b design (D77 report drafts), the sub-project 5 design (deletion, holds, quarantine, `onMaterialRemoved`), the sub-project 6 design (protected-key sealing of secrets), the sub-project 7 design (CSV conventions, access settings).

## 1. Purpose and the why

Kainow records what was agreed and who is doing it, but today nothing leaves Kainow in a form an organisation keeps: an AI draft report can only be downloaded as Markdown, records cannot be exported, nothing is filed in the organisation's document store, and uploaded minutes are kept inside the database instead of the protected SharePoint area the accepted rules (A13) require.

Sub-project 9 adds:

1. **The output register**: every project deliverable, with its versions, report type, issue year, author, contributing people and departments, AI-assistance label and Draft/Approved/Superseded status (D31; outputs rules §6).
2. **Generated files**: Markdown, DOCX and PDF from D77 drafts and uploaded documents; CSV for tabular record reports; formats chosen per project from the Administrator's catalogue (O03).
3. **Exports**: CSV exports of a project's records, under an export policy (O14, C21).
4. **Filing in SharePoint or OneDrive** under Owning Department › Project › Year › Report Type, confirmed by the storage service, with sharing that Kainow keeps in step with each output's audience, and checks that show Changed, Missing, Access denied or Unverified (O13).
5. **The managed source area** (A13, A14): uploaded originals and extracted text of every source version are preserved in a protected SharePoint area; the database keeps the working text.
6. **Changing a project's owning department**, with an explicit choice to move its folder or keep it (O13; a sub-project 1 leftover).
7. **A storage connector boundary** so that other providers can be added later, and a relocation routine and storage manifest so an organisation can move its files out.

### Goals

- Nothing is reported as filed, stored or moved until the storage service confirms it, with the file's identity and checksum recorded (outputs rules §7).
- Each person can open, in Kainow and in SharePoint, only the outputs their current access allows. Kainow grants and removes SharePoint access for the files it files, and never touches access it did not create.
- Approval is of one exact version's exact content. A changed file never keeps its approval.
- Deleted and held content never appears in an export, a generated file or a filing.
- The managed source area is reachable only through Kainow for ordinary users; direct access is for the service connection and designated storage Administrators only (A14).
- Every stored file is recorded by provider-neutral references (connector, provider file id, path, size, SHA-256), so files can be relocated, and later moved to another provider, with verification.
- Secrets never reach a log, an audit detail, a filed file or an export (Intent Card principle 7).

### Non-goals (9)

- Storage providers other than SharePoint and OneDrive. Dropbox, Box and others are later connectors (Q06); the connector contract (§5.1) is designed for them but no other connector is built.
- Budget and resource figures in exports or generated reports. They depend on sub-project 8; "budget export" is a follow-up once it merges (sub-project 8 offers a reusable `ResourcesReportService` for it).
- Consolidated action-item emails (built in sub-project 3).
- Editing documents inside Kainow beyond the existing D77 draft editor; general document repository features (outputs rules §2).
- OCR; new input formats beyond TXT, Markdown, DOCX and selectable-text PDF.
- Backup and restore of the managed source area and of external outputs. Sub-project 10 (operations) must cover them; this design gives it the manifest (§9.4) to work from.
- Storage capacity monitoring and protective read-only mode (A17–A19; sub-project 10). This design reports the source area's quota where the provider gives it (§8.6), nothing more.
- Moving to another provider. The manifest and relocation routine make it possible; the tool itself is later work.

### Anti-goals (failure even if it works)

- A person who cannot read an output in Kainow can open it in SharePoint because Kainow shared it, or a person who has left the project keeps Kainow-granted access.
- Kainow removes or changes an access that a SharePoint administrator or site owner granted.
- An output shown as Filed, Stored or Moved when the provider did not confirm it, or two authoritative copies of one output version.
- An approved output whose file has changed still showing as Approved without a flag.
- An export or generated file that contains Deleted content, an uncleaned held item, a restricted source's text for someone outside its audience, a private AI question, or a credential.
- A secret that stays readable in SharePoint (in the file, its version history or the recycle bin) after Kainow holds a file Kainow stored. (A registered link to a document Kainow did not create is hidden in Kainow and reported, not deleted, §4.7.)
- Evidence silently replaced: a source original edited in SharePoint and then served by Kainow as if unchanged.
- Kainow given access to every site and mailbox in the tenant.

## 2. Decisions taken with the Product Owner (20 November 2026)

| Topic | Decision |
|---|---|
| Scope | Outputs **plus** the A13 managed source area, in one sub-project. |
| Extracted text | **Both**: the original file, the extracted text and every version are preserved in the protected SharePoint area; the database keeps a working copy of the text for search, AI, quotes and cleaning. Kainow checks the preserved copy against recorded checksums and flags differences. |
| External permissions | **Kainow sets the permissions** on the files it files, keeping them in step with each output's audience. SharePoint administrators and site owners always keep their access; Kainow only adds and removes the grants it created. |
| Export policy | An Administrator switch "Project exports allowed", **Off** by default; when On, each project's PM, Owner or Sponsor (when delegated) chooses which roles may export, default PM, Deputy, Owner and Sponsor. Restricted material is never exported. |
| Providers | **SharePoint and OneDrive only in V1.0**, behind a connector boundary, with the flexibility to migrate out later (provider-neutral references, one relocation routine, a storage manifest). |
| Approach | **A**: Kainow's own Microsoft Graph client (no Graph SDK), `docx` and `pdfkit` for files (no headless browser), durable pg-boss jobs on a new `storage` queue. Not B (Graph SDK: large, hard to simulate, still needs our own upload and sharing logic) or a headless browser (≈300 MB image, a browser process and a security surface, against A17). |
| Size | One sub-project, roughly the size of sub-projects 5–7 together. |
| Directory lookup | **A configurable option** on the storage connection. On: the app also holds `User.ReadBasic.All` (read-only names and addresses), Kainow checks each person is an account in the tenant before sharing, and OneDrive destinations are available. Off (default): `Sites.Selected` only, Kainow shares only with addresses on the organisation's approved email domains, and only SharePoint library destinations are offered. |
| Sharing granularity | **Share folders, not files.** Project-wide outputs keep `Dept › Project › Year › Report Type`, and the project folder is shared once with the project's readers. Each output not readable by the whole project lives in its own folder `Dept › Project (restricted) › <Output title>`, shared only with its readers. Keeps items with their own permissions far below SharePoint's recommended limit. |

### 2.1 New Decision Register entries

| ID | Decision |
|---|---|
| D100 | **Output register and versions** (20 November 2026). Each project output has a stable identity, a title, one primary report type from a controlled list, optional additional categories (searchable metadata), an issue date whose UTC+8 year is its filing year, an author, named contributing people and departments (department recorded as at the contribution and never rewritten), and an "AI-assisted" label when any version came from an AI draft. Versions are immutable and numbered; each is Draft, Approved or Superseded. Any active participant may submit an output (a draft report, an uploaded document or a link to an existing document in an approved location); the PM or a Deputy registers it, sets its type, categories and issue date, and files it. Approval of one exact version follows the project's approval policy (one Owner or Sponsor by default; more if the policy requires) and never approves commitments in the text. Approving a version makes any earlier Approved version Superseded. A new version starts as Draft and never inherits approval. |
| D101 | **Output audience** (20 November 2026). An output is Project-wide (every person who may read the project's content) or Restricted to a named audience. An output built from material some project readers cannot read must be Restricted, and its audience may include only people who can read all of that material; the default audience is the PM, Deputies, Owner and Sponsors among them. The PM, Owner or Sponsor sets and changes the audience; widening shows who gains access before confirming. When material an output was built from is later deleted, held or restricted, the output is limited to PM, Deputies, Owner and Sponsors who can still read it and shows "Access review required" until one of them clears or withdraws it. |
| D102 | **Storage connection and destinations** (20 November 2026). An Enterprise Administrator connects Kainow to Microsoft 365 with an app registration whose secret is entered through a protected form, encrypted with the protected key and never shown again. The connection uses the "Sites.Selected" permission: it reaches only the sites the organisation's Microsoft administrator grants it, never every site or mailbox. The Administrator may switch on directory lookup, which adds read-only access to names and addresses in the directory (`User.ReadBasic.All`), so Kainow checks a person is an account in the organisation's tenant before sharing and can use OneDrive destinations; with it off (default) Kainow shares only with addresses on the organisation's approved email domains and offers SharePoint libraries only. The Administrator approves destinations (a SharePoint document library, or the OneDrive of a named account), each for one purpose: the protected source area (exactly one) or outputs (one or more). Kainow shows the permissions each destination needs before approval and checks them afterwards. Withdrawing a destination stops new filing there and keeps every existing reference. |
| D103 | **Filing and sharing** (20 November 2026). Kainow files an output version under `Owning Department › Project › Year › Report Type` in the project's chosen output destination, names it `<Title> v<n>.<ext>`, and reports it filed only when the provider confirms the upload and its checksum matches. An output not readable by the whole project is filed instead in its own folder `Owning Department › Project (restricted) › <Output title>`. Kainow shares folders, read-only: the project folder with the people who may read the project's content, each restricted output's folder with that output's readers. It adds and removes those grants as people join or leave the project or audience, and moves an output's files between the two places when its readers change, so a person never keeps access through a folder after losing it in Kainow. Kainow never removes or changes access it did not grant; site owners and SharePoint administrators keep theirs. A person Kainow cannot share with is shown as "Not shared in SharePoint". The output library must have its own permissions limited to site owners (site collection administrators count as others until the real-tenant probe confirms how they appear); Kainow refuses to approve a library where anyone else can read it and warns if that changes later. |
| D104 | **Managed source area** (20 November 2026). Every source version's uploaded original (if any) and extracted text are written to the protected source area, with the file identity and SHA-256 recorded; each version shows Stored, Waiting to store or Storage failed. Once storage is confirmed the original's bytes are removed from the database and downloads come from the source area through Kainow; the database keeps the working text. Kainow checks the stored files against their checksums when an original is downloaded and in a daily check, and flags a difference as "Changed in storage" instead of serving it. Only the service connection and storage Administrators have direct access; an Enterprise Administrator designates storage Administrators (not themselves), with a reason. When content is held (D80–D82), its stored files are removed permanently from the provider (not to its recycle bin) after their content is kept encrypted under the quarantine key; release puts them back. |
| D105 | **Formats** (20 November 2026). The supported catalogue is: inputs TXT, Markdown, DOCX, selectable-text PDF; outputs Markdown, DOCX, PDF and CSV (tabular reports only). The Enterprise Administrator approves which supported formats the organisation uses; a project uses all approved formats unless its PM, Owner or Sponsor (when the Administrator allows projects to change formats) removes some. Removing a format blocks new imports or generation in it and keeps every earlier file and record. Adding a format converts nothing. |
| D106 | **Project exports** (20 November 2026). Exporting a project's records as CSV needs current read access and an enabled export policy. The Enterprise Administrator's "Project exports allowed" is Off by default. When it is On, each project's export roles apply: by default PM, Deputy, Owner and Sponsor; the PM, Owner or Sponsor may choose from PM, Deputy, Owner, Sponsor, Member, Audit and Oversight. Exports never include Deleted content, uncleaned held items, source or message text, quotes, restricted material or private AI questions. Each export is recorded. An export may be saved as an output (a CSV version) for registering and filing. |
| D107 | **External checks and reconciliation** (20 November 2026). Kainow checks a filed file when it is filed and when someone opens it through Kainow, and daily when the Administrator turns scheduled checks on (Off by default). Each file shows Checked (with time), Changed, Moved, Missing, Access denied or Unverified, and the last check time. A Changed file never keeps its approval: the PM or a Deputy either registers the changed content as a new Draft version (Kainow saves it as a new file and, where the provider's version history still holds the recorded content, restores the original file to it) or leaves it flagged. A file moved or renamed within an approved destination is relinked by the PM or a Deputy; a file moved anywhere else can be relinked only after an Enterprise Administrator approves that place as a destination. Failed operations keep the last confirmed location. Deleting a register entry never deletes the external file. |
| D108 | **Owning department transfer** (20 November 2026). Only an Enterprise Administrator changes a project's owning department, with a reason, choosing for its filed outputs either "Move the folder" (to the new department's folder, verified before the reference changes) or "Keep it where it is" (labelled as kept at its existing approved location). History keeps the old department, the reason and the choice. Leadership department scopes follow the new owner (D89). Contributing departments and earlier attribution are unchanged. |

### 2.2 Earlier open items this touches

- D77 left "approval, the output register, filing and DOCX/PDF generation" to this sub-project. They are here; the D77 draft rules (private until shared, AI label, removal behaviour) are unchanged.
- The sub-project 7 design listed "project export policy" among delegated settings not yet built. It is built here (§7).
- Sub-project 1 left "Administrator department transfer". It is here (§10).
- R14: report types and the format catalogue are designed here (§4.4, §6.4). Departments already exist.

## 3. Concepts

| Term | Meaning |
|---|---|
| Output | A register entry: one deliverable of one project (D100). |
| Output version | One immutable version of an output: its file (or link), format, origin and status. |
| Origin | How a version came about: `draft_report` (rendered from a D77 draft version), `export` (CSV from records), `upload` (a file a person uploaded), `link` (an existing document in an approved location), `changed_file` (a changed filed file registered as a new version, D107). |
| Destination | An approved place in SharePoint or OneDrive, for the source area or for outputs (D102). |
| Stored file | One file Kainow put in, or registered from, a destination, with provider-neutral references (§5.2). Used for output files and source-area files alike. |
| Connector | The code that talks to one kind of provider through the connector contract (§5.1). V1.0: `graph` (SharePoint and OneDrive) and `local` (development and tests only, never offered in the interface). |
| Kainow grant | A read permission Kainow created on a stored output file for one person (D103). |
| Storage Administrator | A person an Enterprise Administrator designates for direct access to the source area (A14, D104). Not a project role and not implied by being an Enterprise Administrator. |

Dates and years use UTC+8 throughout (`todayUtc8`).

## 4. The output register

### 4.1 Submitting

Any participant with an Active membership (PM, Deputy, Owner, Sponsor, Member) of a project that is not Deferred or Closed may submit an output:

- **From a D77 draft report**: on a draft version they can read, "Submit as output", choosing a format the project allows (Markdown, DOCX or PDF). The version is rendered (§6) and stored in the database until filed.
- **An uploaded document**: a DOCX, PDF, Markdown or CSV file up to the existing upload limit (`MAX_UPLOAD_BYTES`), in an output format the project allows (*design call*: uploaded outputs are checked against the output list; TXT is an input format only, and other document types are registered by link instead). Its text is extracted with the existing readers and passed through the credential check; a suspected secret refuses the upload, naming only the kind found (as D79).
- **A link to an existing document**: a SharePoint or OneDrive link. Kainow resolves it through the provider (`/shares/{encoded}/driveItem`). It must lie inside an approved output destination (any, not only the project's); otherwise it is refused with "Kainow can only register documents in approved storage locations." It must not be a file Kainow filed, nor be or lie under a folder Kainow keeps (project, restricted, output, year, report type or source folders), because Kainow resolves the link with its own access; otherwise it is refused with "Kainow cannot register a document from the folders Kainow files outputs and sources in." (The same applies when a linked version is relinked.) It is registered at its existing location (D32) and labelled "Kept at its existing location". Kainow does not manage sharing for linked documents (it did not create their access), and says so: "Sharing for this document is managed outside Kainow". A linked document opens in SharePoint only ("Open"), so SharePoint decides whether the viewer may read it; Kainow never streams its bytes.
- **A saved export** (§7.3).

The submitter gives a title (1–200 characters) and a suggested report type. The output is created **Submitted**, with version 1 in Draft. A submitted output is visible to its submitter, the PM and Deputies (and, if Restricted, only those of them in its audience).

*Design call:* the PM or a Deputy may also submit; their submission may be registered in the same step.

### 4.2 Registering

The PM or a Deputy registers a submitted output, setting:
- title (may edit);
- primary report type (required, active types only);
- additional categories (zero or more report types, as searchable metadata);
- issue date (default today; its UTC+8 year is the filing year);
- contributors: people (project participants, current or former) and departments. The submitter is the author. People's departments are recorded as at registration (`department_id` copied, never rewritten, outputs rules §3). Contributing departments may be added from the project's participating departments or any active department. AI assistance is recorded automatically when a version's origin is `draft_report` whose draft version has `origin = 'ai'` or was edited from one;
- audience (§4.5).
- **Contributor departments** (build ruling, 20–21 November 2026): Kainow users carry no department, so the PM or Deputy picks each contributing person's department at registration (any active department); it is recorded and never rewritten.

Registering does not file and does not approve. The PM or Deputy may also decline a submission with a reason (the output becomes Declined, visible to the submitter; nothing is deleted).

### 4.3 Versions, approval and status

- A registered output gains new versions by the same routes as submission (draft report, upload, link, saved export), by the PM or a Deputy, or by a participant's submission that the PM or Deputy accepts into an existing output. Each version is Draft when created.
- **Approval** uses the existing approval machinery: a `change_requests` row of kind `approve_output`, target `output_version`, under the project's approval policy (D11, D12; one Owner or Sponsor by default; self-approval rules as D04). The request may be raised by the PM or a Deputy for a Draft version that is filed and whose last check is not Changed, Missing or Access denied (*design call*: approving an unfiled version would approve bytes nobody outside Kainow can see; linked versions must be checked first). Approving it, in one transaction:
  - sets the version Approved, recording the change request id as its approval reference;
  - sets any earlier Approved version Superseded;
  - writes an `output_events` row and a project History line.
- Approval approves the content of that version only. The approval screen says so: "Approving this document does not approve the commitments it mentions." (outputs rules §6, O13).
- A new version never changes an older one. A Draft version superseded by a later version before approval stays Draft (history keeps it).
- Rejected approval requests leave the version Draft.
- Output statuses: Submitted, Registered, Declined, Withdrawn (PM or Deputy, with a reason; a final state; its files move to its output folder, which has no Kainow grants, §5.5) and Deleted (sub-project 5 logical deletion, §4.7).
- (build ruling, 20–21 November 2026) The PM or a Deputy may accept a participant's submission into an existing registered output (accept-into: its versions become new Draft versions of that output). A Draft version cannot be approved once a later version is approved; approving a version supersedes pending approval requests for earlier versions; withdrawing, declining, deleting or holding an output ends its pending approval requests.

### 4.4 Report types (R14)

- A controlled list in `report_types`, maintained by the Enterprise Administrator on a "Report types" page (add, rename, retire; retire keeps history and blocks new selection, D54).
- Seeded: Status reports, Decisions and actions, Risk summaries, Specifications, Minutes, Exports, Other.
- D77 kinds map to default types when submitting a draft: status → Status reports, decisions_actions → Decisions and actions, risks → Risk summaries, specification → Specifications, free_form → Other.
- The report type name is used as the folder name at filing time; renaming a type later does not move filed files (§5.4).

### 4.5 Audience (D101)

- An output's audience is `audience_id` NULL (Project-wide) or a row in the existing `audiences` table (Restricted), reusing the audience model of sub-project 4a.
- When a version is built from material (a D77 draft records its passages in `ai_request_material` and its chosen sources), Kainow works out the set of people who can read every passage used, as D77's sharing check does (`draftAccess`). If that set is narrower than the project's readers, the output must be Restricted and its audience must be a subset of that set; the default is the PM, Deputies, Owner and Sponsors in that set. Uploaded and linked versions have no Kainow material: their audience is the PM's choice, default Project-wide.
- A version whose material is narrower than the output's current audience cannot be added until the audience is narrowed (the screen offers it).
- The PM, Owner or Sponsor (O09) changes the audience with a reason; widening shows the names that gain access before confirming. Every change is recorded in `audience_events` and syncs SharePoint sharing (§5.5).
- **Removed material (D101):** `onMaterialRemoved` (sub-project 5) gains an output handler: an output with any version built from removed material becomes `review_required`; its readers are limited to the PM, Deputies, Owner and Sponsors who can still read the remaining material; its files move to its own output folder shared only with them (§5.5); and it shows "Access review required" to them. They clear it (back to its audience) or withdraw the output. The same applies when a passage's source audience tightens.
- (build ruling, 20–21 November 2026) An output's material is every AI version of its draft (conservative: it may over-flag, never under-flag), and one material-readers rule is used everywhere. Clearing a review is refused until the audience fits the remaining material. Changing the audience, clearing and withdrawing for review are open to the PM, Owner or Sponsor who can read the project and the remaining material; membership of the audience itself is not required.

### 4.6 Who sees what

- Readers of an output: people who may read the project's content today (`canReadContent`: Active membership, or an Active Audit/Oversight grant within its scope), further limited to its audience when Restricted, and to the review rule in §4.5. Leadership grants never include outputs.
- Register fields visible to every reader: title, report type, categories, issue date, author, contributors, AI-assisted label, versions with status, filing state and check state, and an Open link. *Design call:* the approval request link and history are visible to readers too; the file's provider path is visible to the PM, Deputies, Owner and Sponsors only (it may name folders others cannot open).
- Submitted and Declined outputs: submitter, PM and Deputies (within the audience).

### 4.7 Deletion, holds and search

- **Deletion:** register entries are logically deleted by the PM or a Deputy, with a reason, following the sub-project 5 rules for deleting content (actor, time, reason; hidden from ordinary views, search and exports; restorable by the PM or a Deputy). Deleting moves its files to its output folder, which has no Kainow grants; restoring moves them back (§5.5). **The external file is never deleted** (O13, C56).
- **Holds (D80–D82):** output versions are registered with the quarantine text registry. Any reader may report a suspected secret in an output (marking text in the register's title or categories, or for a file describing where it is). A held output version is hidden at once and its stored file **withheld** (§8.5): its bytes downloaded, encrypted into `quarantine_originals`, and the file permanently deleted from the provider. The file cannot be cleaned in place; the PM or a Deputy replaces it with a new version. A security reviewer's false-alarm release re-uploads the original to the same folder.
- **Held links** (*design call*): a linked version's document was not created by Kainow and Kainow never deletes it. Holding it hides it in Kainow only; the Enterprise Administrators, the storage Administrators and the PM receive a notice: "A document registered in <project> may contain a credential. Kainow has hidden it, but the file is still in storage at its existing location and must be dealt with there." The case lists it under "Still in storage". This is the one stated exception to the anti-goal on secrets left readable in storage.
- **Search:** register entries (title, report type, categories; never file content) join the cross-project search index under the existing search rules, filtered by output readers.
- (build ruling, 20–21 November 2026) An output file cannot be cleaned in place, so when a possible copy of a held secret is found in an output its files are withheld pending the PM's or a Deputy's decision: dismissing the copy restores them, confirming keeps them withheld. Cleaning an output's title queues a rename of its folder and files in SharePoint to the cleaned title. Withholding is tracked per file and case (`stored_file_withholds`); a file comes back only when no open case still holds it. A held link is hidden in Kainow and reported, never deleted. Whether an original is withheld is derived from its stored file.

## 5. Storage: connector, filing and sharing

### 5.1 The connector contract

All storage code outside `app/src/storage/connectors/` uses one interface; nothing else knows about Microsoft Graph.

```ts
interface StorageConnector {
  kind: 'graph' | 'local';
  checkDestination(dest: DestinationRef): Promise<DestinationCheck>;        // reachable, permissions held, quota, broad sharing found
  ensureFolder(dest: DestinationRef, parentId: string | null, name: string): Promise<FolderRef>;
  upload(dest: DestinationRef, folderId: string, name: string, bytes: Buffer, opts: { conflict: 'fail' }): Promise<StoredRef>;
  findChild(dest: DestinationRef, folderId: string, name: string): Promise<StoredRef | null>;   // for uncertain outcomes
  getItem(dest: DestinationRef, itemId: string): Promise<ItemState>;          // exists, path, size, hashes, eTag, cTag, webUrl
  download(dest: DestinationRef, itemId: string): Promise<Buffer>;
  move(dest: DestinationRef, itemId: string, newParentId: string, newName?: string): Promise<StoredRef>;
  copyTo(src: DestinationRef, itemId: string, dst: DestinationRef, folderId: string, name: string): Promise<StoredRef>; // relocation across destinations
  removePermanently(dest: DestinationRef, itemId: string): Promise<void>;
  listVersions(dest: DestinationRef, itemId: string): Promise<ItemVersion[]>;          // provider version history, with hashes where given
  restoreVersion(dest: DestinationRef, itemId: string, versionId: string): Promise<void>;
  lookupPerson(email: string): Promise<'account' | 'not_found' | 'unknown'>;           // 'unknown' when directory lookup is off
  grant(dest: DestinationRef, itemId: string, email: string, role: 'read' | 'write'): Promise<GrantResult>; // item is a folder; { permissionId } | { notFound: true }
  revoke(dest: DestinationRef, itemId: string, permissionId: string): Promise<void>;
  listPermissions(dest: DestinationRef, itemId: string): Promise<PermissionInfo[]>;
  resolveLink(url: string): Promise<{ dest: DestinationRef | null; item: ItemState }>;
}
```

Kainow grants only on folders (§5.5), never on individual files.

- Errors are one typed class `StorageError { code: 'unreachable' | 'timeout' | 'throttled' | 'unauthorised' | 'forbidden' | 'not_found' | 'conflict' | 'too_large' | 'quota' | 'server' | 'invalid'; retryAfterMs?; status? }`. No error carries a token, secret or file content.
- The `local` connector writes under a directory given by `KAINOW_LOCAL_STORAGE_DIR`. It is selectable only when `NODE_ENV !== 'production'` and never appears in the interface; it lets developers run Kainow without a Microsoft tenant and lets tests run end to end. Its "grants" are recorded in a JSON sidecar so sharing tests can assert them.
- A later Dropbox or Box connector implements the same contract. Where a provider's sharing does not map to organisation accounts, the connector reports `grant` as unsupported and the output shows "Sharing managed outside Kainow" (this is the only behaviour difference the rest of Kainow allows for).
- (build ruling, 20–21 November 2026) `checkDestination` takes a test person (the checking Administrator) and proves it can create and remove a folder permission for them. `createFolder` (create-only: anything with the name already is a conflict) exists alongside `ensureFolder`; project, restricted-root and output folders are create-only, never adopted, taking ` (2)`, ` (3)` suffixes when the name is taken. The library permission check (§5.5) refuses any permission other than the site owners' group, Kainow's own application and Kainow's own grants (for a OneDrive destination also the account itself; for the source area also the storage Administrators). Site collection administrators who appear as site users count as others until a real tenant confirms how they appear (probe, §15).

### 5.2 Stored-file references (provider-neutral)

Every file Kainow stores or registers has one `stored_files` row: connector kind, destination id, the provider's drive id and item id, the path as last confirmed, name, size, SHA-256 (computed by Kainow from the bytes it sent or downloaded), the provider hash (QuickXorHash for SharePoint and OneDrive, computed by Kainow before upload and compared with the provider's), the provider's eTag and cTag, the web URL, its state and its last check. Nothing outside the connector stores a provider URL as an identity: the web URL is kept only to open the file.

States: `pending` (waiting to store), `storing`, `stored` (confirmed), `failed` (attempts exhausted; shown as failed with the reason category), `withheld` (held, §8.5), `relocating`, `missing`, and for registered links `linked`.

### 5.3 The Microsoft Graph connector

- **Token:** client credentials against `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with scope `https://graph.microsoft.com/.default`. `M365TokenSource` (sub-project 3) is generalised to take its scope; email keeps its own instance and settings unchanged. The storage credentials come from the storage connection (§8.1), not from environment variables.
- **Permissions requested (shown on the connection page, Q06 "register requested permissions"):** application permission `Sites.Selected`, plus `User.ReadBasic.All` only when the Administrator switches directory lookup on (§8.1). For each destination's site, the organisation's Microsoft administrator grants the app `fullcontrol` on every Kainow site: on output sites managing sharing on folders needs it, and on the source-area site Kainow grants storage Administrators access to its `projects` folder. *To verify with the probe:* whether `write` suffices for folder invitations in the tenant; if it does, the page asks for `write` only.
- **Who Kainow will share with:** with directory lookup on, `lookupPerson` (`GET /users/{email}?$select=id,userType,accountEnabled`) must return an enabled `Member` account; guests and unknown addresses are `not_found`. With it off, Kainow shares only with addresses whose domain is one of the organisation's approved email domains (sub-project 1), and invites with `requireSignIn: true`; the Storage page states that the tenant should block guest sharing on Kainow's sites, and the destination check reports the site's sharing capability where Graph exposes it.
- **Calls used:** `GET /sites/{hostname}:/{path}` and `GET /sites/{id}/drives` (resolve a library), `GET /users/{upn}/drive` (OneDrive of a named account), `POST /drives/{d}/items/{parent}/children` (folders, `@microsoft.graph.conflictBehavior: fail`), `PUT /drives/{d}/items/{parent}:/{name}:/content` for files up to 4 MiB and `createUploadSession` with 5 MiB chunks (a multiple of 320 KiB) above that, `GET /drives/{d}/items/{id}` (with `select` of size, file.hashes, eTag, cTag, parentReference, name, webUrl), `GET …/content`, `PATCH /drives/{d}/items/{id}` (move and rename), `POST …/copy` with monitor polling (relocation across drives), `POST …/permanentDelete`, `GET …/versions` and `POST …/versions/{id}/restoreVersion`, `POST …/invite` on folders (`roles: ['read']` or `['write']`, `requireSignIn: true, sendInvitation: false`, one recipient), `GET …/permissions`, `DELETE …/permissions/{id}`, `GET /shares/{u!base64url}/driveItem`, and (directory lookup on) `GET /users/{email}`. OneDrive destinations need directory lookup to resolve `GET /users/{email}/drive`; with it off the destination form offers SharePoint libraries only.
- **Timeouts and retries:** 30 seconds per call, 120 seconds per upload chunk. `429` and `503` honour `Retry-After`. Calls inside a job are not retried in place; the job is (§5.6). Each `AbortSignal.timeout` test keeps an interval alive (the sub-project 7 Node 22 lesson).
- **Uncertain outcomes (A11):** when an upload's result is unknown (timeout, lost connection), the next attempt first calls `findChild` for the same name: if a file is there whose QuickXorHash and size match the bytes, it is adopted as the result; if a different file is there, the attempt fails `conflict` and the output shows "A different file already has this name" for the PM to resolve (§5.4 naming). No second authoritative copy is created.
- **Directory lookup as built** (build ruling, 20–21 November 2026): with `User.ReadBasic.All` the lookup selects only `id`, `userPrincipalName` and `mail` (`userType` and `accountEnabled` are not readable with that permission); a `userPrincipalName` containing `#EXT#` is a guest and is not shared with. A disabled Microsoft account cannot be detected this way; Kainow still withholds grants from disabled Kainow accounts.

### 5.4 Filing an output version

The PM or a Deputy files a registered output's version (or registers and files in one step). Linked versions are not filed (they stay where they are).

- **Destination:** the project's output destination (§8.3). With none, filing is refused: "Choose where this project files its outputs first (Project settings › Outputs)."
- **Path:** for an output whose readers are the whole project (Project-wide, not in review), `<department folder> / <project folder> / <issue year> / <report type folder> / <Title> v<n>.<ext>`. For any other output (Restricted, in review, or Withdrawn or Deleted, §5.5), `<department folder> / <project folder> (restricted) / <output folder> / <Title> v<n>.<ext>`, where the output folder is the output's title made safe, with ` (2)` and so on when another output in the project has the same title. Every version of an output lives in the same one of these places.
  - Folder and file names are made safe for SharePoint: the characters `" * : < > ? / \ |` and leading or trailing spaces and dots are replaced with `-`; names are cut to 100 characters; the whole path must stay under 400 characters (title cut further if needed).
  - Kainow records the item id of each department, project, year and type folder it creates (`storage_folders`) and reuses them by id. Renaming a department, project or report type in Kainow does not rename or move existing folders; new filings go to the existing folder (*design call*: one authoritative location per project; renames are cosmetic in storage). A department transfer is the only thing that moves a project folder (§10).
  - If a different file already has the name, Kainow does not overwrite: it uses `<Title> v<n> (2).<ext>`, then `(3)`.
- **Outcome:** filed only when the provider returns the item and its QuickXorHash and size match. The version then shows "Filed" with the path (to PM/Deputy/Owner/Sponsor) and an Open link. Failure after the retries (§5.6) shows "Filing failed — <reason>" with "Try again"; nothing is shown as filed.
- **After filing**, the version's bytes are removed from the database (`output_version_bytes`), since the file now lives in the destination. *Design call:* a Draft version not yet filed keeps its bytes in the database until it is filed, withdrawn, or 90 days pass without filing, after which the bytes are dropped and the version shows "Not filed — file no longer kept; generate or upload it again". Kainow is not the document store (outputs rules §2).
- Sharing for the new file is set at once (§5.5).
- (build ruling, 20–21 November 2026) `safeName` strips (rather than replaces) leading and trailing spaces and dots. An output's placement folder is fixed when its first version is filed: later edits to its issue date or report type do not move files. Filing records its exact target (destination, folder, name) before uploading, and a retry adopts only a file found at its own recorded target.

### 5.5 Sharing (D103)

Kainow shares **folders**, never individual files, read-only, so the number of items with their own permissions in a library stays about one per project plus one per restricted output.

- **Two kinds of shared folder:**
  - the **project folder** (`<department> / <project>`, in each output destination that holds one): desired grants are one read grant per person who may read the project's content today (`canReadContent`, including Active Audit/Oversight grant holders within scope);
  - each **output folder** under `<department> / <project> (restricted)`: desired grants are one read grant per current reader of that output (§4.6, including the review rule of §4.5). A Withdrawn or Deleted output's folder has no Kainow grants. The `(restricted)` parent folder itself has no Kainow grants.
- **Placement follows readers:** when an output's readers stop being "the whole project" (audience narrowed, review required, withdrawn, deleted) its files are moved (same drive: `move`, item ids kept) into its output folder; when they become the whole project again (audience widened to Project-wide, review cleared, restored), they are moved back into `Year / Report Type`. **Order matters:** when narrowing, the files are moved out of the project folder *before* anything else, and the output is hidden in Kainow from people losing access at once (Kainow's own check needs no SharePoint step); when widening, grants are never removed first. A move that fails leaves the output hidden in Kainow from the people who would have lost access, and listed under "Sharing to repair".
- Approval status does not matter: readers can open Draft and Superseded versions too (*design call*: matches Kainow's own view).
- **Sync** is one job per shared folder (`share-sync`). It compares desired grants with `storage_grants` rows (the grants Kainow created) and calls `grant` / `revoke` for the difference only. It never alters any permission not in `storage_grants`. (build ruling, 20–21 November 2026) The 30-second debounce is dropped (removal is urgent; the per-folder queue coalesces bursts). Kainow lists a folder's permissions before inviting: a person who already holds a permission Kainow did not create is recorded as `external` and is never invited over, changed or revoked. Revocation never re-invites. A grant refused with a 4xx is recorded as never created.
- **Triggers:** filing (first output of a project creates and shares the project folder); audience change; membership becomes Active, On Hold, Expired or Revoked; an Audit/Oversight grant starts, ends or is revoked; account disabled or re-enabled; output deleted, restored, withdrawn, held or released; review state change (§4.5). A daily reconciliation (the `sweep` tick, 02:30 UTC+8) re-syncs every project folder whose project's readers changed by date (expiry has no event) and repairs drift.
- **Not shared:** when directory lookup says the address is not an enabled member account, or (lookup off) its domain is not an approved organisation domain, or the provider refuses the invitation as an unknown user, the grant row records `not_found` and the person's name shows "Not shared in SharePoint — no Microsoft account found for <email>" to PM/Deputy/Owner/Sponsor; the person can still read the output in Kainow. Retried by the daily reconciliation.
- **Removal is urgent:** revocations and narrowing moves are queued at higher priority than grants. A revocation that keeps failing raises an Administrator notice ("Kainow could not remove SharePoint access for a person who has left <project>") and stays listed in the Storage page's "Sharing to repair" list until it succeeds.
- **Library permission check (D103):** SharePoint gives every item the library's own permissions as well as Kainow's grants, and Graph cannot break inheritance, so the output library must be set up (by the organisation's SharePoint administrator, INSTALL.md) with unique permissions limited to site owners. Approving an output destination, and each daily check, lists the destination root's permissions. Any permission other than the site's owners group, the Kainow app itself and Kainow's own grants — including a site Members or Visitors group, a named person, any other group, or a sharing link of any scope — refuses approval with "Others can open everything in this library: <who>. Limit the library to site owners before approving it." Site collection administrators count as others until the real-tenant probe confirms how they appear (build ruling, §5.1). For an already approved destination it raises an Administrator notice and a warning on the Storage page and on every project using it; filing continues. Kainow never removes those permissions itself.

### 5.6 Storage jobs

- A new pg-boss queue `storage` (`QUEUES.storage`), worked by the worker process with `localConcurrency: 2` (*design call*: Graph throttles per app; two keeps within it at Kainow's scale).
- Job kinds: `file-output`, `store-source`, `share-sync`, `place-output` (move an output's files between the project tree and its output folder, §5.5), `check`, `register-changed`, `relocate`, `withhold`, `restore-withheld`, `register-link`. Job data carries only ids.
- **Attempts:** initial plus four retries at 1 minute, 5 minutes, 30 minutes and 2 hours after the first failure (provider `Retry-After` wins when later). `unauthorised`, `forbidden`, `invalid` and `too_large` are not retried. Attempts survive restarts (pg-boss `retryLimit`), and every attempt rechecks project state, the output's or source's status, destination approval and the connection before acting (A11).
- Producers on the API side enqueue inside the same transaction as the change through a `storage_outbox` row (*design call*: the email outbox pattern), and a one-minute tick enqueues any outbox rows not yet sent, so a lost nudge never loses work.
- (build ruling, 20–21 November 2026) Job kinds as built: `file-output`, `store-source`, `share-sync`, `place-output`, `check`, `register-changed`, `relocate`, `transfer-folders`, `rename-output`, `withhold`, `restore-withheld`, `backfill-sources` (no `register-link`: links are resolved at submission). Retries at 1, 5, 30 and 120 minutes after the first failure. A change that collides with a queued job for the same subject refreshes that job (due now, the higher priority, a fresh attempt budget). The worker keeps a 60-second heartbeat.
- A `storage_attempts` row records each attempt: job kind, subject, outcome code, provider status, duration. Never content, names of people, or tokens.

### 5.7 Opening a filed output

"Open" goes through Kainow: `GET /projects/:id/outputs/:outputId/versions/:n/open` checks the reader's access, runs a quick check of the file (§9.1, at most once a minute per file), and redirects (303) to the file's web URL. If the check finds Missing, Changed or Access denied, it shows that state instead of redirecting, with what the PM can do. Kainow never shows a raw web URL in a list (links do not grant access, and stale URLs mislead). "Download a copy" (readers) streams a file Kainow filed through Kainow from the provider. A linked document has no download: Kainow's app-only access cannot prove the viewer's own, so it is opened in SharePoint only and the download is refused with "A linked document opens in SharePoint only. Use Open."

### 5.8 Checks and reconciliation of output files (D107)

- **When:** at filing (part of confirming it), on Open (§5.7), and daily for every stored output file when `storage_settings.scheduled_checks` is on (at most 2,000 files a day across the installation, oldest check first). Registered links are checked the same way when their document is in an approved destination.
- **What:** `getItem` by item id. Results: **Checked** (size and provider hash match the record; time shown); **Changed** (hash or size differs); **Moved** (the item exists but its parent or name differs from the recorded path); **Missing** (404); **Access denied** (403, or the destination withdrawn or its site permission removed); **Unverified** (never checked, or the provider could not be reached; the previous result stays visible with its time).
- Each newly found Changed, Moved or Missing writes an `output_events` row and notifies the PM and Deputies (in-app).
- **Changed:** the version keeps its recorded status in Kainow (an Approved version stays Approved as a record) but shows "File changed since approval — this is not the approved content" and cannot be the subject of a new approval request. The PM or a Deputy may:
  - **Register the changed content as a new version**: Kainow downloads the current content, uploads it as a new file `<Title> v<n+1>.<ext>` in the same place, and records a new Draft version (origin `changed_file`). Then Kainow looks through the provider's version history of the original item (`listVersions`) for a version whose size and hash match the record; if found it restores it (`restoreVersion`) and the original version is Checked again; if not, the original stays Changed with "The approved content could not be recovered from storage". Two versions never share one stored file.
  - **Leave it flagged.**
- **Moved:** if the new place is inside an approved destination, the PM or a Deputy relinks (the reference and path update, `stored_file_moves` records old and new). If it is in a place Kainow cannot reach or that is not approved, the file shows Missing or Access denied; an Enterprise Administrator must first approve that place as a destination (§8.2), after which the PM or a Deputy relinks. There is no separate approval flow. A relinked file in a different destination is labelled with its destination (D32), and its sharing stays as it is there (Kainow shares only its own folders).
- **Missing:** shown as Missing with the last confirmed path; the PM or a Deputy may relink by giving a link to the file's new place (resolved and checked as above) or file the version again from a fresh upload as a new version.
- (build ruling, 20–21 November 2026) Registering changed content is a job (the route answers 202); it applies only to files Kainow filed (never a registered link), uploads into the output's placement folder, and downloads at most 50 versions of the recorded size from the version history. A Moved file opens at its current location. Opens make at most one provider check a minute per file.

## 6. Generated files

### 6.1 One content model

D77 draft versions are a single Markdown body (sub-project 4b). Rendering parses it with `marked`'s lexer (tokens only; no HTML rendering) into a small block model: headings (levels 1–3), paragraphs with bold, italic, code and links, bulleted and numbered lists (two levels), tables, block quotes, footnote references and definitions (the `## Sources` list), and horizontal rules. Anything else is rendered as plain text. Links in generated files are written as text plus the URL; Kainow record links (`#/…`) become absolute links to `APP_URL`.

### 6.2 Renderers

- **Markdown:** the stored body, with a header block.
- **DOCX** (`docx` library): Word styles Heading 1–3, Normal, List Bullet, List Number, Table Grid; footnotes as a numbered "Sources" list at the end.
- **PDF** (`pdfkit`): A4, 20 mm margins, an embedded open-licence font with Latin Extended coverage for English and Bahasa Melayu (Noto Sans regular, bold and italic, bundled under `app/assets/fonts` with its OFL licence), page numbers in the footer.
- **CSV:** §7.2.

Every generated file carries a header from the letterhead (`loadLetterhead(db, 'report')`: organisation name and the wide logo in a 120×40 box; Kainow's own until the organisation registers, D71):
- the output title, the project name, report type, version number and issue date;
- the status at generation: "Draft — not approved" (the file's content is never changed after filing, so an approved file keeps the words it was approved with; the register shows its approval);
- "Prepared with AI assistance; facts from Kainow records" when the source draft had AI content (the D77 "AI draft — not approved" line is kept in the body as written);
- "Generated by Kainow on <date time> UTC+8".

The footer of DOCX and PDF repeats title, version and page number.

### 6.3 Checks before a file is generated or stored

- The draft version must be readable by the requester and not withdrawn, held or in review (D76–D78 rules, `draftAccess`).
- The rendered text passes the credential check (D75/D79); a suspected secret refuses with the kind found.
- The format must be allowed for the project (§6.4).
- Size: generated files over 25 MiB are refused ("This document is too large to generate").

### 6.4 Format catalogue (D105)

- Supported (fixed in code): inputs `txt`, `md`, `docx`, `pdf`; outputs `md`, `docx`, `pdf`, `csv`.
- `storage_settings.approved_input_formats` and `approved_output_formats` (Administrator, with a reason; all on by default; at least one input format).
- `project_output_settings.input_formats` / `output_formats`: NULL means "all approved"; otherwise a subset, set by the PM, Owner or Sponsor when `storage_settings.projects_may_change_formats` is on (default on), else by the Administrator only.
- The effective list is the intersection, shown with where each value comes from (Q01).
- The notes import (sub-project 2) checks the effective input formats before reading a file: "This project does not accept PDF files. A PM, Owner or Sponsor can change this in Project settings › Outputs." Pasted text is always allowed.
- Removing a format affects new imports and generation only.

## 7. Exports (D106)

### 7.1 Policy

- `access_settings.project_exports_allowed` (sub-project 7's table; new column, default **false**), on the Access and records page with the analytics export switch, changed with a reason through the existing access-settings change history.
- `project_output_settings.export_roles text[]`, default `{pm,deputy,owner,sponsor}`, set by the PM, Owner or Sponsor (when `storage_settings.projects_may_set_export_roles` is on, default on) or the Administrator; choices pm, deputy, owner, sponsor, member, audit, oversight.
- Export allowed = project exports allowed AND the person may read the project's content (`canReadContent`) AND one of their current roles (or an Active Audit/Oversight grant's kind) is in the export roles. Rechecked when the file is built.
- Allowed while the project is Deferred or Closed (exports are read-only); archived projects too.

### 7.2 What can be exported

From the project's Work and Records views, "Export CSV" for: Tasks (with subtasks, parent id), Decisions, Questions, Risks, and the output register. Each uses the live-record filters of sub-project 5 (`liveRecordSql`: Deleted excluded; held records only once cleaned, showing "Credential removed — under review" in place of text) and the screen's current filters.

| Export | Columns |
|---|---|
| Tasks | id, parent id, title, assignee, assignee department, status, due date, next review, overdue (yes/no), completed on, created on, authorised on |
| Decisions | id, statement, rationale, status, authorised on, replaced by |
| Questions | id, question, requester, status, answers (count), resolved on |
| Risks | id, description, severity, status, responsible person, review date, accepted reason |
| Output register | id, title, report type, categories, issue date, author, latest version, latest status, filing state, last check |

- Text columns are records' own fields (titles, descriptions, statements), which every content reader may see; no source or message text, quotes or AI questions. Cut at 2,000 characters per cell.
- CSV conventions from sub-project 7 (`csv.ts`): `#` header lines (Export, Project, Filters, Computed at UTC+8, Coverage: "All authorised records in the project except deleted ones and any under credential review"), formula guard (`'` before `= + - @`), CRLF, UTF-8 with BOM (*design call*: so spreadsheet programs read Malay characters correctly).
- Each export writes `writeAudit` action `project.exported` with project id, export kind, filters and row count — never data.
- (build ruling, 20–21 November 2026) In the Tasks export, "assignee department" is blank (users carry no department), "next review" is blank (tasks have no review date) and "created on" equals "authorised on". A downloaded export is a personal view; an output-register export saved as an output includes only outputs every content reader may read.

### 7.3 Saving an export as an output

"Save as output" (anyone allowed to export who may also submit outputs) creates a submitted output (or a new version of a chosen existing one) with origin `export`, report type Exports by default, Project-wide audience. Registering, filing and approval then follow §4.

## 8. Administrator storage settings

### 8.1 The connection

System Settings › Storage, Enterprise Administrator only:
- **Directory lookup** switch (default Off, D102). Turning it on asks the Administrator to confirm the extra `User.ReadBasic.All` permission has been granted, and runs a lookup of their own address to check it; turning it off is refused while an OneDrive destination is approved. Changes need a reason.
- Tenant ID, application (client) ID, client secret (protected form; never shown again; trimmed, 10–200 printable characters). Sealed with `ProtectedKey` (AES-256-GCM) with associated data `kainow.storage-secret:<connection id>`, through a helper `app/src/storage/secret.ts` (`sealStorageSecret`, `openStorageSecret`); a test enforces that only the Graph client factory and the connection check import `openStorageSecret`, as sub-project 6's key-import test does.
- Rows are append-only (`storage_connection_secrets`, `superseded_at`), as `ai_connection_keys`.
- **Check connection** requests a token and calls `GET /sites/root?$select=id` expecting 403 (Sites.Selected without a grant on the root site), reporting: "Connected" (token issued), "Microsoft refused these credentials" (401/400 from the token endpoint), or "Could not reach Microsoft".
- Without the protected key, saving is refused ("Storage credentials cannot be saved until the protected key is installed. See INSTALL.md.") and every storage job waits with state `waiting_for_key`.
- The page lists the exact permissions to grant (§5.3) and, per destination, the PowerShell or Graph request the Microsoft administrator runs to grant the site permission (with placeholders, no real names).
- Every change records actor, reason, time and non-secret previous/new values (`storage_settings_changes`), and `writeAudit` `storage.connection_changed` with no secret.

### 8.2 Destinations

- Add: kind (SharePoint library: site URL plus library name; OneDrive, only with directory lookup on: the account's email address and an optional folder), purpose (source area or outputs), label. Kainow resolves the ids and runs `checkDestination`: reachable, can create a folder (a `.kainow-check` folder, created then left), can upload and permanently delete a 1-byte test file, can list and create folder permissions, and the library permission check (§5.5; for the source area the same check, with storage Administrators also expected). It records the result and shows each line.
- Approve with a reason (requires a passing check). Exactly one approved source-area destination at a time (§9.3 changes it).
- Withdraw with a reason: no new filing or storing there; existing stored files keep their references and checks; projects using it show "Choose a new output location".
- A destination's root folder is the root of the library, or the chosen OneDrive folder. Kainow creates everything under it.

### 8.3 Project output settings

Project settings › Outputs (PM, Owner or Sponsor when `storage_settings.projects_may_choose_destination` is on, default on; otherwise the Administrator; read-only while Deferred or Closed except as below):
- the project's output destination (from approved output destinations; SharePoint suggested first, Q06). Changing it applies to new filings only; already filed files stay where they are and are labelled with their destination (D32).
- formats (§6.4);
- export roles (§7.1).

Changes need a reason and are versioned (`project_output_settings_changes`), as other project settings (D61).

### 8.4 Storage Administrators (A14, D104)

- An Enterprise Administrator designates a person (an Active account) as a storage Administrator with a reason, and ends a designation with a reason. Not themselves (*design call*, mirroring D82's security reviewers, so direct access always involves two people).
- Kainow grants each designated person `write` on the source-area root folder (through the connector's `grant` with role `write`, recorded in `storage_grants`) and revokes it when the designation ends or the account is disabled. Being an Enterprise Administrator gives nothing here.
- The daily check lists the source-area root's permissions and warns on the Storage page ("The source area is also open to: <names or 'a sharing link'>") when anyone beyond the designated people, the connection and site owners has access. Kainow never removes those itself.
- Designations are recorded (`storage_admin_events`) and listed on the Storage page.
- (build ruling, 20–21 November 2026) Storage Administrators get `write` on the recorded `projects` folder of the source area (the connector refuses grants on a library root); everything Kainow stores there lives under it. Grants follow approved and retiring source areas and are revoked when an area is withdrawn. Self-designation is refused.

### 8.5 Withholding stored files (holds)

When sub-project 5's cleaning withholds `source_versions.original_bytes` or holds an output version, the `withhold` job:
0. for an output file under the shared project folder, first moves it into the output's own folder, which has no Kainow grants (so readers lose SharePoint access even if later steps fail);
1. downloads the stored file and checks its SHA-256 against the record;
2. encrypts it into `quarantine_originals` (as the database bytes are today) in the same transaction that marks the stored file `withheld`;
3. calls `removePermanently` (Graph `permanentDelete`, which skips the recycle bin and removes the item's version history);
4. for a source version, uploads the cleaned text as a new text file and records it (the old text file, which held the secret, was removed in step 3).

If step 3 fails after retries, the item stays hidden in Kainow, an Administrator notice says "A held file could not be removed from storage" (never naming the secret), and the case shows "Still in storage" until it succeeds. Release (D82 false alarm, or a reviewer restoring) runs `restore-withheld`: the original is decrypted and uploaded to the same folder, the reference updated, and grants re-synced.

(build ruling, 20–21 November 2026) Withholding is tracked per file and case; see §4.7 for possible copies found in output files.

### 8.6 Storage page summary

The Storage page shows: connection state; destinations with purpose, last check and warnings; the source area's file count and total size from `stored_files`, and the provider's quota where it reports one ("Unavailable" otherwise, never zero, A17); counts of files waiting, failed and withheld; "Sharing to repair"; storage Administrators; scheduled checks switch; the manifest download.

## 9. The managed source area (A13, D104)

### 9.1 Storing source versions

- Layout under the source-area root: `projects/<project id>/sources/<source id>/v<version no>/original.<ext>` and `…/text.txt` (UTF-8). Ids, not names, so renames and audience changes never move evidence and paths reveal nothing.
- `insertVersion` (notes) adds `stored_files` rows `pending` for the original (uploads only) and the text, and a `storage_outbox` row, in its existing transaction. Import stays as fast as today.
- The `store-source` job uploads both files, verifies size and QuickXorHash, records them `stored`, and then, in one transaction, sets `source_versions.original_bytes = NULL` (keeping `original_sha256`) and `original_stored_file_id`. The text stays in `text_content`.
- Each version shows Stored, Waiting to store or Storage failed (to the PM, Deputies, Owner and Sponsors; others see nothing). Waiting and failed versions keep working normally in Kainow; nothing waits on storage.
- Versions created by minutes publication, typed-meeting publication, approved summaries and pasted text store `text.txt` only.
- Without an approved source area (or without the connection), versions stay `pending` and keep their bytes; the go-live checklist step "Storage connected and source area approved" (§12) stays open. When one is approved, a backfill job stores every pending version oldest first, 100 per run.

### 9.2 Downloading and checking originals

- `GET notes/:id/versions/:n/original` (existing, `note.view`) streams from the database while the bytes are still there, otherwise downloads the stored file through the connector, checks its SHA-256 against `original_sha256`, and only then streams it with the existing headers. A mismatch refuses with "This file has changed in storage since Kainow recorded it. It has been flagged for the storage Administrators." and marks the stored file Changed; an unreachable provider refuses with "The file store cannot be reached right now".
- The daily source-area check (when scheduled checks are on, and always for files never checked) calls `getItem` for each stored source file, oldest check first, at most 2,000 files per day (*design call*: keeps within Graph limits), comparing size, QuickXorHash and eTag. A difference marks it Changed in storage; a missing item marks it Missing. Each newly flagged file sends one Administrator and storage Administrator notice (project name and source title only if the recipient may read it; otherwise "a source in <project>").
- A flagged file is never used again for downloads. The working text in the database is unaffected; quotes and approvals keep pointing at the recorded version.

### 9.3 Moving the source area

An Enterprise Administrator may change the source-area destination (with a reason and a confirmation that states the file count and size). Kainow then relocates every stored source file with the relocation routine (§9.4): copy, verify size and hash at the new place, switch the reference, permanently remove the old copy. The Storage page shows progress; downloads use whichever copy is current. A file that fails stays at its old place (which stays approved for reading until the move completes).

(build ruling, 20–21 November 2026) The move uses a transitional `retiring` status for the old destination: it stays readable until every file has moved, then is withdrawn. One move runs at a time, and the confirmation must equal the current file count and size.

### 9.4 Relocation routine and manifest (migrate-out)

- **Relocate one stored file:** set `relocating`; `copyTo` (or `move` when source and destination are the same drive); verify size and provider hash at the new item, then download and verify SHA-256 if the provider hash is unavailable; in one transaction switch the reference and record the old one in `stored_file_moves`; then remove the old copy (permanently for source files; for output files, removal only after the new copy is confirmed, so there is never a moment with no confirmed copy and never two authoritative ones — the old reference is history, not authoritative). A failure at any step leaves the old reference current.
- Used by: department transfer with "Move the folder" (§10, same drive: a single folder move, with every file's item id verified unchanged afterwards); moving the source area (§9.3). A later provider migration uses the same routine with a new connector.
- **Manifest:** System Settings › Storage › "Download storage manifest" (Enterprise Administrator; `writeAudit` `storage.manifest_downloaded`): a CSV of every stored file — purpose (source original, source text, output), project id, project name, source or output id, version, destination label, connector, drive id, item id, path, size, SHA-256, provider hash, state, last check. No titles of restricted items (*design call*: a restricted source's or output's title appears as "Restricted item"), no content.
- (build ruling, 20–21 November 2026) The manifest has no title column: a restricted item shows "Restricted item" in the Path column.

## 10. Owning department transfer (D108)

- On the project's organisation panel (Enterprise Administrator only, any project state): choose the new department (active), a reason, and, when the project has filed outputs, "Move the folder" or "Keep it where it is". The confirmation states how many filed files are affected and that sharing is unchanged.
- In one transaction: update `projects.owning_department_id`; insert `project_department_transfers` (from, to, reason, choice, actor, at, state); write History and `writeAudit` `project.department_transferred`.
- **Move:** a `relocate` job moves the project folder and the project's `(restricted)` folder (in each destination that holds them) into the new department's folder (created if needed). Their Kainow grants move with them (permissions belong to the folder items). Same drive, so one `move` call; afterwards every stored file's item id must still resolve and its path is refreshed. Until confirmed the transfer shows "Moving files"; on failure "Files not moved — still at <old path>" with "Try again", and nothing is described as moved.
- **Keep:** stored files keep their place; the output register shows "Kept at its existing location (filed under <old department>)". New filings go to the new department's folder (*design call*: one project folder per department is not duplication of an output; each output version has one location).
- (build ruling, 20–21 November 2026) A move is refused when the new department already holds this project's folder. With "Keep", later versions of an already-filed output stay in its placement folder (new outputs file under the new department). A failed move must be retried before another department change. The earlier `POST /projects/:id/department` route runs the same transfer.
- Leadership department scopes follow at once (sub-project 7). Contributing departments and contributor attribution are unchanged (outputs rules §3).

## 11. Permissions (additions to the Permission Matrix)

| Action | Who | Notes |
|---|---|---|
| Submit an output (draft, upload, link, saved export) | Active PM, Deputy, Owner, Sponsor or Member | Project not Deferred or Closed; format allowed; credential check |
| Register, decline, set type/categories/issue date/contributors, add versions, file, withdraw, delete and restore register entries | PM or Deputy | Project not Deferred or Closed, except delete/restore (sub-project 5 rules) |
| Request approval of an output version | PM or Deputy | Filed (or checked link), last check not Changed/Missing/Access denied |
| Approve an output version | Owner or Sponsor under the project approval policy | `approve_output` change request; Deferred/Closed: not allowed |
| Set or change an output's audience; clear or withdraw "Access review required" | PM, Owner or Sponsor in the material's readers | Widening previews names |
| Read outputs and open filed files | Output readers (§4.6) | Leadership grants: never |
| Relink a moved or renamed file within approved destinations; register a changed file as a new version | PM or Deputy | D107 |
| Approve a new place as a destination so a file moved there can be relinked | Enterprise Administrator | Through the destination approval of §8.2; no separate flow |
| Export CSV | Per D106 | Recorded |
| Project output settings (destination, formats, export roles) | PM, Owner or Sponsor when delegated; otherwise Enterprise Administrator | Reason; versioned |
| Storage connection, destinations, scheduled checks, approved formats, delegation switches, report types, source-area move, manifest | Enterprise Administrator (`storage.manage`; report types under `organisation.manage`) | Reason |
| Designate or end a storage Administrator | Enterprise Administrator, not for themselves | Reason |
| Project exports allowed | Enterprise Administrator (`organisation.manage`) | Reason; Access and records page |
| Change owning department | Enterprise Administrator | Reason; folder choice |
| Report a suspected secret in an output | Any output reader | D80 |

`PROJECT_MATRIX` gains actions `output.submit`, `output.manage`, `output.approve_request`, `output.audience`, `output.export`, `outputs.settings`; `permissions.ts` gains `storage.manage`. Sub-project 8 also edits both files (§13.3).

## 12. Screens

- **Project › Outputs tab** (new): register list (filters: report type, category, status, year; search box), Submit button; each output's page: summary, versions table (version, origin, format, status, filing state, check state with time, approval reference, Open, Download a copy for filed files only), contributors and AI-assisted label, audience (with Not-shared notes), actions by role, history.
- **Draft report page:** "Submit as output" with format choice.
- **Work and Records views:** "Export CSV" where allowed (hidden otherwise), and "Save as output".
- **Project settings › Outputs:** destination, formats, export roles, each showing effective value, where it comes from and who may change it (Q01).
- **Source version panel:** storage state for PM/Deputy/Owner/Sponsor; download as now.
- **System Settings › Storage** (new nav item "Storage"): §8.6.
- **System Settings › Report types** (new nav item).
- **Access and records:** "Project exports allowed".
- **Project organisation panel (Administrator):** "Change owning department".
- **Go-live checklist:** new step 12 (`storage`, mode `auto_or_skip`): "Connect storage and approve the source area", auto-ticked when a connection checks and a source area is approved; skippable with a note (sources then stay in the database until it is done). The closing keys are unchanged.
- (build ruling, 20–21 November 2026) The go-live skip route is generalised to `POST /go-live/steps/:key/skip` for every `auto_or_skip` step; the storage step ticks itself from the recorded result of the last connection check together with an approved source area (no provider call is made to show it).
- **Administrator dashboard / analytics system panel:** counts of storage failures, waiting files, withheld-removal failures and sharing to repair (added to the sub-project 7 system panel's problem list).

All screens: summary first, plain words, keyboard and screen-reader support, WCAG 2.2 AA, both themes, usable at 375 px. States are shown in words, never colour alone.

## 13. Data model (migration `0031_external_outputs.sql`)

### 13.1 Tables (sketch; the builder fixes exact names, indexes and append-only triggers in the project's style)

```sql
CREATE TABLE report_types (id uuid PRIMARY KEY, name text NOT NULL UNIQUE CHECK (btrim(name) <> '' AND length(name) <= 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')), position int NOT NULL,
  created_by uuid REFERENCES users, created_at timestamptz NOT NULL, updated_by uuid REFERENCES users, updated_at timestamptz);
-- seeded: Status reports, Decisions and actions, Risk summaries, Specifications, Minutes, Exports, Other

CREATE TABLE storage_settings (id boolean PRIMARY KEY DEFAULT true CHECK (id),
  tenant_id text, client_id text,
  approved_input_formats  text[] NOT NULL DEFAULT '{txt,md,docx,pdf}',
  approved_output_formats text[] NOT NULL DEFAULT '{md,docx,pdf,csv}',
  projects_may_change_formats      boolean NOT NULL DEFAULT true,
  projects_may_choose_destination  boolean NOT NULL DEFAULT true,
  projects_may_set_export_roles    boolean NOT NULL DEFAULT true,
  directory_lookup boolean NOT NULL DEFAULT false,
  scheduled_checks boolean NOT NULL DEFAULT false);
INSERT INTO storage_settings DEFAULT VALUES;
CREATE TABLE storage_settings_changes (id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users, at timestamptz NOT NULL,
  reason text NOT NULL, previous jsonb NOT NULL, next jsonb NOT NULL);                         -- append-only
CREATE TABLE storage_connection_secrets (id uuid PRIMARY KEY, ciphertext bytea NOT NULL, nonce bytea NOT NULL, tag bytea NOT NULL,
  key_id text NOT NULL, saved_by uuid NOT NULL REFERENCES users, saved_at timestamptz NOT NULL, superseded_at timestamptz); -- one current

CREATE TABLE storage_destinations (id uuid PRIMARY KEY, connector text NOT NULL CHECK (connector IN ('graph','local')),
  kind text NOT NULL CHECK (kind IN ('sharepoint_library','onedrive','local')),
  purpose text NOT NULL CHECK (purpose IN ('source_area','outputs')), label text NOT NULL,
  site_url text, account_email text, folder_path text, site_id text, drive_id text, root_item_id text,
  status text NOT NULL CHECK (status IN ('proposed','approved','withdrawn')),
  last_check jsonb, last_checked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL);
CREATE UNIQUE INDEX one_source_area ON storage_destinations ((true)) WHERE purpose = 'source_area' AND status = 'approved';
CREATE TABLE storage_destination_events (…kind IN ('proposed','checked','approved','withdrawn')…, actor_id, at, reason, detail jsonb); -- append-only

CREATE TABLE storage_folders (id uuid PRIMARY KEY, destination_id uuid NOT NULL REFERENCES storage_destinations,
  level text NOT NULL CHECK (level IN ('department','project','year','report_type','restricted_root','output','source_root')),
  key text NOT NULL,             -- e.g. department id, "<department id>/<project id>", ".../2026", ".../<report type id>", "<…>/restricted", "<…>/output/<output id>"
  item_id text NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL, UNIQUE (destination_id, level, key));

CREATE TABLE stored_files (id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('source_original','source_text','output')),
  project_id uuid NOT NULL REFERENCES projects, destination_id uuid REFERENCES storage_destinations,
  connector text, drive_id text, item_id text, path text, name text NOT NULL,
  size_bytes bigint, sha256 text, provider_hash text, etag text, ctag text, web_url text,
  state text NOT NULL CHECK (state IN ('pending','storing','stored','failed','withheld','relocating','missing','linked')),
  check_status text NOT NULL DEFAULT 'unverified' CHECK (check_status IN ('ok','changed','moved','missing','access_denied','unverified')),
  last_checked_at timestamptz, failure_code text, attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL, stored_at timestamptz);
CREATE TABLE stored_file_moves (id uuid PRIMARY KEY, stored_file_id uuid NOT NULL REFERENCES stored_files, reason text NOT NULL,
  old_destination_id uuid, old_drive_id text, old_item_id text, old_path text, new_destination_id uuid, new_drive_id text, new_item_id text,
  new_path text, actor_id uuid REFERENCES users, at timestamptz NOT NULL);                     -- append-only
CREATE TABLE storage_outbox (id uuid PRIMARY KEY, job text NOT NULL, subject_id uuid NOT NULL, created_at timestamptz NOT NULL, sent_at timestamptz);
CREATE TABLE storage_attempts (id uuid PRIMARY KEY, job text NOT NULL, subject_id uuid NOT NULL, outcome text NOT NULL,
  provider_status int, duration_ms int NOT NULL, at timestamptz NOT NULL);
CREATE TABLE storage_grants (id uuid PRIMARY KEY, folder_id uuid NOT NULL REFERENCES storage_folders,   -- folders only (§5.5)
  user_id uuid NOT NULL REFERENCES users, role text NOT NULL CHECK (role IN ('read','write')),
  state text NOT NULL CHECK (state IN ('pending','granted','not_found','revoking','revoked','failed')),
  permission_id text, updated_at timestamptz NOT NULL);
CREATE UNIQUE INDEX storage_grants_live ON storage_grants (folder_id, user_id) WHERE state <> 'revoked';
CREATE TABLE storage_admins (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, designated_by uuid NOT NULL REFERENCES users,
  designated_at timestamptz NOT NULL, reason text NOT NULL, ended_at timestamptz, ended_by uuid, end_reason text,
  CHECK (designated_by <> user_id));
CREATE TABLE storage_admin_events (…append-only…);

ALTER TABLE source_versions ADD COLUMN original_stored_file_id uuid REFERENCES stored_files,
                            ADD COLUMN text_stored_file_id uuid REFERENCES stored_files;
-- the existing upload CHECK is relaxed: an upload has original_bytes OR original_stored_file_id (or is withheld)

CREATE TABLE project_output_settings (project_id uuid PRIMARY KEY REFERENCES projects, destination_id uuid REFERENCES storage_destinations,
  input_formats text[], output_formats text[],
  export_roles text[] NOT NULL DEFAULT '{pm,deputy,owner,sponsor}', updated_by uuid, updated_at timestamptz);
CREATE TABLE project_output_settings_changes (…actor, at, reason, previous, next; append-only…);

CREATE TABLE outputs (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects, title text NOT NULL,
  report_type_id uuid REFERENCES report_types, issue_date date, audience_id uuid REFERENCES audiences,
  status text NOT NULL CHECK (status IN ('submitted','registered','declined','withdrawn')),
  review_state text NOT NULL DEFAULT 'none' CHECK (review_state IN ('none','review_required','cleared')),
  ai_assisted boolean NOT NULL DEFAULT false, author_id uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL, registered_by uuid, registered_at timestamptz,
  deleted_at timestamptz, deleted_by uuid, delete_reason text, held_case_id uuid);
CREATE TABLE output_categories (output_id uuid REFERENCES outputs, report_type_id uuid REFERENCES report_types, PRIMARY KEY (output_id, report_type_id));
CREATE TABLE output_contributors (output_id uuid REFERENCES outputs, user_id uuid REFERENCES users, department_id uuid REFERENCES departments,
  added_at timestamptz NOT NULL, CHECK (user_id IS NOT NULL OR department_id IS NOT NULL));
CREATE TABLE output_versions (id uuid PRIMARY KEY, output_id uuid NOT NULL REFERENCES outputs, version_no int NOT NULL,
  origin text NOT NULL CHECK (origin IN ('draft_report','export','upload','link','changed_file')),
  format text NOT NULL CHECK (format IN ('md','docx','pdf','csv','txt','other')),
  draft_version_id uuid REFERENCES report_draft_versions, stored_file_id uuid REFERENCES stored_files,
  status text NOT NULL CHECK (status IN ('draft','approved','superseded')),
  approval_request_id uuid REFERENCES change_requests, sha256 text NOT NULL, size_bytes bigint NOT NULL,
  created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL, held_case_id uuid,
  UNIQUE (output_id, version_no));                            -- immutable except status, stored_file_id, approval_request_id, held_case_id
CREATE TABLE output_version_bytes (output_version_id uuid PRIMARY KEY REFERENCES output_versions, bytes bytea NOT NULL, kept_until timestamptz NOT NULL);
CREATE TABLE output_events (id uuid PRIMARY KEY, output_id uuid NOT NULL REFERENCES outputs, version_id uuid,
  kind text NOT NULL CHECK (kind IN ('submitted','registered','declined','updated','version_added','filed','filing_failed','approval_requested',
    'approved','superseded','audience_changed','review_required','review_cleared','withdrawn','deleted','restored','held','released',
    'checked','changed_found','moved_found','missing_found','relinked','changed_registered')),
  actor_id uuid REFERENCES users, at timestamptz NOT NULL, reason text, detail jsonb NOT NULL DEFAULT '{}');   -- append-only

CREATE TABLE project_department_transfers (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects,
  from_department_id uuid NOT NULL REFERENCES departments, to_department_id uuid NOT NULL REFERENCES departments,
  reason text NOT NULL, folder_choice text CHECK (folder_choice IN ('move','keep')),
  state text NOT NULL CHECK (state IN ('done','moving','move_failed')), actor_id uuid NOT NULL, at timestamptz NOT NULL);

ALTER TABLE access_settings ADD COLUMN project_exports_allowed boolean NOT NULL DEFAULT false;
INSERT INTO golive_steps … ('storage', 12, …);
```

**As built in `0031_external_outputs.sql`** (build ruling, 20–21 November 2026), beyond the sketch above: `stored_file_withholds` (which cases hold a stored file, with release requested and released times); destination status `retiring` (one at a time, with a matching `storage_destination_events` kind); `stored_files.upload_destination_id`, `upload_folder_id` and `upload_name` (the recorded upload target), `folder_id` (the Kainow folder last confirmed), `withhold_case_id`, `removed_at`, `remove_notice_at`, `restore_notice_at` and `old_copy_move_id`; `outputs.placement_folder_id`, `place_failed_at` and `place_notice_at`; `storage_settings.last_check_state` and `last_checked_at`; `storage_outbox.urgent`; `storage_grants` state `external`, `revoke_notice_at` and `none_created`; `output_version_bytes.bytes` nullable (a withheld copy is emptied); `output_events` kinds `change_register_requested` and `change_register_failed`; the output search view and title trigram index; and the `storage` go-live step.

### 13.2 Registries and catalogues

- **Quarantine text registry:** every new plain-text column (titles, reasons, labels, paths, names, folder names, check details) is registered with the quarantine text registry or listed with a reason as holding no user text, so the `information_schema` completeness test passes. `output_versions` is registered as an item kind whose content is a stored file (withheld, not cleaned, §8.5). Paths and names in `stored_files`, `storage_folders` and `stored_file_moves` are cleaned with their item.
- **Event catalogue (sub-project 7):** all new `writeAudit` actions (`storage.*`, `project.exported`, `project.department_transferred`, `output.*`) and event-table CHECK lists are added to `app/src/analytics/catalogue.ts`; the completeness test passes.
- **History view:** output events and department transfers join the project History union.

### 13.3 `change_requests` and sub-project 8

0031 drops and re-adds the `change_requests` CHECKs to add kind `approve_output` and target kind `output_version`. If sub-project 8's 0030 is in `main` when this branch is rebased, the re-added lists are the union of both (sub-project 8 adds kinds `set_budget`, `finance_adjustment` and targets `project_budget`, `expenditure`); otherwise sub-project 8, merging second, does the union. The shared files `matrix.ts`, `permissions.ts`, `analytics/catalogue.ts`, `quarantine/registry.ts`, web `App.tsx` and `ProjectPage.tsx` tabs will conflict by rows only; both sides are kept.

## 14. Endpoints

| Route | Who | Does |
|---|---|---|
| `GET /projects/:id/outputs`, `GET /projects/:id/outputs/:outputId` | output readers | register, detail with versions and history |
| `POST /projects/:id/outputs` (draft / upload multipart / link / export) | `output.submit` | submit |
| `POST /projects/:id/outputs/:outputId/{register,decline,withdraw,delete,restore}` | `output.manage` | as §4 |
| `PUT /projects/:id/outputs/:outputId` | `output.manage` | type, categories, issue date, title, contributors |
| `POST /projects/:id/outputs/:outputId/versions` | `output.manage` | add a version |
| `POST /projects/:id/outputs/:outputId/versions/:n/{file,approval,relink,register-changed}` | `output.manage` | §5.4, §4.3, §9 |
| `PUT /projects/:id/outputs/:outputId/audience`, `POST …/review/{clear,withdraw}` | `output.audience` | §4.5 |
| `GET /projects/:id/outputs/:outputId/versions/:n/{open,download}` | output readers (download: filed files only, never a linked document) | §5.7 |
| `GET /projects/:id/export?kind=&filters` | D106 | CSV |
| `POST /projects/:id/export/save` | D106 + `output.submit` | §7.3 |
| `GET/PUT /projects/:id/output-settings` | readers / `outputs.settings` | §8.3 |
| `PUT /projects/:id/owning-department` | EA | §10 |
| `GET/PUT /admin/storage`, `POST /admin/storage/{secret,check}` | EA | §8.1 |
| `GET/POST /admin/storage/destinations`, `POST …/:id/{check,approve,withdraw}`, `POST /admin/storage/source-area/move` | EA | §8.2, §9.3 |
| `GET/POST /admin/storage/admins`, `POST …/:id/end` | EA | §8.4 |
| `GET /admin/storage/manifest` | EA | §9.4 |
| `GET/POST/PUT /admin/report-types` | EA | §4.4 |

Request bodies carrying the client secret are never logged or echoed (as sub-project 6's key endpoints).

## 15. Testing and measured aims

- **Fake Graph server** (`app/src/storage/testing/fake-graph.ts`): an in-process HTTP server implementing the calls in §5.3 over an in-memory drive (items, hashes, eTags, permissions, recycle bin vs permanent delete, copy monitors), with fault injection: timeout, connection drop after the upload body is accepted (uncertain outcome), 429 with Retry-After, 503, 401, 403, 404, name conflict, quota exceeded, changed content, moved item. The Graph connector's unit tests and the HTTP tests run against it; the `local` connector runs the same contract test suite (one shared contract test file, run for both).
- **QuickXorHash** pure tests against published vectors.
- **Filing:** confirmed-only success; uncertain outcome adopts the matching file and never creates a second; a different file with the same name fails as conflict; naming rules and `(2)` suffix; path length; folders reused by id after renames.
- **Sharing (mandatory leak tests):** the project folder is granted to exactly the project's current readers; a Restricted output's files are never under the project folder and its folder is granted to its audience only; narrowing an audience, review_required, withdrawing and deleting move the files out of the project folder before anything else (a forced move failure keeps the output hidden in Kainow and listed to repair), and widening or clearing moves them back; a member who leaves, is put On Hold, expires (by date, through the daily reconciliation) or is disabled loses the grant; an Audit grant's end removes it; permissions not created by Kainow are never touched (the fake server seeds an owner grant and a group grant and asserts they survive every operation); `not_found` handling with directory lookup on (guest, disabled, unknown) and off (domain not approved); the library permission check refuses a library with a Members group, a named person or a sharing link; no file ever carries a Kainow grant of its own.
- **Checks and reconciliation:** Checked, Changed, Moved, Missing, Access denied, Unverified; Changed blocks approval requests; registering changed content creates a separate file and restores the original from version history when a matching version exists (and reports when not); relink within approved destinations; a place outside them only after it is approved as a destination.
- **Held links:** hidden in Kainow, never deleted, notice sent.
- **Source area:** pending → stored with bytes removed from the database; download from storage with checksum; Changed in storage refuses and flags; missing; backfill; storing waits without key or connection and Kainow keeps working; the upload CHECK still holds.
- **Holds:** a held source upload and a held output file are encrypted then permanently deleted (never moved to the recycle bin); the cleaned text file is re-stored; release restores; removal failure keeps the item hidden and raises the notice.
- **Register and approval:** submit by each role, Deferred/Closed refusals, register/decline, approval through `change_requests` with a two-approver policy, Superseded on later approval, Changed blocks approval request, new version Draft, D101 material rule (restricted draft forces Restricted audience; removal sets review_required).
- **Exports:** policy off/on, role choices, Audit/Oversight, columns, Deleted and uncleaned held absent, cleaned held labelled, formula guard, BOM, `#` lines, audit row without data.
- **Renderers:** Markdown → DOCX and PDF for every block type (open the DOCX with `mammoth` and the PDF with `pdfjs-dist`, both already dependencies, and assert text and order); Malay text round-trips; letterhead before and after registration; header lines.
- **Formats:** imports refused for a removed format; generation refused; old files unaffected.
- **Department transfer:** move verifies item ids; keep labels; failure leaves the old reference; leadership scope follows.
- **Secrets:** the client secret never appears in logs, audit rows, responses or job data (grep test, as sub-project 6); only allowed files import `openStorageSecret`.
- **Relocation and manifest:** source-area move with a forced mid-way failure; manifest columns, restricted titles hidden.
- **Permission tests** for every new route.
- **Completeness tests** (text registry, event catalogue) pass.
- **Probe** `npm run probe-storage -- --destination <label>` against a real tenant (run by the Product Owner once a tenant exists): checks the token, the destination, folder create, small and chunked upload, hashes, move, invite and revoke a named test account, permanent delete, and prints the permissions actually needed (§5.3). Not run in CI.
- **Bench** (`npm run bench-outputs`, own database): 100 projects, 30,000 tasks, 2,000 outputs with 5,000 versions, 20,000 stored source files. **Aims (proposed for Product Owner approval):** `GET /projects/:id/outputs` p95 < 200 ms; tasks CSV export of a 1,000-task project p95 < 2 s; share-sync of a project folder for a 50-reader project < 5 s, and moving a 10-version output into its restricted folder < 2 s, against the fake server with 50 ms simulated latency; daily source check of 2,000 files within 15 minutes at the same latency. Results recorded here, met or missed.
- **Bench results (21 November 2026).** Machine: developer laptop, Docker Postgres 16, own database `kainow_bench_sp9`; the HTTP requests through the real app on loopback, the storage jobs run as the worker runs them against the fake Graph server with 50 ms added before every request. Data: the sub-project 7 set (200 people, 100 projects in 10 departments) with 30,700 tasks (700 added so project 3 has 1,000), 2,000 registered outputs (20 per project) with 5,000 filed versions and their stored files, and 20,000 stored source files; each run also adds one 50-reader project for the sharing and move measures. HTTP: 5 warm-up requests, then 50 counted. Share-sync and the move: 1 warm-up, then 5 counted, each round reset without the latency. The source check: one run of 2,000 files. p95 is nearest-rank. This is the second run on the same database; the first gave the same picture (share-sync p95 6.70 s, move p95 1.80 s, source check 126.4 s). No index, query or connector change was made for the bench.

  | Measure | Aim | p50 | p95 | max | Result |
  |---|---|---|---|---|---|
  | `GET /projects/:id/outputs` (20 outputs, 50 versions) | p95 < 200 ms | 147.8 ms | 183.4 ms | 199.8 ms | met |
  | `GET /projects/:id/export?kind=tasks` (1,000 tasks; 998 rows, 2 Deleted) | p95 < 2 s | 18.7 ms | 26.5 ms | 30.1 ms | met |
  | share-sync of a 50-reader project folder, no grants to 50 (50 ms latency) | < 5 s | 6.46 s | 6.52 s | 6.52 s | **missed** |
  | place-output: a 10-version output into its restricted folder, its 3 readers shared (50 ms latency) | < 2 s | 1.73 s | 1.75 s | 1.75 s | met |
  | daily source check of 2,000 stored files (50 ms latency) | < 15 min | 126.5 s | 126.5 s | 126.5 s | met |

  The register list sits at about 92% of its aim: it builds each output's summary and versions one query at a time. Share-sync misses because it sends the grants one at a time and each costs two Graph requests (the folder is looked up again before each invitation, then the invitation), so 50 readers need at least 100 requests, 5 s of latency alone, before the database work. Meeting the aim would need the grants sent with some concurrency, or the folder looked up once per sync; that is left to the Product Owner (§16), not tuned here. The move sits at about 87% of its aim.
- Screens checked at desktop and 375 px, by keyboard, both themes; WCAG 2.2 AA.

## 16. Left to the builder, and open items

- Exact SQL shapes, indexes and trigger style; the precise `marked` token mapping; DOCX and PDF styling within §6.2.
- New dependencies: `marked`, `docx`, `pdfkit` (pinned exact versions, as the project does).
- Working out "everyone who can read every passage" (§4.5): `draftAccess` answers for one viewer, so the builder either runs it per project reader or factors its rule into a set query; the result must match `draftAccess` for every person (a test compares them).
- The source backfill (§9.1) creates the `stored_files` rows for versions that existed before migration 0031.
- Whether `write` suffices for item invitations (probe, §5.3); the page shows whichever is needed.
- Wording of notices and labels not given here, in the product's plain style.
- **Design calls for the Product Owner to check while reading:**
  - the bench aims in §15;
  - unfiled Draft bytes kept 90 days (§5.4);
  - storage Administrators cannot designate themselves (§8.4);
  - approval only of filed or checked versions (§4.3);
  - uploaded outputs limited to the output formats; TXT and other types by link only (§4.1);
  - held links hidden in Kainow and reported, never deleted (§4.7);
  - registering changed content makes a separate file and restores the original from version history where possible (§5.8);
  - a file moved outside approved destinations is relinked only after the Administrator approves that place as a destination (§5.8);
  - the output library must be limited to site owners, checked at approval and daily (§5.5);
  - directory lookup Off by default (§8.1).
- A real Microsoft tenant is needed for the probe; no test here can replace it.
- **Open questions for the Product Owner** (raised while building, 20–21 November 2026; not decided here):
  - A department move that can never succeed (the destination withdrawn, or a permanent "forbidden") leaves the project's department fixed: there is no "abandon the move" or "keep it instead" path yet.
  - The QuickXorHash test vectors are self-derived from the algorithm description; `npm run probe-storage` must confirm them against a real tenant (its "hashes" line).
  - Real-tenant checks still needed (all on the probe): the error Microsoft returns when inviting an unknown address; how site collection administrators and a OneDrive owner appear in a library's permissions (until confirmed, a site user always counts as "others" and refuses approval); whether `write` on a site suffices for folder invitations (if so, the Storage page can ask for `write` only).
  - Share-sync of a 50-reader project folder missed its 5-second aim on the bench (§15): accept the measured time, or ask for the grants to be sent with some concurrency or without the per-grant folder lookup.
- **Follow-ups (not this sub-project):** budget and resource exports after sub-project 8 merges; backup and restore of the source area and outputs (sub-project 10, using the manifest); a provider-migration tool; Dropbox/Box connectors.

## 17. Documents updated in this branch

- Consolidated Specification §14: D100–D108.
- Permission Matrix §2, §5 and §8: the rows in §11.
- Configuration Catalogue: C85 storage connection; C86 destinations and their purposes; C87 storage Administrators; C88 project output destination; C89 formats (updates C50); C90 project export policy (updates C21); C91 scheduled checks; C92 report types (R14); C48, C56, C57 and C68 point to this design.
- Remaining Design and Verification Register: R15 designed (verification against a real tenant open); R14 designed for report types and formats; A13/A14 designed, recovery left to sub-project 10.
- `app/README.md`: storage settings, the local connector for development, the probe, the bench, the new go-live step.
- `INSTALL.md`: the Microsoft app registration and site-permission steps (with placeholders only).

## 18. Outside 9

- Other storage providers and the migration tool (later).
- Budget and resource exports (after sub-project 8).
- Backup, restore and capacity of storage (sub-project 10).
- Editing filed documents, or any document features beyond the register.
