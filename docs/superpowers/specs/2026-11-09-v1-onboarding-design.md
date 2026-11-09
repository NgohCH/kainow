# V1.0 onboarding: the organisation, its logos and the setup invitation — design

**Date:** 9 November 2026
**Status:** Approved in conversation by the Product Owner on 9 November 2026; this document records that design.
**Builds on:** sub-projects 1, 1b and 2a (PRs #4, #5, #6) and the domain cleanup on `v1/no-org-names`.
**Authority:** the Consolidated Specification §(Enterprise Administrators): "Controlled initial setup uses a one-time invitation and closes after acceptance." The organisation name, the logos and required onboarding are new and need a Decision Register entry (below).

## 1. Why

Kainow is installed separately by each organisation. The product must ship with no organisation's name, domain or branding in its code, tests, docs, seed data or database defaults. Each installation registers its own organisation during onboarding, and that organisation's name and logo appear on the formal surfaces people see and keep: the page header, the sign-in page, emails, and reports and other formal outputs.

## 2. What the Product Owner decided

| Question | Decision |
|---|---|
| What onboarding requires | Organisation name, at least one email domain, at least one department. More departments later. |
| What can wait | A second Administrator and the recovery custodian are added later, from the Administration screens. Logos are optional. |
| Before setup is done | Everything stays closed. |
| Where the name and logo appear | Page header, sign-in page, emails, reports and formal outputs. Not on other screens. |
| First Administrator | Built now as the spec's one-time setup invitation, replacing the `create-admin` command. |
| Logos | Two, both optional: a **wide** logo and a **square** logo. Each place uses the one that fits, falling back to the other. |
| Demo | A demo seed registers "Example Organisation" at `example.com`. |
| Old commits | Rewritten before go-live, not in this work. |

## 3. The setup invitation

**Command.** `npm run setup-invite -- <email> "<display name>"` (in Docker: `docker compose run --rm api node dist/users/setup-invite-cli.js …`). It replaces `create-admin`, which is removed.

- **Allowed** only while the installation has no **active** Enterprise Administrator. Otherwise it stops with: `Setup is closed: an Enterprise Administrator already exists. Add Administrators from the Administrators screen.` and exits 1.
- **Effect:** creates (or reuses) the account as an **Invited** Enterprise Administrator and records a setup invitation with a hashed one-time token, valid **7 days** (as member invitations). It emails the link `APP_URL/#/setup/<token>`; with log delivery it prints the link (development only).
- **Re-running** before acceptance (a typo, a lost email) supersedes the earlier invitation: its link stops working, and an Invited account it created for a different address is disabled. Only one setup invitation is open at a time.
- **Accepting:** the link opens the sign-in page with the organisation's onboarding heading. Signing in with the emailed code as that address marks the invitation accepted and the account Active. From then on setup is **closed for good**: the command refuses, and the old link shows `This setup link has been used. Sign in instead.`
- A link that is expired or superseded shows `This setup link is no longer valid. Ask whoever installed Kainow to run the setup command again.`
- Recovery when no Administrator can sign in is not part of this; it is sub-project 10's controlled recovery procedure. There is no public self-service route to becoming an Administrator.

**Existing installations** (they already have an active Administrator from `create-admin`): setup is already closed; on their next sign-in the Administrator meets the onboarding screen because no organisation is registered (§4).

## 4. Onboarding: "Set up your organisation"

Until an organisation is registered:

- The **API** refuses everything except sign-in and sign-out, the current-user read, the setup-link routes, the onboarding routes and the public branding routes (§6), with **409** `Set up the organisation first.` The same refusal comes from the worker's scheduled jobs that would email or analyse (none run before setup).
- The **web app** shows an Enterprise Administrator only the onboarding screen. Anyone else who is signed in (possible only on an upgraded installation) sees `Kainow is being set up. Try again later.` and Sign out.

The onboarding screen is one page with four sections, each saved as it is completed, and a final **Finish setup** button:

1. **Organisation name** — required, 1–200 characters after trimming and NFC normalisation.
2. **Email domains** — at least one; the existing domain rules and refusals apply. Domains already present (upgraded installations) are listed and count.
3. **Departments** — at least one; the existing department rules apply. Existing departments count.
4. **Logos** — optional: a wide logo and a square logo, each with a preview in its real places (§5).

**Finish setup** checks the three requirements and names each one missing (`Add at least one email domain.`, `Add at least one department.`, `Give the organisation a name.`). On success the organisation is registered, the gate opens, and the Administrator lands on My Projects.

## 5. Logos

| | Wide | Square |
|---|---|---|
| Shape | Width 2 to 6 times the height | Width and height within 2% of each other |
| Minimum size | 40 px high | 64 × 64 px |
| Files | PNG or JPEG, at most 512 KB | PNG or JPEG, at most 512 KB |

- **SVG is refused** (it can carry scripts). The server checks the file's first bytes, not only its name or declared type, and reads the pixel size from the PNG or JPEG header. Refusals name the problem: `Use a PNG or JPEG file.`, `A logo can be at most 512 KB.`, `A square logo must be square and at least 64 × 64 pixels.`, `A wide logo must be 2 to 6 times as wide as it is high and at least 40 pixels high.`
- Files are stored in the database as received; no server-side resizing. Each place draws the logo inside a fixed box, scaled to fit without stretching.
- Each logo is uploaded, replaced or removed on its own, before or after setup, by an Enterprise Administrator.

**Where each is used** (first choice, then the fallback; with neither, the name alone and no empty box):

| Place | First choice | Fallback |
|---|---|---|
| Page header | Square in 32 × 32 | Wide in 96 × 32 |
| Browser tab icon | Square | Kainow's own icon |
| Sign-in and setup pages | Wide in 160 × 56 | Square in 72 × 72 |
| Emails | Wide in 120 × 40 | Square in 48 × 48 |
| Reports and formal outputs | Wide in 120 × 40 | Square in 48 × 48 |

The header shows the logo, then the organisation name, then the Kainow wordmark and navigation. The sign-in page shows the logo, the name, then "Sign in to Kainow".

## 6. Where the name and logos reach

- **Public branding read:** `GET /organisation/branding` returns `{ registered, name, logos: { wide: {url,width,height} | null, square: … } }`, and `GET /organisation/logo/:shape` returns the image with its type and a cache validator. These are public because the sign-in page needs them before anyone signs in. The organisation's name and logos are not confidential; nothing else about the organisation is public.
- **Emails:** every email (sign-in codes, member and setup invitations, hold alerts, and later emails) becomes multipart: a plain-text part that opens with the organisation name, and an HTML part with the chosen logo embedded as an inline attachment and the name beside it, ending `Sent by Kainow for <organisation name>.` Before registration (the setup invitation itself) the name and logo are left out.
- **Reports and formal outputs:** none exist yet. This work adds one shared letterhead helper returning the organisation name and chosen logo for a given place; later sub-projects (exports, reports, external outputs) must use it. Its footer line is `<organisation name> · page N of M`.

## 7. After setup

On the Organisation screen an Enterprise Administrator can rename the organisation and upload, replace or remove either logo. Setup's requirements keep holding: the last email domain and the last active department cannot be removed or retired (`The organisation needs at least one email domain.` / `…at least one active department.`).

## 8. Records

Migration `0016_organisation.sql`:

- `organisation` — exactly one row when registered (`id smallint PRIMARY KEY CHECK (id = 1)`), `name`, `registered_by`, `registered_at`, `updated_by`, `updated_at`.
- `organisation_logos` — `shape` (`'wide' | 'square'`, primary key), `content bytea`, `mime`, `width`, `height`, `byte_size`, `uploaded_by`, `uploaded_at`.
- `setup_invitations` — `id`, `user_id`, `email`, `token_hash` (unique), `created_at`, `expires_at`, `accepted_at`, `superseded_at`; a partial unique index allows only one open invitation.

Audit entries (`writeAudit`): `setup.invitation_issued`, `setup.invitation_superseded`, `setup.accepted`, `organisation.registered`, `organisation.renamed` (from/to), `organisation.logo_set` (shape, size, pixels), `organisation.logo_removed` (shape). Logo contents are never written to the audit log.

## 9. Demo seed

`npm run seed-demo` (refused unless the database has no organisation and no users) issues nothing by email: it registers "Example Organisation", adds the domain `example.com` and a department "Operations", and creates the Enterprise Administrator `admin@example.com` as Active. Its output says it is for demonstration only.

## 10. Testing

- Unit: image sniffing and sizing for PNG and JPEG (including a renamed SVG and a truncated file), shape rules, the fallback table.
- HTTP: the setup command's open/closed rules and supersede; link states (valid, used, expired, superseded); the gate (each allowed route and a sample of refused ones, before and after Finish setup); Finish setup's three refusals; logo upload limits and refusals; branding reads before and after registration; the last-domain and last-department guards; audit entries.
- Email: the multipart message carries the name and the inline logo; text-only when nothing is registered.
- Web: header and sign-in rendering with each logo combination; accessibility pass with the onboarding screen and both logo states (logos need alt text: the organisation name).
- The Docker install walk-through: a fresh install from the setup command to My Projects, and an upgrade of the existing install meeting onboarding.

## 11. Decision Register entry (to add)

**Organisation registration at onboarding (9 November 2026).** Each installation registers its organisation's name, at least one email domain and at least one department before first use; until then only setup is open. An Enterprise Administrator may add a wide and a square logo. The name and logo appear on the page header, sign-in page, emails, and reports and formal outputs. The product contains no organisation's name or domain. The first Administrator is created through the one-time setup invitation, which closes once accepted.

## 12. Out of scope

Recovery when no Administrator can sign in (sub-project 10); a second Administrator and the recovery custodian (already on the Administrators screen, or sub-project 10); reports and exports themselves (later sub-projects, using the letterhead helper); a dark theme; rewriting old commits (before go-live).
