# 11a.2 Task Boards and Cleaner Look Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tasks as boxes in status columns on Work, My tasks and Needs you, with a calmer look and a light side menu.

**Architecture:** No migration: new personal choices go in the stored preferences document; three read replies gain fields they can work out from what is stored. One pure module decides columns, order and folding; one set of board components draws it on all three screens. The task page's loading and body are split out so the side panel reuses them.

**Tech Stack:** NestJS/TypeScript, PostgreSQL 16, React 19/Vite 8 (no new dependency).

**Spec:** docs/superpowers/specs/2026-11-25-v1-task-board-clean-look-11a2-design.md

## Global Constraints

- No new npm dependency, no migration. No permission, audience or lifecycle rule becomes wider. Every existing `#/…` address keeps working.
- No code, icons, artwork or layout copied from another product. No real organisation name or domain; dummy data uses "Example Organisation" and `example.org`.
- Nothing hidden that was shown before. No dragging. No sideways page scroll at 375 px. Colour never alone: every state has a symbol and word.
- Colours only in the token blocks of `styles.css`, mirrored in `prefs.ts`, contrast-checked: text 4.5:1, edges 3:1, every scheme, Light and Dark.
- Decisions D142–D143, catalogue C116–C117 (check main again before merging). Dates in UTC+8.
- Preferences hold only values from fixed lists (stored document is NO_USER_TEXT).
- Server tests: `cd app && npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/<path>.test.js` with `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test_sp11`, `KAINOW_TEST_PG_DOCKER=kainow-testdb`; one test process at a time; no other session's database. Web: `cd app/web && npm test && npm run build`. Browser checks: Playwright headless against a real server, no stubbed replies; never the browser pane.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An open subtask whose parent is completed, cancelled or hidden: it has its own box, never lost with its parent (Task 2).
2. A task acted on in the panel moves column, or leaves the board: the panel keeps working, and closing it puts focus on the box, or on the column heading when there is no box (Task 4).
3. Text typed in a panel form and another box selected, or the view changed: the person is asked first (Task 4).
4. A task whose blocked reason held a credential: the box shows the cleaned text, and after a restore the restored one; a held task shows no reason (Task 1).
5. `#/projects/<id>/work/<id>` for a task not on the board, a decision, question or risk: the right row opens and takes focus (Task 4).

## Builder's own calls (for the Product Owner to check)

- The chosen view of each screen is remembered per person.
- A subtask sits inside its parent's box. It also has a box of its own in the by-assignee view when someone else holds it, and whenever its parent is not in an open column.
- In the by-assignee view only open tasks and those completed in the last 30 days are shown, completed last.
- On My tasks a box opens the task page; the side panel is on the project's Work tab.
- Home's My tasks section keeps its by-project boxes.

---

### Task 1: Reply fields and preferences (server)

**Files:** Modify `app/src/records/records.service.ts`, `app/src/records/task-page.http.test.ts`, `app/src/records/tasks.http.test.ts`, `app/src/dashboards/personal.service.ts`, `personal.http.test.ts`, `preferences.ts`, `preferences.test.ts`, `leaks.http.test.ts`.

**Interfaces — Produces:**
- `GET /projects/:id/records` tasks gain `dueSoon: boolean`, `completedOn: string | null` (UTC+8 day), `blockedReason: string | null` (latest block's note while Blocked, else null; null while the task carries an under-review label).
- `MyTask` gains `completedOn: string | null`, `blockedReason: string | null`, `parent: { id: string; title: string } | null`, `subtasks: { done: number; total: number }` (direct, live, cancelled not counted).
- `Prefs` gains `menu: 'light' | 'dark'` (light), `density: 'comfortable' | 'compact'` (comfortable), `views: { work: 'board' | 'list'; workBy: 'status' | 'assignee'; myTasks: 'board' | 'project' | 'due'; needsYou: 'board' | 'project' }` (defaults `board`, `status`, `board`, `board`).

- [ ] Tests (RED): `dueSoon` equals the task page's for the same task on both calendar modes; overdue, deadline-review and finished tasks are never due soon; `completedOn` at 23:30 UTC falls on the next UTC+8 day; `blockedReason` is the latest of two blocks, null once unblocked, the cleaned text after cleaning and null while held; a held or Deleted parent gives `parent: null` and no title anywhere; a held, Deleted or cancelled subtask is not counted; the number of queries for 1 and for 20 tasks is equal (the existing query-count pattern); preferences keep each known value, drop unknown ones and fill missing `views` keys.
- [ ] Implement with batched queries. `getTask` uses the same due-soon and blocked code as the list.
- [ ] Run records, dashboards, assist and quarantine tests: PASS. Commit `feat(records): board fields on task lists; view, menu and spacing preferences`.

### Task 2: Board rules (pure)

**Files:** Create `app/web/src/ui/board.ts`, `board.test.ts`; Modify `app/web/src/prefs.ts`, `prefs.test.ts`, `dashboard.ts`.

**Interfaces — Consumes:** Task 1's fields. **Produces:**
- `type BoardTask = { id; title; parentId: string|null; parentTitle: string|null; status: TaskStatus; dueOn; overdue: boolean; dueSoon: boolean; completedOn: string|null; assignee: {id; displayName}; projectId; projectName }`
- `boardTasks<T extends BoardTask>(tasks: T[], today: string): { boxes: BoardBox<T>[]; offBoard: T[] }`, `BoardBox<T> = { task: T; subtasks: { task: T; depth: number }[]; progress: { done: number; total: number } }`
- `byStatus(boxes): BoardColumn<T>[]` (always four, in order), `byAssignee(tasks, today): BoardColumn<T>[]` (by name), `BoardColumn<T> = { key: string; heading: string; meaning?: Meaning; boxes: BoardBox<T>[]; folded: boolean }`
- `inProjects(boxes): { projectId; projectName; boxes }[]` (11a.1's urgency order), `shownBoxes(boxes, all: boolean)` (first ten), `needsYouColumns(items): { group; heading; meaning; count; projects: { projectId; projectName; items }[] }[]`
- web `Prefs` mirrors Task 1; `viewsOf(prefs)`, `menuOf(prefs)`, `densityOf(prefs)` read a document saved before these existed.

- [ ] Tests (RED): four columns even when empty, Completed `folded: true`; overdue first then by due date, Completed newest first; completed 30 days ago is on the board and 31 days is in `offBoard`; cancelled in `offBoard`; a subtask inside its open parent, two levels deep, in the list's order; an open subtask of a completed, cancelled or absent parent has its own box with the parent's title when known; by assignee, a subtask held by another person is in that person's column and inside the parent's box; board boxes + their subtasks + `offBoard` are exactly the list's ids, each once (by status), for a generated set of 500; ten then "Show more"; `inProjects` and `needsYouColumns` drop empty groups, keep two projects with one name apart, and count every item once.
- [ ] Implement; `npm test`: PASS. Commit `feat(web): board columns, order and folding`.

### Task 3: Board components

**Files:** Create `app/web/src/ui/Board.tsx`, `BoardBoxes.tsx`; Modify `styles.css`.

**Interfaces — Produces:**
- `Board({ label, columns, renderBox, groupByProject, boxId })`: each column a `section` with a heading (symbol, word, count, coloured top edge) and a list; Show more/fewer; a folded column has a button with `aria-expanded`; empty column says "None". Below 700 px one column with a labelled `select` "Column" giving each column's name and count, starting at the first that has boxes. Columns wrap; they never scroll the page sideways.
- `TaskBoxView({ box, action })`: title as a link (`action.href`) or button (`action.onOpen`, `aria-expanded`), due date, overdue or due-soon label, assignee (or "Subtask of …"), "2 of 5 subtasks done", "Blocked: <reason>", `TaskLabels`' other labels and the under-review label, then the subtasks each with symbol, word and assignee. Accessible name starts with the title and holds status and due date.
- `AttentionBoxView({ item })`: what (link), date with its meaning.

- [ ] Implement using only existing tokens; markup rules tested with the web test pattern already used for components, else left to Task 7's audit.
- [ ] `npm test && npm run build`: PASS. Commit `feat(web): board, task box and attention box`.

### Task 4: Work tab board and side panel

**Files:** Create `app/web/src/views/TaskPanel.tsx`, `useTaskDetail.ts`, `TaskDetailParts.tsx`; Modify `TaskPage.tsx`, `Work.tsx`, `ProjectPage.tsx`, `styles.css`.

**Interfaces — Produces:**
- `useTaskDetail(projectId, taskId, onReloaded?)` holding the task page's load, refusal, act and propose; `TaskDetailParts` its boxes and Actions. The task page looks and behaves as before.
- `TaskPanel({ …TaskPage props, onClose, onChanged })`: a labelled region beside the board (below it under 1100 px), same details, actions and forms, "Open full page", "Close". Opening moves focus to its heading; Escape or Close returns it to the box, or to its column's heading.

- [ ] Tests (RED) for the pure parts: `panelTarget(focusId, records, board): 'panel' | 'list' | 'none'` (a task on the board → panel; one off the board or another record kind → list/row; unknown → none); `focusAfterClose(boxPresent): 'box' | 'column'`.
- [ ] Implement: View choice Board/List and, on the board, Columns by Status/Assignee (both saved). Export controls, Waiting for authorisation, questions, decisions and risks stay. Off-board tasks are named under the board: "3 cancelled or completed earlier are in the list view" with a button that opens it. An action refreshes board and panel from one reload. Forms in the panel arm the leave guard while they hold text; selecting another box, closing or changing view asks first.
- [ ] Real-server check at 1200 and 375 px, as Project Manager, assignee and grant holder: the panel offers the same buttons as the task page for each; start, block with a reason, complete, propose a change; a task completed from the panel.
- [ ] `npm test && npm run build`: PASS. Commit `feat(web): task board and side panel on Work (D142)`.

### Task 5: My tasks and Needs you boards

**Files:** Modify `app/web/src/views/MyTasks.tsx`, `Home.tsx`, `ui/AttentionQueue.tsx`, `ui/home.ts`, `home.test.ts`.

- [ ] Tests (RED): the same tasks in Board, By project and Due date for each filter; the status filter leaves other columns at 0; a subtask has its own box naming its parent; Needs you's board and By project hold the same items; a board pref saved earlier opens that view.
- [ ] Implement: My tasks View = Board, By project, Due date (saved), filters apply to all. A box links to the task page. Home's Needs you View = Board, By project (saved); empty columns left out; the empty message as today. Inside a project, Needs attention is unchanged.
- [ ] Real-server check; `npm test && npm run build`: PASS. Commit `feat(web): My tasks and Needs you as boards (D142)`.

### Task 6: Overall look, side menu and spacing

**Files:** Modify `app/web/src/styles.css`, `prefs.ts`, `prefs.test.ts`, `ui/SideMenu.tsx`, `ui/menu.ts`, `menu.test.ts`, `ui/AppShell.tsx`, `views/Customise.tsx`, `views/MyProfile.tsx`, `views/ProjectPage.tsx` and the project tab views that nest boxes.

**Interfaces — Produces:** `menuProjects(projects: PersonalProject[]): { items: MenuItem[]; more: boolean }` (current only, first ten by name; a project on hold is listed without a link to its figures as on Home); `data-menu`, `data-density` on the root; light-menu tokens per scheme in `styles.css` and `prefs.ts`.

- [ ] Tests (RED): ten by name then `more`; Deferred, Closed and archived left out; the current project's item carries `aria-current` and "Projects" does not; contrast of the light menu in six schemes, Light and Dark, including the organisation's colour; "Follow the organisation" saves `accentChosen: false` and shows the organisation's colour, or Red when it has none; resetting appearance resets menu and spacing, and reset wording names them.
- [ ] Implement: page background white in Light; project tabs, lists and forms use thin rules instead of nested boxes; boxes stay on Home, Settings and the Overview; accent only for selection, links and the main button. Menu light by default, dark a choice; the list of projects comes from the reply the Reviews badge already reads (no new request) and refreshes when a project is created, duplicated or changes state. Appearance on My profile gains Side menu, Spacing and "Follow the organisation". Binder tabs, Print and the Menu button below 900 px keep working.
- [ ] Screenshots of every main page, six schemes × Light/Dark at 1200 px and one scheme at 375 px, looked at. `npm test && npm run build`: PASS. Commit `feat(web): cleaner look, light side menu and spacing (D143)`.

### Task 7: Carried-over fixes, audit and documents

**Files:** Modify `app/src/analytics/csv.ts` and its test, the Overview's copied-Draft line (web `overview.ts`) and its test, `tests/a11y/audit.mjs`, `walkthrough.mjs`, `tests/browsers/*`, the Decision Register (D142, D143), the Configuration Catalogue (C116 chosen views, C117 side menu, spacing and following the organisation's colour), the user guides that describe Work, My tasks, Needs you and the menu.

- [ ] Tests (RED): the analytics CSV's stage cell ends "(stopped)" for a stopped stage and its days column holds the days to the stop; a copied Draft with waiting proposals says "Copied tasks and risks wait on Proposals".
- [ ] Extend the audit: board (status, assignee), open panel, folded and unfolded Completed, My tasks' and Needs you's views, light and dark menu, compact, at 1200 and 375 px, Light and Dark; keyboard only: open a box, act, close, focus returns. Extend the browser smoke to the same views.
- [ ] Speed: a project with 500 tasks on kainow_demo_sp11's server: the board is usable within 2 s of opening Work (record the figure), and the tasks reply's time with the new fields is recorded beside the figure without them.
- [ ] Full web tests and build; server full suite in the background. Commit `test+docs: boards and look audited; D142, D143, C116, C117`.
