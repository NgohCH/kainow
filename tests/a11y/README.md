# Automated accessibility pass

`audit.mjs` runs axe-core (WCAG 2.0/2.1/2.2 A and AA rules, plus best-practice rules) in headless Chrome over every screen, at 1200 px and 375 px wide: sign-in, the code step, the wrong-code error, notes, a note, the review screen, the wording editor, people and AI spending.

It needs no Docker and no AI key. It needs a scratch database and the API running against it:

```
createdb kainow_a11y
export DATABASE_URL=postgres://.../kainow_a11y AUTH_SECRET=<32+ random characters> LOG_SIGN_IN_CODES=true COOKIE_SECURE=false PORT=3066
cd app && npm run build && npm run build:web && npm run migrate
npm run create-admin -- a11y@example.org "Access Check"
node dist/main.js > /tmp/a11y/api.log 2>&1 &        # keep this running
curl -s -XPOST localhost:3066/auth/request-code -H 'content-type: application/json' -d '{"email":"a11y@example.org"}'
cd ../tests/a11y && npm install && node audit.mjs
```

The script signs in with the code printed in the API log, adds one note, and inserts one finished extraction run with four proposals (a repeated quote, a quote that is not in the notes, an owner and a deadline) so the review screen has something to check. Settings: `KAINOW_URL`, `KAINOW_EMAIL`, `KAINOW_API_LOG`, `CHROME`, and `DATABASE_URL` (for the inserted run). Never point it at a real database.

## What a clean result means

Run on 7 November 2026: 0 violations across 18 screen states.

Automated rules find only a part of the real problems (missing names and labels, colour contrast, bad structure). A clean run does not show the product is accessible. Still to do by hand, as part of the January accessibility audit: keyboard-only use of every screen, focus order and visible focus, a screen reader on the review screen (the marked passage and the repeated-passage chooser), zoom to 200%, and reduced motion. The app has no dark theme, so none was tested.
