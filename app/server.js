// Express dev server. All page logic lives in lib/core.js, shared with the
// static demo build (npm run build:demo).
const path = require('node:path');
const express = require('express');
const { createState, handle } = require('./lib/core');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

// In-memory state for this server run only.
const state = createState();

app.all('/{*path}', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'POST') return next();
  const result = handle(state, req.method, req.path, req.query, req.body || {});
  if (result.redirect) {
    return res.redirect(req.method === 'POST' ? 303 : 301, result.redirect);
  }
  res.status(result.status || 200).render(result.view, result.locals);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running at http://localhost:${port}`));
