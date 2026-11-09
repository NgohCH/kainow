# V1.0 cross-project search — design

**Date:** 9 November 2026
**Status:** Approved in conversation by the Product Owner on 9 November 2026, section by section; this document records that design.
**Builds on:** sub-project 2b (PR #9, branch `v1/records-2b`). Branch `v1/search`.
**Authority:** Intent Card principle 4 (audience rules apply to search); Consolidated Specification §2 (access controls apply to search), §12 and D57 (Deleted content hidden from search), O02 (archive changes navigation, Archive filter), O09 (no query bypasses source restrictions), O14 (current access; Administrator standing is not content access); Discussion, Evidence, Access and History Rules §5 and §9 (no leaks through search results or snippets); Permission Matrix §1 and §4 (read authority); UI, Navigation and Accessibility Requirements §2, §9 and §10. The specification has no search feature of its own; it only constrains search. This design adds no new permission.

## 1. Purpose

The Product Owner's request: Owners, Sponsors and Members who belong to several projects may mix up project details and need to find out which project holds a detail. Cross-project search lets a person type a half-remembered phrase and see, across every project they can currently read, which project contains it and what kind of item it is, then open it in one step. It never shows anything the person could not already open.

## 2. Decisions taken with the Product Owner

| Question | Decision |
|---|---|
| Who searches | Everyone with current read access to a project: PM, Deputy, Owner, Sponsor, Member, and Audit/Oversight grant holders within their read-only scope. An Enterprise Administrator sees results only from projects where they hold a role or grant. |
| What is searched | Everything the person can read today: projects, people in projects, notes, proposals not yet authorised, tasks, decisions, questions and answers, risks. New content kinds join when built, under their own access rule. |
| Matching | Every word typed must appear, in any order, as part of a word, ignoring case. No language-specific stemming, so English and Bahasa Melayu behave the same. No typo tolerance. |
| Archived projects | Off by default; an "Include archived projects" option adds them, labelled Archived. |
| Earlier wording | Searched too, labelled: earlier note versions, earlier proposal wording, task titles before an amendment. |
| Approach | One database view over the live tables with trigram indexes, access applied at query time (no copied index). |

## 3. Which projects are searched

1. Candidates are `ProjectAccess.visibleProjectIds(user)`.
2. Each candidate is checked with `ProjectAccess.load()`, exactly as `ProjectsService.list` does: the project stays only if the person has a role Active today or an Audit/Oversight grant that gives access today. Held memberships, suspended or expired grants and Scheduled memberships not yet started drop out.
3. Archived projects (worked out as in `ProjectsService.archiveOf`) are dropped unless the request asks to include them.
4. Draft, Planned, Active, Deferred and Closed projects are all included; Deferred and Closed remain readable (D21, D22).
5. An Enterprise Administrator gets nothing from a project where they have no role or grant.

The view never decides access; the service passes the readable project ids into the query.

## 4. What can match

The joined text of an item is searched as one text, so the words may be spread across its fields. A result is one item; the item opens where the person already reads it.

| Kind (`kind`) | Current wording searched | Earlier wording searched (match note) | Shown as title | Opens |
|---|---|---|---|---|
| `project` | name + purpose | — | project name | `#/projects/:id` |
| `person` | display name of a holder of a role that is Active or Scheduled today | — | name; role and state instead of a snippet (e.g. "Member · Active") | `#/projects/:id/people` |
| `note` (title) | note title | — | note title | `#/notes/:id` |
| `note` (text) | text of the latest version | text of earlier versions ("Matched version 2 of 4") | note title | `#/notes/:id`, or `#/notes/:id/v/:n` for an earlier version |
| `ai_proposal` | wording in force + supporting quote, for items not yet authorised | the model's original wording and earlier edits ("Matched earlier wording") | wording in force | `#/runs/:runId` |
| `human_proposal` | text, for proposals not yet authorised | — | text | `#/projects/:id/notes/<id>` |
| `task` | title (tasks and subtasks) | titles before an amendment ("Matched wording before an amendment") | current title | `#/projects/:id/work/<id>` |
| `decision` | statement + rationale, any status (status shown) | superseded decisions are results of their own | statement | `#/projects/:id/work/<id>` |
| `question` | question text | — | question text | `#/projects/:id/work/<id>` |
| `question` (answer) | each answer ("Matched an answer") | — | question text | `#/projects/:id/work/<id>` |
| `risk` | description + mitigation | — | description | `#/projects/:id/work/<id>` |

Not searched:

- Authorised proposals: their record is the result, so the same thing does not appear twice.
- Change-request wording: pending changes show on the record they affect, and authorised changes become the record's wording.

**Note title and note text match separately, and so do a question and each of its answers.** They live in different tables and a combined expression cannot be indexed, so a phrase whose words are split between a note's title and its body, or between a question and an answer, does not match. Every other item matches across all its fields.

## 5. Protection that later sub-projects must keep

- Every row of the view carries `source_id` when its text comes from a note: note rows, and AI proposal rows through their source version.
- The service filters rows through one predicate on `source_id`, "this person may read this note's content". Today it means the note is not Deleted (`sources.status <> 'deleted'`).
- When restricted note audiences (O09), logical deletion of records and messages, and quarantine (sub-project 5) arrive, each adds its condition there, or to the view's branch for the record kind, and every derived result obeys it. Snippets are cut only from rows that passed every filter.
- Discussion (sub-project 4) and outputs (sub-project 9) add their own branches with their own access rule.
- A guard test (§9) fails when the view returns a kind that has no access test.

## 6. The query

**Phrase.** `q` is trimmed and NFC-normalised, then split on whitespace into at most 8 words. One-character words are dropped. At least one remaining word must have 3 or more characters, otherwise the response is 400 "Type at least one word of 3 or more letters." `q` longer than 200 characters gets a 400. Each word is escaped (`\`, `%`, `_`) and becomes the pattern `%word%`. A row matches when its text matches every pattern with `ILIKE` (`text ILIKE ALL($patterns)`).

**One statement** over `search_documents`, run under `SET LOCAL statement_timeout = '5s'` in a read-only transaction:

1. Keep rows whose `project_id` is in the readable ids, whose `kind` is in the requested kinds, and whose `source_id` passes the note predicate (§5).
2. Keep rows matching every pattern.
3. One result per item (`kind`, `item_id`): prefer a current-wording row over an earlier-wording row, then the newest earlier row. Note title and note text rows belong to the same item.
4. Snippet: about 160 characters of the matched row's text around the first occurrence of the first matching word, cut on character boundaries, with "…" where text was cut. Person results have no snippet.
5. Per project: the total count of results and the first 10 in order (§7). With a `project` filter: 50 results from `offset`.
6. At most 30 projects in the response.

The phrase is never written to the audit trail, application logs or error details.

## 7. Order, limits and filters

- Projects in name order (as on My Projects), then by id.
- Within a project, results in this order: Project, People, Tasks, Decisions, Questions, Risks, Proposals (AI and human), Notes; within a kind, newest first. Newest means the item's own time: authorised, proposed or created time, or a person's membership start date.
- Each project shows its total and its first 10 results. "Show all N in this project" runs the same search with the `project` filter, 50 at a time ("Show more").
- Filters: kinds (any combination; default all), "Include archived projects" (default off), one project (set when the search is opened from inside a project; removable).

## 8. API and screen

### 8.1 API

`GET /search?q=…&kinds=task,decision&archived=1&project=<uuid>&offset=0`, available to any signed-in account.

- `kinds` must be values of `SEARCH_KINDS` (`project, person, note, ai_proposal, human_proposal, task, decision, question, risk`), otherwise 400 naming the unknown value. `offset` is a non-negative integer and is used only with `project`.
- A `project` id that is malformed, unknown or not readable by the person gets the same response as no matches (`projects: []`, `searched` unchanged). It is never a 404 that would confirm the project exists.
- Response:

```json
{
  "searched": 7,
  "projects": [
    {
      "id": "…", "name": "…", "status": "active", "archived": false,
      "myAccess": { "roles": ["sponsor"], "grant": null },
      "total": 12,
      "results": [
        { "kind": "task", "id": "…", "title": "…", "snippet": "…", "matchNote": null, "status": "in_progress", "href": "#/projects/…/work/…" }
      ]
    }
  ]
}
```

`searched` is the number of readable projects that were searched (after the archive filter, before the `project` filter).

On timeout the response is 503, "Search took too long. Try more specific words." It is never an empty result.

### 8.2 Screen

- **Header box.** Every signed-in page has a search box in the main header, labelled "Search your projects". Enter opens `#/search?q=…`. Inside a project, the search opens with that project as its filter.
- **Search page (`#/search`).** It has the phrase box, kind checkboxes and "Include archived projects", inside a `<details>` on narrow screens. When the search is scoped to a project, an "Only <project name>" chip appears that can be removed. A line says "Searched N projects you can currently see".
- **Results.** Results are grouped under a heading per project: its name, status (Archived and Closed are shown), "Your role: Sponsor" or "Audit access", and "N matches". Each result shows:
  - a kind label;
  - for AI proposals, the dashed outline and the "AI proposed" label;
  - the title as a link, the status, the snippet with the matching words in `<mark>`, and the match note;
  - "Show all N in this project" where there are more.
- **Item deep links.** `#/projects/:id/work/<id>` (records) and `#/projects/:id/notes/<id>` (human proposals) open that tab, scroll the item into view, move focus to it and briefly outline it. The outline is not shown by colour alone. The project route accepts the optional item segment.
- **States (UI §9).**
  - Loading.
  - Empty: "No matches in the projects you can see."
  - Unavailable: the timeout message.
  - Validation: the 400 message beside the box, keeping what was typed.
- **Accessibility.**
  - A list under each project heading.
  - The result count announced through a polite live region.
  - `<mark>` styled bold as well as coloured.
  - Full keyboard operation with visible focus.
  - One column at phone width and 400% zoom.

## 9. Database and code

### 9.1 Migration `0019_search.sql`

- `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (a trusted extension since PostgreSQL 13; available in `postgres:16` and in the test container).
- `CREATE VIEW search_documents (project_id, kind, item_id, source_id, run_id, version_no, is_current, match_note, text, ref_title, status, at)`, one `UNION ALL` branch per row of §4:
  - projects;
  - people: memberships joined to users, not revoked, Active or Scheduled today in UTC+8;
  - note titles;
  - note versions, with `is_current` for the highest `version_no`;
  - AI proposals: `extraction_items` not yet authorised, with the original wording and quote, plus each `extraction_item_edits` row. The newest edit, or the original when there is no edit, is current; the rest are earlier.
  - human proposals with `review_status <> 'approved'`;
  - tasks;
  - earlier task titles: `task_events` with `kind = 'amended'` and `detail ? 'title'`, text `detail->'title'->>'from'`;
  - decisions;
  - questions;
  - answers;
  - risks.
- One trigram GIN index (`gin_trgm_ops`) per branch on exactly the expression that branch searches. Where the branch filters, the index is partial on the same condition (for example the amended `task_events`). Nullable fields are joined with `coalesce(…, '')`.

Whether an AI proposal is authorised is read from the records that came from it (`origin_item_id`). The plan settles the exact condition against the 2a/2b code.

### 9.2 Server, `app/src/search/`

| File | Purpose |
|---|---|
| `query.ts` | Pure: `SEARCH_KINDS`, phrase parsing, validation and escaping, `kinds`/`offset` parsing, href building. |
| `search.service.ts` | Readable projects (§3), the one statement (§6), response shape (§8.1). |
| `search.controller.ts`, `search.module.ts` | `GET /search`, signed-in guard, registered in `app.module.ts`. |

`ProjectAccess` is reused unchanged.

### 9.3 Web, `app/web/src/`

| File | Purpose |
|---|---|
| `search.ts` | Pure: highlight splitting (text and marked segments, never HTML strings), query-string building. |
| `views/Search.tsx` | The search page. |
| `App.tsx` | Header box and `#/search` route. |
| `App.tsx`, `ProjectPage.tsx`, `Work.tsx`, `HumanProposals.tsx` | Optional item segment on the work and notes routes; element ids on records and human proposals; the scroll/focus/outline behaviour. |

## 10. Testing

**Unit.**
- Phrase parsing: whitespace, NFC, one-character words, the 3-letter rule, the 8-word cap, the 200-character cap, and escaping of `%`, `_` and `\`.
- `kinds` and `offset` parsing.
- Href building.
- Highlight splitting: overlapping words, case, and characters that would be special in regular expressions.

**HTTP against the test database**, one file at a time, with `KAINOW_TEST_DATABASE_URL`.

Access:
- These see nothing: a non-member; an Enterprise Administrator with no role; a held membership; a Scheduled membership not yet started; an expired, suspended or revoked grant; and an expired or revoked membership.
- An Active Audit/Oversight grant holder sees results.
- Deferred and Closed projects are searched.
- Archived projects are searched only with `archived=1`.
- An unreadable `project` filter gets the same response as no matches.
- Results from a Deleted note's text and from its AI proposals are hidden.
- Two projects with the same detail: each person sees only the project they can read.

Matching:
- All words in any order, part of a word, and case-insensitive matching.
- Words spread across two fields of one item.
- Every kind's title, href, status and match note.
- Earlier note versions, earlier proposal wording and pre-amendment task titles, each labelled.
- One result per item.
- Authorised proposals excluded.
- Order, per-project limit, "show all" paging and the 30-project cap.
- 400s for bad input.
- The timeout path, with `statement_timeout` forced low in the test, returns 503.

Guard:
- `SELECT DISTINCT kind FROM search_documents` over a seed holding every kind must equal `SEARCH_KINDS`.
- The access test list names every kind.

**Web unit tests** for `search.ts`, and a render test for the empty, unavailable and validation states.

**Measured check (recorded in the plan, not promised).** Seed about 50 projects with 20 notes of about 8,000 words each, plus records, then time typical searches. The aim is under 1 second, with `EXPLAIN` showing the trigram indexes in use. Record the measured times.

## 11. Out of scope

- Search history and saved searches.
- Typo tolerance and stemming.
- Searching uploaded originals beyond their extracted text.
- An Administrator analytics event for searches; searches leave no trace containing the search text.
- Searching discussion, outputs, finance or resources, which join with their own sub-projects under §5.
