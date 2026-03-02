# US Visa Auto Rescheduler (Chrome Extension)

A Chrome extension that automates appointment checking on `ais.usvisa-info.com` and can auto-fill/auto-submit when a matching slot is found.

## Features

- Auto-login on sign-in page using saved credentials.
- Appointment day polling across selected Canadian consulates.
- Date-range filtering and business-day checks.
- Optional auto-booking after date + time are selected.
- Retry/backoff handling for temporary errors and maintenance pages.
- Auto-recovery from browser network error tabs.
- Optional on-page debug overlay for live logs.

## Project Structure

- `manifest.json` — Extension configuration (MV3).
- `background.js` — Alarm-based tab recovery logic.
- `content.js` — Main automation logic (login, polling, selection, submit).
- `popup.html` — Popup UI layout.
- `popup.js` — Popup settings load/save logic.
- `styles.css` — Popup styling.

## Setup (Load Unpacked)

1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.

## Usage

1. Open extension popup.
2. Enter login email/password.
3. Select date range and preferred cities.
4. Set check frequency and min/max delay.
5. Enable:
   - **Activate Script** to start checking
   - **Enable Autobook** to auto-submit when possible
   - **Show Debug Overlay** for on-page logs
6. Navigate to the AIS schedule/appointment page and keep that tab open.

## Notes

- This extension is scoped for `https://ais.usvisa-info.com/en-ca/*`.
- Be careful with frequent polling to avoid rate limits.
- Keep your credentials secure.

## GitHub Push (Quick)

If your local commit already exists, push with:

```bash
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

If `origin` already exists, update it with:

```bash
git remote set-url origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

## Disclaimer

Use responsibly and in compliance with all website terms and applicable laws.
