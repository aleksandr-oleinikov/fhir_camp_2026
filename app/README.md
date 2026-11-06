# Patient medicines demo

A mobile-first web app for patients. It lists their medicines, groups any pairs that may not mix well with a 1 to 3 "!" severity, and lets them add medicines they buy over the counter.

It opens on "Connect to payer". Epic and Blue Button CMS lead to a fake sign-in (any username and password) and then load a synthetic patient's medicines from a FHIR test server. The other payer buttons do nothing. Medicines the patient adds are written back to that server as `MedicationStatement`s, and "Reset the demo" deletes them again.

The conflict wording and severity levels are placeholders and have not been clinically reviewed.

It runs in two ways, from the same page logic:

| | Local server, with `.env` | Static demo (GitHub Pages), or local server without `.env` |
| --- | --- | --- |
| Patient record | Aidbox | The shared FHIR test server in `data/fhir-config.js` |
| Conflicts | Scholz DataBank, through the drug interaction check | The made-up rules in `data/interactions.js` |

## Run it

Needs Node.js 20.12 or later.

```
cd app
npm install
npm run dev          # http://localhost:3000, restarts on changes
npm test             # runs against fake servers, no network
```

To use Aidbox and Scholz DataBank, copy `.env.example` to `.env` and fill it in. The server reads it when it starts, and says which of the two ways it is running. `AIDBOX_CLIENT_ID` and `AIDBOX_CLIENT_SECRET` belong to an Aidbox Client with the `client_credentials` grant.

With the check on:

- Medicines are checked when the patient signs in, adds a medicine, taps "Update my list" or resets the demo, not on every page.
- A medicine the check could not cover is marked "Not checked for conflicts": a typed name, which has no code, or a claim medicine that was never turned into a `MedicationStatement` (see below).
- If the check fails, the home screen says so. It never shows a failed check as "no conflicts".
- An opened warning shows Scholz's own text under "For your doctor or pharmacist". It is written for health professionals and is shown as it comes.

## Drug interaction API

The dev server also answers two JSON routes, specified in [`../docs/ddi-backend.md`](../docs/ddi-backend.md). They read the patient's active `MedicationRequest`s and `MedicationStatement`s from Aidbox, check them in Scholz DataBank and save each pair found as a `DetectedIssue`.

| Route | Returns |
| --- | --- |
| `GET /patients/{id}/interactions` | `medicines`, `conflicts` (severity 3 Serious, 2 Moderate, 1 Minor) and `notChecked` |
| `GET /patients/{id}/interactions/{interactionCode}` | `mechanism` and `management` text for one interaction |

The pages use the same check, in process; the routes are there for other callers. They need the settings in `.env`.

The check only sees medicines that are `MedicationRequest`s or `MedicationStatement`s with an RxNorm code. A Medicare patient has pharmacy claims instead, so turn them into `MedicationStatement`s once per patient:

```
node --env-file=.env scripts/claims-to-statements.js <patientId>           # shows what it would save
node --env-file=.env scripts/claims-to-statements.js <patientId> --write   # saves it
```

It marks a medicine `active` when the medicines screen would show it as current, and `completed` otherwise. Medicines picked on "Add a medicine" are saved with an RxNorm code; a typed name has none and is reported as not checked.

Without the settings the routes answer `503`. A Scholz or Aidbox failure is a `502`, never an empty list. The routes have no sign-in of their own.

## Build the static demo

```
npm run build:demo   # writes dist/index.html
```

`dist/index.html` is one self-contained file. It runs in the browser and talks to the shared FHIR test server directly, so it works from any static host (GitHub Pages, Cloudflare Pages) or opened straight from disk. It uses the made-up conflict rules: it cannot use Aidbox or Scholz DataBank, because their secrets must not be in a public page. The footer has a "Reset the demo and sign out" button.

## How it fits together

| Path | What it does |
| --- | --- |
| `lib/core.js` | All page logic: routes, view models, conflicts. Shared by the server and the static build. Where the record and the conflicts come from is passed in |
| `lib/fhir.js` | Reads medicines from FHIR (Epic `MedicationRequest`, Medicare `ExplanationOfBenefit` pharmacy claims), shifts their dates to now, writes back `MedicationStatement`s |
| `lib/ddi.js` | Drug interaction checks through Aidbox and Scholz DataBank. Server only: never bundled into the static build |
| `lib/aidbox-services.js` | Gives the pages the record from Aidbox and the check from `lib/ddi.js`. Server only |
| `lib/claim-statements.js` | Turns Medicare pharmacy claims into `MedicationStatement`s with RxNorm codes, for the check |
| `scripts/claims-to-statements.js` | Runs that conversion for one patient in Aidbox |
| `server.js` | Express dev server around `lib/core.js`, plus the two drug interaction routes. Reads `.env` |
| `client/main.js` | In-browser runtime for the static build: hash links, form handling, saved state |
| `build.js` | Precompiles the EJS templates and bundles everything into `dist/index.html` |
| `views/` | EJS templates |
| `public/css/` | Styles. `reset.css` is a stand-in for the original reset |
| `data/fhir-config.js` | FHIR server, **token (committed on purpose, demo-only server)**, payer buttons, fallback practice phone |
| `data/drug-codes.js` | Names and ingredients for the NDC codes on the Medicare claims |
| `data/patient.js` | Made-up patient record. Appointments and test results still come from here |
| `data/interactions.js` | Mock conflict rules, matched on active ingredients. Used when there is no check |
| `data/otc.js` | Over-the-counter medicines offered on "Add a medicine", each with an RxNorm code for one common strength |
| `data/scholz-combi-status.js` | Full "what to do" wording per Scholz `CombiStatus` code. One entry so far; the rest come from the Scholz manual |
| `.env.example` | The settings for Aidbox and Scholz DataBank |

## Not done yet

- Appointments and test results pages still exist on made-up data, but nothing links to them: the demo is medicines only.
- The static demo still uses the made-up rules; only the local server with `.env` checks medicines in Scholz DataBank.
- With the check on, the patient wording for a conflict is one sentence per severity level. What is specific to the pair is Scholz's text for health professionals.
- Signing in with the check on reads every claim from Aidbox and takes about 5 seconds for the Medicare patient.
- `data/scholz-combi-status.js` has the full "what to do" wording for one Scholz code only. The others show Scholz's text cut at 50 characters.
- Diagnoses (`Condition`, claim diagnoses) are not shown yet. See `docs/fhir-findings.md`.
- The token in `data/fhir-config.js` is only acceptable because the server is a throwaway test server. Never do this with a real one.
