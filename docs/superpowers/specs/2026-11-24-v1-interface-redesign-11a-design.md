# Sub-project 11a: interface redesign (design)

**Date:** 24 November 2026
**Status:** Draft for the Product Owner's approval
**Branch:** `TheLord/subproject-11-acceptance-24e07c` (worktree), cut from `main` at 2046ba8
**Decisions:** D127 (v0.1 test release), D128 (navigation, Settings hub and page pattern), D129 (colour schemes and organisation colour), D130 (correcting a proposal's type, with a reason and a named history), D131 (stage templates), D132 (timeline bars)
**Configuration Catalogue:** C111 (personal colour scheme), C112 (organisation colour), C113 (stage templates; refines C09)
**Migrations:** 0036 (`0036_interface.sql`), 0037 (`0037_stage_templates.sql`)

## 1. Why

Kainow's rules, permissions and workflows are complete (sub-projects 1 to 10), but the screens grew one feature at a time. On 24 November 2026 the Product Owner walked through a demo installation and found it too minimal and hard to navigate: the Enterprise Administrator's header holds about 20 links in one row, screens are long lists rather than organised boxes and tables, and nothing uses colour to show a project's state or what needs attention. The Product Owner's words: "The system is powerful, but if the look and feel does not encourage use and navigation, it will get abandoned."

Sub-project 11 (Acceptance) was split on 24 November 2026:

- **11a, this document:** the interface redesign, done first, because the accessibility audit and the newcomer test must assess the screens people will actually use.
- **11b, its own spec later:** the assessment set and real-model runs, the newcomer test, the WCAG 2.2 AA audit, the load test repeated in containers, the `sawitclean` repository with rewritten history, and the signed v0.1.0 release (D127).

## 2. Goals, non-goals, anti-goals

**Goals**

1. A newcomer can find their work, their reviews and any setting without being shown.
2. Every screen is organised into boxes and tables, with the summary first and detail below.
3. Colour shows a project's state and what needs attention, the same way on every screen, always together with a word and a symbol.
4. The Enterprise Administrator's 20 header links become one Settings hub, and every setting gets its own page built to one pattern.
5. Each person can choose a colour scheme; the default is Red; an organisation can set its own colour as its installation's default.
6. A reviewer can correct an AI proposal's type, wording, owner and due date in place, beside its source, and everyone sees who changed what and why.
7. The 375 px header overflow seen in earlier smoke tests is gone (the header is rebuilt).

**Non-goals**

- No change to any permission, lifecycle rule, approval rule or what a person may see. The redesign rearranges and restyles; it grants nothing (UI rules §1).
- No new product feature beyond the decisions here (D128 to D131).
- No component library or CSS framework (Product Owner chose approach A, §4).
- No native app; responsive web as before (O15).

**Anti-goals (a failure even if it works)**

- Colour that carries meaning on its own. Every state and attention colour comes with a word and a symbol (WCAG 1.4.1, UI rules §7, §10).
- A personal colour scheme that changes what a state colour means, weakens contrast, or blurs the AI-proposed dashed outline and label.
- Hiding a warning, an approval consequence or the current project behind the new layout or a collapsed section (UI rules §8).
- A screen that loses a function it has today. Every existing route, form and action keeps working, reached from the new layout.
- Generic template look: identical rounded cards everywhere with one shadow. Boxes differ by role (status tiles, attention boxes, setting boxes, tables) and carry information in their edges and labels.
- Any real organisation's name, branding or domain in the product (the default scheme is plainly called "Red").

## 3. What the Product Owner decided (24 November 2026)

From the brainstorm, with the mockups in `.superpowers/brainstorm/` (not committed):

1. **Layout A with C's queue:** a dark side menu grouped by purpose; the home screen's top is a "Needs you" queue of boxes coloured by urgency, each saying what and where; below it the projects in one table with coloured state labels, progress and a "Needs attention" column.
2. **Settings hub:** the header links go into one Settings page, in four groups of boxes. Each box shows the setting's current values and a state (set up, needs attention, failing, not in use) and opens that setting's own page. The AI box shows the models by name.
3. **Each setting's own page:** the most frequently looked-for details on top (status, figures, tables), the individual settings at the bottom, each in its own box with a Change button.
4. **Analytics and My AI use** go in the side menu (they are read, not set). **Operations** is both a box in Settings and a side-menu entry.
5. **Colour schemes** each person can choose; **Red is the default**. The scheme is plainly named "Red"; no organisation name appears. An Enterprise Administrator can set the organisation's own colour, which becomes the installation's default.
6. **Project page:** the project's name, state, departments and Project Manager stay at the top of every tab; the tabs are boxed individually, "like a separator in binder files".
7. **Reviewing proposals:** on the same screen, beside the source, a reviewer can change the type, edit the wording, and correct the owner and due date; each change is marked with the person's name for governance. A reason is required when the type changes and optional otherwise.
8. **Approach A** (§4).

## 4. Approaches considered

| | Approach | Trade-off | Chosen |
|---|---|---|---|
| A | Rework in place on a small set of our own building blocks, applied screen by screen in waves | No new dependencies; existing tests and contrast checks keep working; distinctive look. More hand work per screen. | **Yes** (Product Owner, 24 Nov) |
| B | Adopt a component library (for example Material UI) | Faster components, but a large dependency, every screen rewritten, and a look shared with every other app built on it. | No |
| C | Redesign only the main screens; the rest get only the new colours | Cheapest, but inconsistent; the Product Owner asked for every setting to get a proper page. | No |

## 5. Visual system

### 5.1 Tokens

All colours stay in token blocks in `styles.css`, mirrored in `prefs.ts` and checked by `prefs.test.ts` for contrast, as today.

**Fixed meaning colours (never change with the scheme).** Each has a strong colour (text, edges, filled badges) and a wash (backgrounds). Light theme values below; the dark theme has its own pair for each, also contrast-checked.

| Meaning | Symbol | Strong | Wash | Use |
|---|---|---|---|---|
| Project Draft | ○ | `#5b6670` | `#e6e9ec` | state label |
| Project Planned | ◷ | `#1d4f9a` | `#dbe6f6` | state label |
| Project Active | ● | `#1d7a46` | `#d7efe0` | state label |
| Project Deferred | ❚❚ | `#8a5200` | `#fbe8c8` | state label |
| Project Closed | ✓ | `#45476a` | `#e4e3ef` | state label |
| Overdue | ⚠ | `#a8203a` | `#f7dde2` | attention |
| Needs review or decision | ◆ | `#8a5200` | `#fbe8c8` | attention |
| Blocked | ■ | `#6a3a88` | `#eadcf0` | attention |
| Due soon, risk review | ◷ | `#1d4f9a` | `#dbe6f6` | attention |
| Set up / healthy | ✓ | `#1d7a46` | `#d7efe0` | setting state |
| Not in use | – | `#5b6670` | `#e6e9ec` | setting state |

Exact values may be adjusted by the builder only to pass contrast: every strong colour on its wash and on the surface must reach 4.5:1 for text, and edges and symbols 3:1 against what they sit on (WCAG 1.4.3, 1.4.11). The record kinds (decision, action, question, risk) keep their existing colours.

**Scheme colours (change with the person's choice):** the side menu background, the active menu item, primary buttons, links, the open binder tab and focus outline. Each scheme defines `--menu`, `--menu-ink`, `--menu-active`, `--accent`, `--accent-contrast`, `--accent-deep` and `--accent-wash`, for light and dark.

| Scheme | Accent (light) | Notes |
|---|---|---|
| **Red (default)** | `#b0182e` | Menu a deep red (`#4a0912` or darker) so it never reads as an Overdue box |
| Teal | `#0c6a6e` | Kainow's current colour |
| Blue | `#1f55a8` | |
| Plum | `#7a3a8f` | |
| Slate | `#4a5a68` | |
| Organisation | from C112 | Only offered when the organisation has set one |

Light or dark stays a separate choice, as today. Red and Overdue never look alike: Overdue is always the light red wash with a red edge, the ⚠ symbol and the word, while the Red scheme uses red only on the menu, buttons, links and the open tab.

**Type.** Keep Literata (headings, figures in stat tiles) and Instrument Sans (everything else), already bundled. A type scale of 12 / 13 / 15 / 18 / 22 / 28 px with 1.4 line height for sans text and 1.55 for serif; table text 13 px; labels in sentence case, never all caps.

**Shape.** Boxes have a 6 px radius and a 1 px rule; their left or top edge (4 to 5 px) carries the state colour where a state applies. No decorative shadows; one subtle shadow only on menus and dialogs that float. Tables have a tinted header row, 1 px row rules and no zebra striping.

### 5.2 Building blocks (`app/web/src/ui/`)

One small set, used everywhere. Each is a React component with its own test.

| Block | What it is |
|---|---|
| `AppShell` | Side menu, slim top bar, main area, footer. Collapses the side menu into a Menu button below 900 px. |
| `SideMenu` | Groups (Work, Organisation, Administration) of links with `aria-current`, count badges and a visible focus ring. |
| `TopBar` | Search, notifications bell, AI spend meter, and a person menu (Customise, colour scheme, Sign out, Sign out everywhere). |
| `PageHeader` | Breadcrumb, title, one-line explanation, primary action. |
| `Box` | Titled box with an optional state edge and an optional state label. |
| `StatTile` | A figure with a label and an optional meter or note. |
| `StatusLabel` | State or attention label: symbol + word + colour, from one table of meanings. |
| `DataTable` | Semantic table with caption, column headers, optional sorting by button, empty and loading rows, and a narrow-screen layout that stacks each row into labelled pairs. |
| `AttentionQueue` | List of attention boxes (Overdue, Review, Blocked, Due soon), each with what, where and a link. |
| `BinderTabs` | Project section navigation: each tab its own box; the open one filled with the accent and joined to the page. Links with `aria-current="page"`, not ARIA tabs (they change the address). Wraps onto more rows on narrow screens. |
| `SettingBox` | A hub box: name, one-line purpose, two or three current values, state label; the whole box is one link. |
| `SettingsPage` | Template: `PageHeader`, an "At a glance" area, then a "Settings" area of boxes each with its own Change button that opens its form in place. |
| `StageFlow` | The project's stages as a row of steps, done, current (with its duration) and to come; text equivalent for screen readers. |
| `StackedBar` | Task status split with a legend that gives each count in words (graphics need equivalent values, O15). |

## 6. Navigation (D128)

### 6.1 Side menu

| Group | Item | Who sees it | Destination |
|---|---|---|---|
| Work | Home | everyone | `#/` |
| Work | My tasks | everyone | `#/my-tasks` (new page, §7.2) |
| Work | Reviews | everyone | `#/reviews` (new page, §7.3), with a count badge |
| Work | Projects | everyone | `#/projects` |
| Organisation | Leadership | holders of an Active leadership grant | `#/leadership` |
| Organisation | Analytics | Enterprise Administrator | `#/admin/analytics` |
| Organisation | My AI use | everyone | `#/my-ai-usage` |
| Organisation | Resource catalogue | Administrator and named maintainers | `#/resource-catalogue` |
| Administration | Settings | Enterprise Administrator | `#/settings` (new, §8) |
| Administration | Operations | Enterprise Administrator | `#/admin/operations` |
| Administration | Security review | designated security reviewers | `#/security/cases` |

A group with no visible item is not shown. Every existing address keeps working (bookmarks and email links point at them). Settings pages keep their current addresses (`#/ai`, `#/departments`, …); their breadcrumb leads back to `#/settings`, and the side menu marks Settings as current on all of them.

### 6.2 Top bar and person menu

The top bar holds only: the organisation's wide logo (or the name), search, the notifications bell, the AI spend meter and a person menu button showing the person's name. The person menu (a disclosure button with a list) holds Customise, Colour scheme, Light or dark, Sign out and Sign out everywhere. This removes the 375 px overflow: at 375 px the bar shows the Menu button, the logo, search as an icon button that opens the field, the bell and the person button.

### 6.3 Project context

Inside a project, a project header sits above the binder tabs on every tab: the project's name, its state label, owning department, participating departments and Project Manager, and the existing warnings (On Hold member, missing roles, escalation flags), which may not be hidden. "Ask about this project" and "Add notes" are actions in that header where the person may use them.

The binder tabs are: Overview, Discussion, Notes, Proposals, Work, Timeline, Resources, Outputs, People, Settings, plus the conditional ones (AI, Drafts, Assist review, Feedback, Deleted items) exactly when they show today, and Closing and Deadline review while the project's lifecycle calls for them (today they are routes without a tab). Permissions per tab are today's. A count badge shows on Proposals (items waiting), Work (overdue) and Closing or Deadline review when action is needed.

*Builder's call, settled by the designer (the mockup the Product Owner approved shows these tabs):* today's single "Notes & discussion" tab (`notes`, showing `Discussion` and `HumanProposals`) is split into three tabs with their own addresses: **Discussion** (`/discussion`: threads, meetings), **Notes** (`/notes`: supplied notes and their versions, the intake form), and **Proposals** (`/proposals`: every extraction run of the project with items still waiting, and the human proposals, each with its count and a link to its review). The AI review screen keeps its address `#/runs/:id` (email links point at it) but now renders inside the project shell: the project header above it and Proposals marked as the current tab. The old `/notes` address shows the Notes tab; nothing is lost. The Proposals badge comes from a new waiting-items count in the project dashboard data, and the Proposals tab's list of runs from a new read-only `GET /projects/:projectId/proposals`; both apply the same permission and source-audience filter as the notes list, so a Restricted note's proposals are neither counted nor listed for members outside its audience.

## 7. Screens

### 7.1 Home

Top to bottom: a greeting with today's date (UTC+8); the **Needs you** queue (`AttentionQueue`) from `/dashboard/me` `needsYou`, grouped by urgency (Overdue, Review and decisions, Blocked, Due soon and risk reviews). *Designer's call:* `needsYou` on the server gains four kinds so the queue has one source, one permission path and one count: `overdue` (the person's own tasks past due), `blocked` (the person's own tasks Blocked, and tasks Blocked in projects where they are PM or Deputy PM), `due_soon` (the person's own tasks due within 7 days, UTC+8, by the project calendar), and `risk_review` (risk reviews due within 7 days that the person owns). The existing kinds map: approval, question, deadline_review and minutes → Review and decisions; copies and resources → Due soon. The new kinds get the same leak and permission tests as the existing ones; **Your projects** as a `DataTable` with columns Project, State, Stage (and its duration), Progress (bar plus percentage), Needs attention, and the existing collapsible sections, Expand all / Collapse all and remembered choices when more than five projects show (UI rules §8). "My tasks" stays available on Home as today's section and also as its own page. Personal arrangement (move up/down, hide, reset) keeps working without dragging; "Needs you" never moves or hides, as today.

### 7.2 My tasks (`#/my-tasks`)

The person's tasks across projects in one `DataTable`: Task, Project, Due (UTC+8), Status, with filters by status and project and the overdue ones first. Data from `/dashboard/me` (`myTasks`). No new permissions.

### 7.3 Reviews (`#/reviews`)

Everything waiting for the person's review or decision across projects: the review and decision kinds of `needsYou` (proposals waiting, change requests, questions to answer, deadline reviews), in one table with Project, What, Since and a link. The menu badge is their count.

### 7.4 Projects (`#/projects`)

A count of projects by state as five `StatTile`s (each a filter), then the projects `DataTable` (Project, State, Owning department, Stage, Progress, Needs attention, Project Manager), the new-project action where permitted, and archived projects behind a filter as today.

### 7.5 Project overview

Left: "Needs attention in this project" (`AttentionQueue`). Right: `StageFlow` with the stage's duration and planned end; tasks done as a `StackedBar` with counts in words; "Due in the next 14 days" as a table; plus today's overview content (figures, resources and finance summary) rearranged into boxes. All of it from the existing project dashboard and overview data.

### 7.6 Other project tabs

Each tab is rebuilt on the building blocks: lists become `DataTable`s (Work, Notes and versions, People, Outputs, Resources, Timeline's list view), forms sit in boxes with their consequences stated, and the existing state messages (loading, saving, saved, failed, empty, unavailable, access denied) use one consistent look (UI rules §9). Discussion keeps human messages, AI answers, drafts and proposals visibly different, as today.

### 7.7 Reviewing proposals (D130)

Two columns on wide screens: proposals on the left, the source notes on the right with the quoted passage marked; on narrow screens the source opens in a linked view with a clear return, as today (O15). Each proposal keeps the dashed outline and "AI proposed" label, its type label and its place ("1 of 5"). Selection and the action bar ("Authorise 2 selected…", "Reject selected…") stay as today, with the selected scope and per-item errors stated.

**Correcting a proposal.** A "Correct…" button opens a correction panel in place, with Type, Wording, Owner, Due and Reason. Saving adds a correction; the AI's original stays untouched. A corrected proposal shows a "✎ Changed by a person" label and a **Change history** under it: each correction with the person's name, their project role, date and time (UTC+8), what changed (for example "type Task → Decision; wording; owner added") and the reason, ending with the AI's original proposal and the model that made it. See §9 for the rules.

### 7.8 Settings hub (`#/settings`)

`PageHeader` ("Settings", "Organisation-wide settings. Project settings live inside each project."); a summary line counting settings that are set up, need attention, are failing, or are not in use; a settings search that filters the boxes by name and purpose; then four groups of `SettingBox`es:

| Group | Settings (existing address) |
|---|---|
| Organisation and people | Organisation (`#/organisation`), Administrators (`#/people`), Departments (`#/departments`), Email domains (`#/domains`), Leadership access (`#/leadership-grants`) |
| Work rules | Approvals (`#/approvals`), Reminders and email (`#/notifications-settings`), Access and records (`#/access-settings`), Resources and finance (`#/resources-admin`), Report types (`#/report-types`), Stage templates (`#/stage-templates`, new, §14) |
| Connections | AI (`#/ai`), Email delivery (`#/deliveries`), Storage (`#/storage`) |
| Running Kainow | Operations (`#/admin/operations`), Go-live checklist (`#/go-live`), Escalated feedback (`#/escalated-feedback`), Security review (shown only to designated reviewers, `#/security/cases`) |

Each box's values and state come from one new read-only endpoint, `GET /admin/settings/summary` (Enterprise Administrator only), which returns for each setting its state (`ok`, `attention`, `failing`, `off`), a short state word, and up to three label–value pairs, computed from data the setting pages already read. The AI box lists the approved models by name and the primary and fallback roles. Examples of state: Email delivery is failing when an email failed in the last 24 hours; Leadership access needs attention when requests wait; Storage is not in use when no destination is approved; Operations follows the Operations page's own status. The builder settles each setting's state rule in the plan, from what the page already shows; none may reveal project content the Administrator could not see on that page.

### 7.9 Each setting's own page

Every page in §7.8 is rebuilt on `SettingsPage`: "At a glance" first (status, figures, the main table: for example Administrators' people table, AI's models in use and the projects nearest their limit, Operations' backup and disk status), then "Settings": each changeable setting in its own box with its current value and a Change button opening the existing form in place (with its reason field, preview and consequences as today). Pages that are mostly a list (Departments, Email domains, Report types) are a table with their actions; pages that are a checklist (Go-live) keep the checklist in boxes. Every existing form, rule and message stays.

### 7.10 Other screens

Sign-in, onboarding, the setup link, invitations, notes, threads, summaries, search, notifications, leadership, analytics, security review and held cases, deleted items and the update banner move into the shell and use the building blocks. Sign-in, the setup link and invitations stay outside the shell (no side menu before sign-in) but take the new type, boxes and the scheme.

## 8. Colour schemes and the organisation colour (D129)

- **Personal choice (C111).** In the person menu: Red, Teal, Blue, Plum, Slate, and Organisation when C112 is set; and Light or Dark. Saved with the person's existing preferences (`/me/preferences`, field `accent`), no separate settings page (UI rules §8). The server's accepted list grows to include `red` and `organisation`.
- **Default.** A person who never chose has the installation default: Organisation when C112 is set, otherwise Red. A person who chose a scheme keeps it. A person whose saved value is `organisation` falls back to Red if the organisation colour is later cleared.
- *Designer's call, how "never chose" is stored:* today every saved preferences document holds `accent: 'teal'` whether or not the person picked it, so the stored value cannot tell. The preferences document gains `accentChosen` (boolean, default false), set true only when the person picks a scheme in the person menu; while it is false the installation default applies. Migration 0036 sets `accentChosen` false on every existing row. No installation is in production use yet (v0.1 is the first release), so no real choice is lost.
- **Organisation colour (C112).** On the Organisation setting page, next to the logos: one colour (a hex value), set and cleared by the Enterprise Administrator with a reason, recorded with previous and new values like other organisation settings. Kainow derives the scheme (menu, active item, washes) from it and refuses a colour that cannot reach the contrast in §5.1 with white text on buttons and on the menu, saying so in plain words. Stored on the `organisation` row (migration 0036). Served with `/organisation/branding`, so the sign-in page uses it.
- **Before sign-in** the sign-in page uses the installation default.

## 9. Correcting a proposal (D130)

- **Who:** whoever may edit a proposal's wording today (unchanged predicate).
- **What can change:** type (task, decision, question, risk), wording, owner, due (with the existing due-date forms), as today plus type. The source quote, source version and location never change.
- **Reason:** required when the type changes; optional otherwise. At most 500 characters.
- **Storage:** `extraction_item_edits` gains `kind` and `reason` (both nullable). Every new edit row stores the kind in force after it; null appears only on rows written before 0036, which never changed the kind. Rows stay append-only. The proposal in force uses the latest edit's kind when set, else the model's.
- **Which proposals:** AI proposals (extraction items). *Designer's call:* human proposals keep today's behaviour; they were written by a named person, who already is their attribution, and the Product Owner's request was about correcting what the AI proposed.
- **Effects of a type change:** the proposal is authorised as the new type, with that type's requirements (a task still needs an assignee and a due date; a question may have alternatives). Questions' model-given alternatives are kept but not shown when the type is no longer question.
- **When a correction is allowed:** exactly as editing is today (*designer's call*): refused once the item has been authorised (records created); allowed on a pending, approved or rejected item, and, as today, it returns the item to pending and sets aside any approvals given so far, because an approval is for an exact version (Intent principle 3). The correction panel says so before saving when approvals would be set aside.
- **Shown:** the "✎ Changed by a person" label and the Change history (§7.7), visible to everyone who can see the proposal. The authorised record's history keeps the link back to the proposal and its corrections, as today.
- **Also recorded:** an audit event per correction, naming the actor, the project and the fields changed (not the wording itself).

## 10. Accessibility and responsiveness

WCAG 2.2 AA remains the target; the full audit is in 11b. 11a must not regress and must:

- keep every existing automated accessibility check passing (`tests/a11y/audit.mjs`), extended to the new pages (Settings hub, My tasks, Reviews, the person menu open, the side menu collapsed at 375 px, the correction panel and Change history);
- keep a visible focus outline in every scheme (3:1 against its background), keyboard order that follows the layout, and the skip link;
- give the side menu, person menu and collapsed sections their expanded state to assistive technology;
- make every graphic (stage flow, stacked bar, meters, progress bars) carry its values in text;
- keep every essential journey usable at 375 px and at 200% zoom without sideways scrolling of the page (tables stack into labelled pairs);
- honour reduced motion (there is no decorative motion).

## 11. Verification for 11a

- Unit tests for each building block, the scheme tokens (contrast for every scheme × theme, extending `prefs.test.ts`), the organisation-colour contrast check, and the summary endpoint's state rules.
- HTTP tests for `GET /admin/settings/summary` (Administrator only; non-Administrators refused; no project content) and for corrections with type and reason (required reason on type change, refused on decided items, authorise as the new type, history order and names).
- Migration test for 0036.
- The existing server and web suites pass.
- The automated accessibility pass passes with the new screens.
- The browser smoke (`tests/browsers/smoke.mjs`) passes in Chrome, Edge, Firefox and WebKit at desktop, tablet and phone sizes, updated for the new navigation.
- A walkthrough on the demo installation (load-test seed) with screenshots of each main screen in Red, Teal and Dark, at 1280 px and 375 px, attached to the PR for the Product Owner.

## 12. Decision Register and Catalogue entries

- **D127 (v0.1 test release).** The first published release is v0.1.0, a test release for more people to try and give feedback; V1.0 launches after that feedback. Acceptance results that need more people than are available before v0.1 (two reference reviewers, five newcomers) stay "Partly assessed" or "Not Assessed" until those people have tested; none is recorded as Passed before then. v0.1.0 is published from a new public repository, `sawitclean`, with rewritten history; the old repository becomes private. (Detailed in the 11b spec.)
- **D128 (navigation, Settings hub and page pattern)** as §6 to §7.9.
- **D129 (colour schemes and organisation colour)** as §5.1 and §8.
- **D130 (correcting a proposal)** as §9.
- **C111** personal colour scheme: Red, Teal, Blue, Plum, Slate, Organisation (when set); Light or Dark; default the installation default.
- **C112** organisation colour: none by default; Enterprise Administrator, with a reason; contrast-checked.
- **D131 (stage templates)** and **C113** as §14.

## 13. Left to the builder

- Exact token values within the contrast rules, dark-theme pairs, and the scheme derivation from an organisation colour.
- The state rule and the two or three values of each Settings box, from what each page already shows.
- How each existing screen's content maps into boxes and tables, keeping every function.
- The order of work (the plan): building blocks and shell first, then Home, My tasks, Reviews, Projects; then Settings and its pages; then the project page and tabs; then review and correction; then the remaining screens; then the accessibility pass and browser smoke.

## 14. Stage templates (D131)

**Why.** Every project today has the same five stages (Initiation, Planning, Execution, Review & Acceptance, Closure), fixed in the database. The Product Owner (24 November 2026) wants stages that fit the kind of work: software development, product sales, research, syllabus development, marketing campaigns and so on, chosen when the project is created. Configuration Catalogue C09 already intended an Enterprise Administrator base list that a project may add to or retire from; it was never built.

**Templates.** A stage template is a named, ordered list of stages, each with optional substages. Kainow ships seven starter templates (exact names; substages only where given):

| Template | Stages |
|---|---|
| General | Initiation (Define Purpose, Identify Participants, Confirm Accountability); Planning (Define Scope, Break Down Work, Identify Resources, Approve Plan); Execution (In Progress, Monitoring & Follow-up); Review & Acceptance (Review Deliverables, Resolve Outstanding Items, Confirm Acceptance); Closure (Record Outcome, Handover, Close Project) |
| Software development | Discovery; Design; Build; Testing; Rollout; Closure |
| Product sales | Lead generation; Qualification; Proposal; Negotiation; Closing; After-sales review |
| Research project | Proposal; Literature review; Methods and ethics approval; Data collection; Analysis; Writing and publication; Closure |
| Syllabus development | Needs analysis; Learning outcomes; Content design; Review and approval; Pilot delivery; Evaluation and revision |
| Marketing campaign | Research and brief; Strategy and planning; Creative development; Launch; Monitoring and optimisation; Evaluation |
| Event | Concept and budget; Planning and bookings; Promotion; Final preparations; Event day; Wrap-up and review |

**Who manages templates.** The Enterprise Administrator, on a new setting page "Stage templates" (`#/stage-templates`, Work rules group): add a template (name, short description, stages with optional substages), change a template's stages (add, rename, reorder, remove a stage or substage), retire or bring back a template. Each change needs a reason and is recorded with the actor, previous and new values. At least one template stays active. Template names are unique among active templates (case-insensitive); stage names are unique within a template; names are 1 to 80 characters. Editing a template never changes an existing project.

**Choosing at creation.** The new-project form gains "Type of project" (a dropdown of active templates, default General, each with its stages shown beside it). The project takes a **copy** of the template's stages and substages at that moment and starts in the first stage. The project records which template it came from (shown on the Overview as "Stages: Research project").

**A project's own stages.** The project's Settings tab gains a "Stages" box. The Project Manager, Owner or Sponsor (the delegated-settings authorities of Q01) may add a stage (name, place in the order, optional substages), reorder stages, or retire a stage, each with a reason, recorded in project history. Renaming is not offered: a stage's name is what its past periods record. The current stage cannot be retired; a retired stage can be brought back. Stage changes and reopening (the existing "Choose the stage to continue in") offer the project's active stages and their substages. Stages remain non-sequential, as C09 says: any active stage may be chosen next.

**History.** Past stage periods keep the stage and substage names they were recorded with, whatever happens later to the template or the project's list. Timeline, stage durations and figures read the periods as today.

**Existing data.** Migration 0037 creates the seven templates and gives every existing project a copy of General (its current five stages), so nothing changes for projects already created. The database's fixed list of stage names is removed; the server checks a stage against the project's own list instead.

**Analytics.** No measure today compares stage durations across projects; dashboards, leadership cards, analytics and CSV show each project's own current stage and days in it, unchanged. The Administrator's analytics project table gains a "Stage template" column. No cross-template comparison is introduced.

**Data handling.** Template, stage and substage names are text people type: they are registered with the credential-quarantine scanner like other names, and are never sent to an AI provider beyond the project context that already includes the current stage.

**Configuration Catalogue C113** (refines C09): stage templates; seven starter templates; Enterprise Administrator manages templates with a reason; Project Manager, Owner or Sponsor add, reorder or retire the project's own stages with a reason; default template General.

## 15. Timeline bars (D132)

**Why.** On 24 November 2026 the Product Owner asked whether projects have a Gantt chart. A Gantt chart stays outside V1.0 (Intent Card, "Outside V1.0"; tasks have only a due date, no start date or dependencies). The Product Owner chose a light, read-only "timeline bars" view for each project before v0.1, built only from dates Kainow already records.

**What it shows.** On the project's Timeline tab, above the existing list, a "Bars" view for the same date window the tab already uses (default three months back to six months ahead, UTC+8):

- a date axis with month marks and a "Today" line;
- one horizontal bar per stage period that overlaps the window, from its start to its end, or to today while it is the current stage; the current stage's bar is marked "Current" with the symbol and word, not by colour alone; a stage that started before the window starts at the window's edge with a "continues from <date>" note;
- markers on a separate row for: task due dates (grouped per day with a count, e.g. "3 tasks due"), risk review dates, resources needed by, and the planned end; each marker has its symbol and words;
- nothing is drawn for dates Kainow does not record (no task start dates, no durations, no dependencies, no forecasting, no dragging).

**Rules.**
- Read-only. It changes nothing and offers no rescheduling.
- Same audience as the Timeline list: the bars never show anything the list would not.
- Every bar and marker has its values in text: the existing month-by-month list stays below as the equivalent, and the drawing has a short text summary for screen readers ("Build: 21 Oct 2026 to today, 34 days, current. 12 tasks due in the window."). The drawing itself is hidden from screen readers to avoid reading everything twice.
- Works at 375 px: the drawing scrolls sideways inside its own box (the page itself never does) and the list below stays readable.
- Personal "hide kinds" choices on the Timeline (existing preferences) apply to the markers too.

**Data.** From the timeline response the tab already loads. If a stage period that started before the window and is still open (or ended inside the window) is not available from the lines, the timeline response gains `stagePeriods: { stage, substage, startedOn, endedOn | null }[]` for every period overlapping the window; no other server change.

**Decision Register D132** as above. No configuration entry (nothing to set).
