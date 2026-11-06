// In-browser runtime for the static demo. Uses the same app/core.js as the
// Express server; templates are precompiled by build.js into ./templates.
// Pages are addressed by hash (#/medicines/m1) so any static host works,
// and demo changes are saved in this browser only.

const { createState, handle } = require('../app/core');
const templates = require('../build/templates');

const STORAGE_KEY = 'medicines-demo-state-v1';

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
  show(true);
}

function request(method, url, body) {
  if (method === 'POST' && url.pathname === '/demo/reset') {
    state = createState();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    return { redirect: '/?reset=1' };
  }
  const query = Object.fromEntries(url.searchParams);
  const result = handle(state, method, url.pathname, query, body);
  if (method === 'POST') saveState();
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

function show(moveFocus = true) {
  const result = request('GET', currentUrl());
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

document.addEventListener('submit', (e) => {
  const form = e.target;
  const action = form.getAttribute('action') || '';
  if (!action.startsWith('/')) return;
  e.preventDefault();
  const method = (form.getAttribute('method') || 'get').toUpperCase();
  const body = Object.fromEntries(new FormData(form));
  const result = request(method, new URL(action, 'http://demo.local'), body);
  if (result.redirect) go(result.redirect);
  else paint(result, true); // e.g. a form error, shown without changing the address
});

window.addEventListener('popstate', () => show(true));
window.addEventListener('hashchange', () => show(true)); // address typed or edited by hand
if (document.body) show(false);
else document.addEventListener('DOMContentLoaded', () => show(false));
