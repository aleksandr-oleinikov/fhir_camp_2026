# Patient medicines demo

A mobile-first web app for patients. It lists their medicines, groups any pairs that may not mix well with a 1 to 3 "!" severity, and lets them add medicines they buy over the counter.

All data is made up. The conflict wording and severity levels are placeholders and have not been clinically reviewed.

## Run it

Needs Node.js 20 or later.

```
cd app
npm install
npm run dev          # http://localhost:3000, restarts on changes
```

## Build the static demo

```
npm run build:demo   # writes dist/index.html
```

`dist/index.html` is one self-contained file. It runs entirely in the browser, so it works from any static host (GitHub Pages, Cloudflare Pages) or opened straight from disk. Changes made in the demo are saved in that browser only; the footer has a "Reset the demo" button.

## How it fits together

| Path | What it does |
| --- | --- |
| `lib/core.js` | All page logic: routes, view models, conflict checking. Shared by the server and the static build |
| `server.js` | Express dev server around `lib/core.js` |
| `client/main.js` | In-browser runtime for the static build: hash links, form handling, saved state |
| `build.js` | Precompiles the EJS templates and bundles everything into `dist/index.html` |
| `views/` | EJS templates |
| `public/css/` | Styles. `reset.css` is a stand-in for the original reset |
| `data/patient.js` | Mock patient record, loosely shaped like FHIR resources |
| `data/interactions.js` | Mock conflict rules, matched on active ingredients |
| `data/otc.js` | Over-the-counter medicines offered on "Add a medicine" |

## Not done yet

Connecting to a FHIR server for real data. Keep access tokens out of this repository.
