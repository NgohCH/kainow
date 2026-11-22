# Releasing Kainow

Only the Product Owner (PO) publishes releases. A release is an annotated git tag `vX.Y.Z` signed with an SSH key. An installation's updater installs a release only when the tag's signature verifies against the installation's own `release/release-signers` file (principal `kainow-release`, namespace `git`). There are no pre-releases: tags look like `v1.2.3` and nothing else counts.

**The first real release is `v1.0.0`, made only after the go-live history rewrite.** Until then nothing is tagged, pushed or published, and `release/release-signers` holds no key (the release script refuses).

## One-time setup (the PO, on the PO's own PC)

1. **Create the key.** The PO makes it; nothing in this repository creates, reads or stores it, and the builder never handles it.

   ```
   ssh-keygen -t ed25519 -C "kainow-release" -f <path-to-key>
   ```

   Give it a passphrase. This makes `<path-to-key>` (private, never leaves the PC and is never committed) and `<path-to-key>.pub` (public).

2. **List the public key.** Put one line into `release/release-signers`, in this format, and commit it:

   ```
   kainow-release namespaces="git" ssh-ed25519 AAAA...
   ```

   Take `ssh-ed25519 AAAA...` from the `.pub` file. Keep the comment line at the top of the file.

3. **Keep an offline copy of the private key**, in the same place and the same way as the backup-key recovery copy described in INSTALL.md. If the key is lost, installations cannot verify new releases until the signers file is replaced (see Rotating the key).

4. **Tell git which key signs.** In the repository, with the path from step 1:

   ```
   git config user.signingkey <path-to-key>
   ```

   (`gpg.format=ssh` is set by the script for its own commands.) Use `ssh-agent` if you do not want to type the passphrase for each signature.

## Making a release

1. On `main`, up to date with `origin/main`, with a clean working tree.
2. Add a section to `CHANGELOG.md` headed `## X.Y.Z` (move the entries from `## Unreleased`). Commit and push it. The section is the release notes and the tag message.
3. Rehearse, from the repository root. This works in a throwaway clone and pushes nothing:

   ```
   node scripts/release.mjs X.Y.Z --dry-run
   ```

4. Release:

   ```
   node scripts/release.mjs X.Y.Z
   ```

The script refuses unless: it is on `main`; the tree is clean; `main` equals `origin/main`; `X.Y.Z` is greater than every existing `vN.N.N` tag; the key in `user.signingkey` is listed in `release/release-signers`; and `CHANGELOG.md` has a non-empty section for `X.Y.Z`. Then it sets the version in `app/package.json`, `app/package-lock.json` and `app/web/package.json`, sets every `image: kainow-<name>:X.Y.Z` line in `compose.yaml` (app, ops and updater), commits "Release vX.Y.Z", makes the signed tag, and verifies the tag the same way an installation will. If verification fails it stops before pushing. Otherwise it asks:

```
Push vX.Y.Z to origin and create the GitHub release? (yes/no)
```

`yes` runs `git push origin main vX.Y.Z` and `gh release create vX.Y.Z` with the same notes (`gh` must be installed and signed in). Anything else leaves the commit and tag on the PC only. Dependencies: Node.js, git and `ssh-keygen`; the script adds none.

## Rotating the key

A release may change `release/release-signers` (add the new key, and in a later release remove the old one). The new key's first release must still be signed with a key the installations already trust.

When the updater installs a release, it first verifies the tag against the installation's current signers file, and only then copies that release's `release/release-signers` over it. So: release N adds the new key (signed by the old key); once installations have updated, release N+1 can be signed by the new key and may drop the old one.

If the key is lost or an installation has fallen behind a rotation, replace its `release/release-signers` by hand as INSTALL.md describes, checking the key against the one printed in INSTALL.md and on the GitHub release page.
