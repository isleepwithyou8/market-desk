# Global Market Intelligence

Your trading dashboard: US, India and Global views, a scanner built on your teacher's rules, earnings and event calendars, and research tabs.

## What's in this folder

- `index.html` — the whole dashboard (open it in a browser; it shows the data snapshot from Nov 3, 2026)
- `api/yahoo.js` — a small proxy that lets the dashboard pull live data once it is hosted
- `engine.js` — the scanner rules (already built into `index.html`; edit here, then rebuild)
- `src/app.html` + `build.py` — source of the page and the script that puts it together

## Make it live (free, about 10 minutes)

1. Make a free account at https://vercel.com
2. Click **Add New → Project**, then upload this folder (or push it to GitHub and import it). No settings needed.
3. Open the link Vercel gives you. The pill at the top says **Live** and data refreshes every 5 minutes.

## Change things

- Watchlists: edit `MARKETS` in `src/app.html`
- Rule settings (Supertrend 10/2, RSI 20/80, Stochastic 14/5/3, 1:2 target): edit `CONFIG` in `engine.js`
- Fed, CPI, RBI, holidays: edit `EVENTS` in `src/app.html` (expiries are calculated automatically)
- After editing `src/app.html` or `engine.js`, rebuild: `python3 build.py snapshot.json`

## Notes

- Data: Yahoo Finance public endpoints. Free, no key, but unofficial; futures are delayed about 10 minutes.
- Signals are guidance for your own research. Check the Playbook page for how each rule actually performed.
