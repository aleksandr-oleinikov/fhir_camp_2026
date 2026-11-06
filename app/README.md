# Patient medicines demo

A mobile-first web app for patients. It lists their medicines, groups any pairs that may not mix well with a 1 to 3 "!" severity, and lets them add medicines they buy over the counter.

It opens on "Connect to data source". Epic and Blue Button CMS lead to a fake sign-in (any username and password) and then load a synthetic patient's medicines from a FHIR test server. The other payer buttons do nothing. Medicines the patient adds are written back to that server as `MedicationStatement`s, and "Reset the demo" deletes them again.

The conflict wording and severity levels are placeholders and have not been clinically reviewed.

## Run it

Needs Node.js 20 or later.

```
cd app
npm install
npm run dev          # http://localhost:3000, restarts on changes
npm test             # runs against a fake FHIR server, no network
```

## Build the static demo

```
npm run build:demo   # writes dist/index.html
```

`dist/index.html` is one self-contained file. It runs in the browser and talks to the FHIR server directly, so it works from any static host (GitHub Pages, Cloudflare Pages) or opened straight from disk. The footer has a "Reset the demo and sign out" button.

## How it fits together

| Path | What it does |
| --- | --- |
| `lib/core.js` | All page logic: routes, view models, conflict checking. Shared by the server and the static build |
| `lib/fhir.js` | Reads medicines from FHIR (Epic `MedicationRequest`, Medicare `ExplanationOfBenefit` pharmacy claims), shifts their dates to now, writes back `MedicationStatement`s |
| `server.js` | Express dev server around `lib/core.js` |
| `client/main.js` | In-browser runtime for the static build: hash links, form handling, saved state |
| `build.js` | Precompiles the EJS templates and bundles everything into `dist/index.html` |
| `views/` | EJS templates |
| `public/css/` | Styles. `reset.css` is a stand-in for the original reset |
| `data/fhir-config.js` | FHIR server, **token (committed on purpose, demo-only server)**, payer buttons, fallback practice phone |
| `data/drug-codes.js` | Names and ingredients for the NDC codes on the Medicare claims |
| `data/patient.js` | Made-up patient record. Appointments and test results still come from here |
| `data/interactions.js` | Mock conflict rules, matched on active ingredients |
| `data/otc.js` | Over-the-counter medicines offered on "Add a medicine" |

## Not done yet

- Appointments and test results pages still exist on made-up data, but nothing links to them: the demo is medicines only.
- Diagnoses (`Condition`, claim diagnoses) are not shown yet. See `docs/fhir-findings.md`.
- The token in `data/fhir-config.js` is only acceptable because the server is a throwaway test server. Never do this with a real one.
