// Express dev server. All page logic lives in lib/core.js, shared with the
// static demo build (npm run build:demo).
const path = require('node:path');
const express = require('express');
// Settings for Aidbox and Scholz DataBank, if there is a .env next to this
// file. Values already in the environment win. Needs Node 20.12 or later;
// older versions carry on without it.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) { /* no .env: the demo runs on the shared test server */ }

const { createState, handle } = require('./lib/core');
const ddi = require('./lib/ddi');
const aidboxServices = require('./lib/aidbox-services');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

// Drug interaction checks, as JSON. Spec: ../docs/ddi-backend.md.
// These must stay above the page routes, which answer every other path.
const api = (work) => async (req, res) => {
  const config = ddi.configFromEnv();
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await work(config, req.params));
  } catch (e) {
    const known = e instanceof ddi.DdiError;
    const status = known ? e.status : 500;
    console.error(`${req.method} ${req.path} -> ${status}: ${ddi.maskSecrets(config, known ? e.message : e.stack)}`);
    res.status(status).json({ error: known ? e.message : 'Something went wrong' });
  }
};
app.get('/patients/:id/interactions', api((config, p) => ddi.checkInteractions(config, p.id)));
app.get('/patients/:id/interactions/:interactionCode', api((config, p) => ddi.interactionFullText(config, p.interactionCode)));

// In-memory state for this server run only.
const state = createState();

// With the settings, the pages read Aidbox and check medicines in Scholz
// DataBank. Without them they behave like the static demo.
const services = aidboxServices.fromEnv() || undefined;

app.all('/{*path}', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'POST') return next();
  const result = await handle(state, req.method, req.path, req.query, req.body || {}, services);
  if (result.redirect) {
    return res.redirect(req.method === 'POST' ? 303 : 302, result.redirect);
  }
  res.status(result.status || 200).render(result.view, result.locals);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Running at http://localhost:${port}`);
  console.log(services
    ? 'Medicines come from Aidbox and are checked in Scholz DataBank.'
    : 'No Aidbox and Scholz settings (.env): using the shared test server and the made-up conflict rules.');
});
