// Walks the demo through its pages against a fake FHIR server, and renders
// every page with the real templates to catch template errors.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { createState, handle, findConflicts } = require('../lib/core');
const { fakeServer, MEDICARE } = require('./fixtures');

const views = path.join(__dirname, '..', 'views');
const render = (result) => ejs.renderFile(path.join(views, `${result.view}.ejs`), result.locals);

async function page(state, method, url, body) {
  const u = new URL(url, 'http://demo.local');
  const result = await handle(state, method, u.pathname, Object.fromEntries(u.searchParams), body);
  if (result.view) result.html = await render(result);
  return result;
}

let server;
test.beforeEach(() => {
  server = fakeServer();
  global.fetch = server.fetch;
});

test('starts on Connect to payer, and only Epic and Medicare lead anywhere', async () => {
  const s = createState();
  assert.deepEqual(await page(s, 'GET', '/'), { redirect: '/connect' });
  const landing = await page(s, 'GET', '/connect');
  assert.match(landing.html, /Connect to payer/);
  assert.equal((landing.html.match(/aria-disabled="true"/g) || []).length, 5);
  assert.equal((await page(s, 'GET', '/connect/aetna')).status, 404);
  assert.match((await page(s, 'GET', '/connect/medicare')).html, /Sign in to Blue Button CMS/);
});

test('sign-in needs a username and password, then loads the record', async () => {
  const s = createState();
  const bad = await page(s, 'POST', '/connect/medicare', { username: ' ', password: '' });
  assert.equal(bad.status, 400);
  assert.match(bad.html, /Enter your username[\s\S]*Enter your password/);
  assert.equal(s.source, null);

  assert.deepEqual(await page(s, 'POST', '/connect/medicare', { username: 'demo', password: 'x' }), { redirect: '/' });
  assert.equal(s.source, MEDICARE);
  const home = await page(s, 'GET', '/');
  assert.match(home.html, /Hi Chi!/);
  assert.match(home.html, /Lisinopril/);
  assert.match(home.html, /Last collected/);
  assert.doesNotMatch(home.html, /Atorvastatin/, 'made-up medicines are gone');
});

test('adding a medicine writes it to FHIR and checks it for conflicts', async () => {
  const s = createState();
  await page(s, 'POST', '/connect/medicare', { username: 'demo', password: 'x' });

  const added = await page(s, 'POST', '/medicines/add', { choice: 'advil', name: '', reason: 'back pain', dose: '' });
  assert.deepEqual(added, { redirect: '/?added=ms-s1' });
  assert.equal(server.statements.length, 1);
  assert.equal(server.statements[0].medicationCodeableConcept.text, 'Advil');
  assert.equal(server.statements[0].subject.reference, `Patient/${MEDICARE}`);

  await page(s, 'POST', '/medicines/add', { choice: 'tylenol', name: '', reason: '', dose: '' });
  const ids = findConflicts(s).map((c) => c.id.split('-').slice(0, 2).join('-'));
  assert.deepEqual(ids.sort(), ['lisinopril-ibuprofen', 'paracetamol-paracetamol']);

  const home = await page(s, 'GET', '/?added=ms-s2');
  assert.match(home.html, /Tylenol has been added/);
  assert.match(home.html, /2 pairs of your medicines may not mix well/);
  for (const c of findConflicts(s)) assert.match((await page(s, 'GET', `/conflicts/${c.id}`)).html, /Call 0113 496 0000/);
  for (const m of s.record.medications) assert.ok((await page(s, 'GET', `/medicines/${m.id}`)).html);

  // Update re-reads FHIR; what was added is still there.
  assert.deepEqual(await page(s, 'POST', '/medicines/update'), { redirect: '/?updated=none' });
  assert.equal(s.record.medications.filter((m) => m.source === 'patient').length, 2);
});

test('reset deletes what the demo added and signs out', async () => {
  const s = createState();
  await page(s, 'POST', '/connect/medicare', { username: 'demo', password: 'x' });
  await page(s, 'POST', '/medicines/add', { choice: 'advil', name: '', reason: '', dose: '' });
  assert.deepEqual(await page(s, 'POST', '/demo/reset'), { redirect: '/connect?reset=1' });
  assert.equal(server.statements.length, 0);
  assert.equal(s.source, null);
  assert.ok(server.calls.some((c) => c.startsWith('GET MedicationStatement?') && c.includes('_tag=')), 'only tagged ones are looked up');
});

test('a FHIR failure is shown, not thrown', async () => {
  const s = createState();
  await page(s, 'POST', '/connect/epic', { username: 'demo', password: 'x' });
  global.fetch = async () => { throw new Error('offline'); };
  const failed = await page(s, 'POST', '/medicines/add', { choice: 'advil', name: '', reason: '', dose: '' });
  assert.equal(failed.status, 502);
  assert.match(failed.html, /could not save this to your record/);
  await page(s, 'POST', '/medicines/update');
  assert.match((await page(s, 'GET', '/')).html, /We could not reach your record/);
});

test('made-up record still works, and paracetamol twice is one conflict', async () => {
  const s = createState('mock');
  await page(s, 'POST', '/medicines/add', { choice: 'tylenol', name: '', reason: '', dose: '' });
  assert.equal(findConflicts(s).filter((c) => c.id.startsWith('paracetamol-paracetamol')).length, 1);
  assert.equal(global.fetch, server.fetch);
  assert.equal(server.calls.length, 0, 'no FHIR calls in made-up mode');
  for (const url of ['/', '/appointments', '/appointments/a1', '/results', '/results/o1', '/medicines/add', '/nope']) {
    assert.ok((await page(s, 'GET', url)).html, url);
  }
});
