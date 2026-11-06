// In-browser runtime for the static demo. Uses the same lib/core.js as the
// Express server; templates are precompiled by build.js into ./templates.
// Pages are addressed by hash (#/medicines/m1) so any static host works,
// and demo state is saved in this browser. Medicines are read from, and
// added to, the FHIR server named in data/fhir-config.js.

const { createState, handle } = require('../lib/core');
const templates = require('../build/templates');

const STORAGE_KEY = 'medicines-demo-state-v2';

// ---- State -------------------------------------------------------------
function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) { /* private mode or blocked storage: start fresh */ }
  return createState();
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* not fatal */ }
}

let state = loadState();

// ---- Templates ---------------------------------------------------------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
const escapeFn = (v) => (v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

function resolve(from, rel) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of rel.replace(/\.ejs$/, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function render(name, locals) {
  const fn = templates[name];
  if (!fn) throw new Error(`No template: ${name}`);
  return fn(locals, escapeFn, (rel, data) => render(resolve(name, rel), { ...locals, ...data }));
}

// ---- Routing -----------------------------------------------------------
function currentUrl() {
  const raw = location.hash.replace(/^#/, '') || '/';
  return new URL(raw.startsWith('/') ? raw : '/' + raw, 'http://demo.local');
}

// Render straight away (no wait for hashchange) and add a history entry,
// so the browser Back button still works.
function go(path) {
  if (location.hash !== '#' + path) history.pushState(null, '', '#' + path);
  return show(true);
}

// Requests can wait on the FHIR server; only the latest one gets painted.
let latest = 0;

async function request(method, url, body) {
  const query = Object.fromEntries(url.searchParams);
  const wasLoaded = state.loaded;
  const result = await handle(state, method, url.pathname, query, body);
  if (method === 'POST' || !wasLoaded) saveState();
  return result;
}

function paint(result, moveFocus) {
  const html = render(result.view, { ...result.locals, demo: true });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.title = doc.title;
  document.body.innerHTML = doc.body.innerHTML;
  if (moveFocus) {
    window.scrollTo(0, 0);
    const target = document.querySelector('.error-summary') || document.getElementById('main');
    if (target) target.focus({ preventScroll: true });
  }
}

async function show(moveFocus = true) {
  const ticket = ++latest;
  const result = await request('GET', currentUrl());
  if (ticket !== latest) return;
  if (result.redirect) return location.replace('#' + result.redirect);
  paint(result, moveFocus);
}

// ---- Wire up links and forms -------------------------------------------
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    // In-page links (skip link, error summary) would otherwise change the route.
    e.preventDefault();
    const el = document.getElementById(href.slice(1));
    if (el) {
      if (!el.hasAttribute('tabindex') && !/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(el.tagName)) el.setAttribute('tabindex', '-1');
      el.focus();
      el.scrollIntoView({ block: 'start' });
    }
  } else if (href.startsWith('/') && !href.startsWith('//')) {
    e.preventDefault();
    go(href);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  const action = form.getAttribute('action') || '';
  if (!action.startsWith('/')) return;
  e.preventDefault();
  if (form.getAttribute('aria-busy') === 'true') return; // already sending
  form.setAttribute('aria-busy', 'true');
  const button = form.querySelector('button[type=submit], button:not([type])');
  if (button) { button.disabled = true; button.dataset.label = button.textContent; button.lastChild.textContent = ' Please wait…'; }
  const method = (form.getAttribute('method') || 'get').toUpperCase();
  const body = Object.fromEntries(new FormData(form));
  const ticket = ++latest;
  const result = await request(method, new URL(action, 'http://demo.local'), body);
  if (ticket !== latest) return;
  if (result.redirect) go(result.redirect);
  else paint(result, true); // e.g. a form error, shown without changing the address
});

window.addEventListener('popstate', () => show(true));
window.addEventListener('hashchange', () => show(true)); // address typed or edited by hand
function start() {
  if (!state.loaded) document.body.innerHTML = '<p class="loading" role="status">Loading your record…</p>';
  show(false);
}
if (document.body) start();
else document.addEventListener('DOMContentLoaded', start);
