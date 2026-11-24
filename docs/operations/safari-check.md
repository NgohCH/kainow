# Safari check (by hand)

Kainow supports the current and previous major Safari on Mac, iPhone and iPad (decision D124). Safari only runs on Apple devices, so it cannot be checked automatically on the Windows development PC: the automated run uses the WebKit engine, which is close to Safari but is not Safari. This checklist is the Safari check. It is written for the Product Owner; no programming is needed.

**Time:** about 10 minutes to start the test installation on the PC, then about 15 minutes per device (Mac, iPhone, and iPad if you have one), and 5 minutes to undo. About 45 minutes for a Mac and an iPhone.

**What you need:** the development PC, a Mac and/or an iPhone or iPad on the **same Wi-Fi or office network** as the PC, and this page open on the PC.

Everything you will see is dummy data: the organisation is "Example Organisation" and every person is `load-NNN@example.org`. No real email is sent and no AI is used.

---

## Part A. Start the test installation on the PC

You start a separate, throwaway copy of Kainow on the PC that the Apple device can open over the local network. It does not touch the real Kainow or its data.

1. On the PC, open **PowerShell** (Start menu, type `PowerShell`, open **Windows PowerShell**, not "as administrator").
2. Go to the Kainow folder the builder named, then into `app`:

   ```
   cd <the Kainow folder the builder gave you>\app
   ```

3. Make the throwaway database (the test database container `kainow-testdb` must be running in Docker Desktop):

   ```
   docker exec kainow-testdb createdb -U postgres kainow_safari_check
   ```

4. Set this window's settings. These last only while this PowerShell window is open:

   ```
   $ip = (Get-NetIPConfiguration | Where-Object IPv4DefaultGateway | Select-Object -First 1).IPv4Address.IPAddress
   $env:DATABASE_URL = "postgres://postgres:test@127.0.0.1:55432/kainow_safari_check"
   $env:AUTH_SECRET = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
   $env:PORT = "3312"
   $env:APP_URL = "http://${ip}:3312"
   $env:COOKIE_SECURE = "false"
   $env:LOG_SIGN_IN_CODES = "true"
   $env:KAINOW_RELEASE_API = "http://127.0.0.1:9"
   "Open this on the Apple device: http://${ip}:3312"
   ```

   The last line prints the address to open, for example `http://192.168.1.23:3312`. **Write it down.**

   Why these settings: Kainow is reached by the PC's address on the local network (`APP_URL`); it is plain `http`, so the sign-in cookie must not require a secure connection (`COOKIE_SECURE=false`, for this check only); sign-in codes are shown in this window instead of being emailed (`LOG_SIGN_IN_CODES=true`).

5. Build it, set up the database and fill it with the test data (about 3 minutes):

   ```
   npm run build; npm run build:web; npm run migrate; node dist/loadtest/load-test-cli.js --seed
   ```

   The last line should end with `Seeded in … s: 200 people, 40 projects …`. A warning about "No protected key" is expected.

   Then add a finished AI reading of one note, with three decisions waiting for review (no AI is used; one decision per device):

   ```
   node ..\tests\browsers\review-run.mjs 3
   ```

   It should say `A finished AI run with 3 decisions to review is on "Meeting notes 6.1" in Load Project 06`.

6. **Do this only on your home or office network, never on public Wi-Fi** (a café, hotel or airport): the rule lets in every device on the same network. Let the Apple device in through the Windows firewall. This needs an administrator: open a **second** PowerShell window **as administrator** (Start menu, type `PowerShell`, right-click, **Run as administrator**) and run:

   ```
   New-NetFirewallRule -DisplayName "Kainow Safari check" -Direction Inbound -Protocol TCP -LocalPort 3312 -RemoteAddress LocalSubnet -Action Allow -Profile Any
   ```

   Then close that administrator window. The rule lets in only devices on the same local network (`LocalSubnet`), and only on port 3312; Part E removes it. If the Apple device still cannot open the page in Part C, tell the builder.

7. Back in the first window, start Kainow and **leave this window open** for the whole check:

   ```
   node dist/main.js
   ```

   It is ready when it shows `kainow api listening on 3312`. (If Windows shows a "Windows Security Alert" about Node.js, choose **Cancel**: the rule from step 6 already lets the Apple device in.) The sign-in codes will appear in this window as lines like `load-001@example.org: 123456`.

Kainow now listens on all of the PC's network addresses on port 3312, including its local network address; the firewall rule lets in the local network only. Again: only on your home or office network, never on public Wi-Fi.

*(If the builder has instead set up the test installation on a cloud machine, skip Part A and Part E: open the address the builder gives you.)*

## Part B. Read the Safari version

Write the exact version in the result table (Part D).

- **Mac:** open Safari, then in the menu bar **Safari › About Safari**. Write the version, for example `26.1 (21622.2.11)`. Also note the macOS version: **Apple menu › About This Mac**.
- **iPhone or iPad:** Safari's version is the iOS (or iPadOS) version. Open **Settings › General › About** and write the **iOS Version** (or **iPadOS Version**), for example `26.1`.

## Part C. The journey

Do these steps on each device, in Safari, one after the other. After each step, write **OK** in the box if what should appear appeared, or write what happened instead. If something looks broken (text on top of other text, a button that does nothing, a red error message, a page that stays on "Loading"), write it down, take a screenshot if you can, and carry on with the next step.

On an iPhone the menu at the top of every page is long: scroll up to see it.

| # | What to do | What should appear | As expected / what happened |
|---|---|---|---|
| 1 | Open Safari and type the address from Part A (for example `http://192.168.1.23:3312`). | "Example Organisation", "Sign in to Kainow" and a **Work email** box. | |
| 2 | Type `load-001@example.org` in **Work email** and tap **Email me a sign-in code**. Look in the PowerShell window on the PC for the last line `load-001@example.org: NNNNNN`. Type those 6 digits in **Sign-in code** and tap **Sign in**. | Home: a greeting ("Good morning, Load" or similar) and **Needs you**. (If no code appears, wait one minute and tap **Use a different email**, then ask again.) | |
| 3 | Tap **Projects** in the side menu (on an iPhone or a narrow iPad window, tap **Menu** at the top left first). | **Projects**, with Load Project 01 in the table. | |
| 4 | Tap **Load Project 01**. | The title **Load Project 01**, a row of tabs under it, and a box **About**. | |
| 5 | Tap the **Work** tab. | A box **Tasks** with a table of tasks. | |
| 6 | Find a task that has a **Block** button (an "In Progress" task). Tap **Block**, type `Waiting for the Safari check` in **Why is it blocked?**, and tap the **Block** button under it. | "Block: done." and that task now shows **Blocked**. | |
| 7 | Tap the **Discussion** tab, then the first discussion (for example "The survey plan, part 3"). Type `Safari check comment` in **Write a message** and tap **Post**. | Your comment appears at the end of the messages, with your name (Load Person 001). | |
| 8 | Go back to Load Project 01 (**Projects**, then **Load Project 01**), tap the **Notes** tab, then the first note (for example "Meeting notes 1.8"). | The note's title as the page heading and the text of the notes. | |
| 9 | Tap **Projects**, then **Load Project 06**, the **Notes** tab, then the note **Meeting notes 6.1**. Under **Proposals from this version**, tap **Review**. | **Review proposals** inside the project: three decisions found in the notes (for example "Review the … figures before the next meeting"), each with the passage it quotes, and the notes beside them (on an iPhone, tap **Show in the notes** under a decision, then **Back to proposal**). A red box asking for the meeting date is expected; leave it. | |
| 10 | On a decision that still has an **Authorise** button, tap **Authorise**. A form opens; tap the **Authorise** button at its foot. | That decision now shows **Authorised: see the Work tab**, and the count at the top says one more approved. | |
| 11 | Tap **Projects**, then **Load Project 06**, then the **Proposals** tab. Scroll down to **Proposals from people**. On one "Proposed: change the …" proposal, tap **Authorise**, then the **Authorise** button at the foot of the form. | "Authorised: it is now on the Work tab.", and that proposal now says "authorised (see the Work tab)". | |
| 12 | Tap **Home** in the side menu. | **Needs you** (boxes for Overdue, Blocked and so on) and **My tasks**, with tasks grouped by Overdue, Due in the next 7 days and Later. | |
| 13 | Tap **Projects**, then **Load Project 01**. | The project's Overview, with **Figures** (numbers of tasks, decisions, questions, risks). | |
| 14 | Tap **Analytics** in the side menu. | **Analytics**, with **Saved views** and charts or figures under it. | |
| 15 | Tap **Operations** in the side menu. | **Operations**, with a **Backups** box ("No backup yet" is expected on this test copy). | |
| 16 | Tap the button with your name (top right), then **Sign out**. | The sign-in page again ("Sign in to Kainow"). | |

Also try, on the iPhone or iPad: turn the device sideways on one or two pages, and pinch to zoom. Note anything that does not fit or cannot be reached.

## Part D. The result to send back

Copy this table into your reply to the builder, one row per device. In "Steps" write **all OK** or the step numbers that were not as expected; put what happened in "Notes". The builder records it in the browser matrix (`docs/operations/browser-matrix.md`).

```
| Device (model) | Mac/iOS/iPadOS version | Safari version | Date | Steps | Notes |
|---|---|---|---|---|---|
| Mac (e.g. MacBook Air) | macOS … | … | … | all OK / 6, 9 not as expected | … |
| iPhone (e.g. iPhone 15) | iOS … | same as iOS | … | … | … |
| iPad (if checked) | iPadOS … | same as iPadOS | … | … | … |
```

## Part E. Undo everything on the PC

When every device is done:

1. In the PowerShell window where Kainow runs, press **Ctrl+C** to stop it.
2. Remove the throwaway database (in the same window):

   ```
   docker exec kainow-testdb dropdb -U postgres kainow_safari_check
   ```

3. Close the PowerShell window. Its settings (including `COOKIE_SECURE=false` and the network address) end with it; nothing was written to a settings file.
4. Remove the firewall rule: open PowerShell **as administrator** again and run

   ```
   Remove-NetFirewallRule -DisplayName "Kainow Safari check"
   ```

   then close it.
5. Optional, on each Apple device: forget the test site. Mac: **Safari › Settings › Privacy › Manage Website Data**, search for the address and **Remove**. iPhone/iPad: **Settings › Apps › Safari › Advanced › Website Data** (on older iOS, **Settings › Safari › Advanced › Website Data**), find the address and swipe to delete.

The PC is then as it was before the check.
