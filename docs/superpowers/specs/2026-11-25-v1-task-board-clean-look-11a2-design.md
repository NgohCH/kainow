# Sub-project 11a.2: task boards and a cleaner look

Status: Draft for the Product Owner's approval, 25 November 2026. Built after 11a.1 merges and before v0.1.

## 1. Why

The Product Owner likes how Plane lists tasks and its overall clean look, and wants tasks "separated by columns, and in boxes", with the same look for Needs you. Kainow keeps its own identity: no code, icons, artwork or layout copied from another product.

## 2. Goals, non-goals, anti-goals

**Goals:** see at a glance what is in which state; tasks as boxes in columns; calmer pages where colour means something.
**Non-goals:** dragging; start dates, dependencies or a Gantt chart; new statuses; changes to approvals.
**Anti-goals:** nothing hidden that was shown before; no rule widened; no sideways page scroll at 375 px; colour never alone.

## 3. Approaches

1. **Boards as the first view, list kept as the other (chosen).** Fits the Product Owner's request and keeps sorting and dense reading.
2. Boards only. Simpler, but loses sortable tables and is poor for hundreds of tasks.
3. Slim grouped rows with a side panel (first mockup). Set aside for boxes in columns; its side panel and overall look are kept.

## 4. Task board on a project's Work tab

- Columns Not started, In progress, Blocked, Completed, each with symbol, word, coloured top edge and count; or one column per assignee. List is the other view.
- A box shows title, due date, overdue or due-soon label, assignee, subtask progress, the reason when Blocked, and any waiting or held label the row shows today.
- Selecting a box opens a side panel (below the board in a narrow window): the main details, the same actions and forms as the task page under the same rules, and "Open full page". Closing returns focus to the box.
- No dragging. Moving is by the actions, which ask for the notes Kainow requires.
- A column shows ten boxes with "Show more". Completed covers the last 30 days and starts folded. Cancelled and older completed tasks are in the list view.
- Subtasks appear inside their parent's box.
- Decisions, questions and risks stay as tables below.
- At phone width: one column at a time with a picker showing every column's count.

## 5. My tasks board

The same columns across projects. Inside each column, boxes stand under their project's name, most urgent project first. A subtask assigned to the person has its own box, naming its parent. The views are Board (default), By project (11a.1) and Due date; the filters apply to all.

## 6. Needs you

On Home, columns Overdue, Review and decisions, Blocked, Due soon, with the same boxes: what, the date with its meaning, and a link to it. Inside each column, boxes stand under their project's name. Empty columns are left out. "By project" (11a.1) is the other view. Reviews keeps its own page.

## 7. Overall look

White pages, thin lines, fewer nested boxes; accent only for selection, links and the main button; state colours only for states. Boxes stay on Home, Settings and the Overview. The side menu is light by default, with the dark one as a personal option, and lists the person's current projects (first ten by name, then "All projects"). Binder tabs stay as chosen in 11a.1. Compact or comfortable spacing is a personal setting. Applies in every scheme, Light and Dark.

## 8. Accessibility

Columns are lists with headings; boxes are links or buttons with full names; arrow keys are not required; focus and announcements as in 11a. Contrast as in 11a, tested for the light menu in every scheme.

## 9. Verification

Pure tests for columns, ordering, counts and folding; a test that board, list and by-project views hold the same tasks; permission tests unchanged; accessibility audit and browser smoke of every new view at 1200 and 375 px, Light and Dark; real-server checks, no stubbed replies; a speed check with 500 tasks.
