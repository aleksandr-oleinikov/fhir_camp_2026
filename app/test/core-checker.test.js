// The pages with an interaction checker plugged in, as on the local server:
// conflicts come from the checker, not from the made-up rules. The record
// and the checker here are stand-ins; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { createState, handle, findConflicts } = require('../lib/core');
const { mapRecord, toMedicationStatement, RXNORM } = require('../lib/fhir');
const { statementsFromClaims } = require('../lib/claim-statements');
const { MEDICARE, resources } = require('./fixtures');

const views = path.join(__dirname, '..', 'views');
const practice = { name: "your doctor's surgery", phone: '0113 496 0000' };
const { patient, ExplanationOfBenefit: claims } = resources[MEDICARE];
const NOW = new Date('2026-11-06T10:00:00Z');

// A record store and a checker that knows one interaction: lisinopril with
// naproxen. converted: whether the claims were turned into statements.
function fakeServices({ converted = true, checkFails = false } = {}) {
  const statements = converted ? statementsFromClaims(patient, claims, NOW).statements : [];
  const calls = { check: 0, fullText: 0 };
  let nextId = 1;
  const rxcuiOf = (s) => (s.medicationCodeableConcept.coding || []).filter((c) => c.system === RXNORM).map((c) => c.code)[0];
  const services = {
    loadRecord: async (patientId, today) => mapRecord({ patient, resources: [...claims, ...statements] }, today, practice),
    addMedicine: async (patientId, input) => {
      const saved = { ...toMedicationStatement(input, patientId, NOW), id: `s${nextId++}` };
      statements.push(saved);
      return mapRecord({ patient, resources: [saved] }, NOW, practice).medications[0];
    },
    removeDemoAdditions: async () => {
      const added = statements.filter((s) => /^s\d+$/.test(s.id));
      for (const s of added) statements.splice(statements.indexOf(s), 1);
      return added.length;
    },
    checkInteractions: async () => {
      calls.check += 1;
      if (checkFails) throw new Error('Scholz is down');
      const active = statements.filter((s) => s.status === 'active');
      const medicines = active.filter(rxcuiOf).map((s) => ({ rxcui: rxcuiOf(s), name: s.medicationCodeableConcept.text, drugCode: `Y${rxcuiOf(s)}`, sources: [`MedicationStatement/${s.id}`] }));
      const has = (rxcui) => medicines.some((m) => m.rxcui === rxcui);
      return {
        medicines,
        conflicts: has('314076') && has('849574') ? [{
          interactionCode: '38010552', severity: 2, medicines: ['314076', '849574'],
          effect: 'blood pressure lowering decreased, risk of renal failure', whatToDo: 'only with careful monitoring',
          detectedIssue: 'DetectedIssue/di1',
        }] : [],
        notChecked: active.filter((s) => !rxcuiOf(s)).map((s) => ({ source: `MedicationStatement/${s.id}`, name: s.medicationCodeableConcept.text, reason: 'no RxNorm code' })),
      };
    },
    interactionFullText: async (code) => {
      calls.fullText += 1;
      return { interactionCode: code, mechanism: 'NSAIDs blunt ACE inhibitors.', management: 'Monitor renal function.\nMake sure they drink enough.' };
    },
  };
  return { services, statements, calls };
}

async function page(state, services, method, url, body) {
  const u = new URL(url, 'http://demo.local');
  const result = await handle(state, method, u.pathname, Object.fromEntries(u.searchParams), body, services);
  if (result.view) result.html = await ejs.renderFile(path.join(views, `${result.view}.ejs`), result.locals);
  return result;
}

const signIn = (state, services) => page(state, services, 'POST', '/connect/medicare', { username: 'demo', password: 'x' });
const count = (html, text) => html.split(text).length - 1;

test('each claim medicine is listed once, and is checked', async () => {
  const { services, calls } = fakeServices();
  const s = createState();
  await signIn(s, services);
  const home = await page(s, services, 'GET', '/');

  assert.equal(count(home.html, 'class="med-name"'), 2);
  assert.match(home.html, /Lisinopril/);
  assert.match(home.html, /Hydrocodone and paracetamol/);
  assert.doesNotMatch(home.html, /Bought by you/, 'statements made from claims are not shown as bought by the patient');
  assert.doesNotMatch(home.html, /Not checked|not checked|may not mix well/);
  assert.equal(calls.check, 1, 'checked once on sign-in, not on every page');
  await page(s, services, 'GET', '/');
  assert.equal(calls.check, 1);
});

test('a conflict comes from the checker and shows its text for the pharmacist', async () => {
  const { services, calls } = fakeServices();
  const s = createState();
  await signIn(s, services);
  await page(s, services, 'POST', '/medicines/add', { choice: 'aleve', name: '', reason: 'back pain', dose: '' });
  assert.equal(calls.check, 2, 'checked again after the list changed');

  const conflicts = findConflicts(s);
  assert.deepEqual(conflicts.map((c) => [c.id, c.severity, c.meds.map((m) => m.medication)]), [
    ['38010552-rx-lisinopril-ms-s1', 2, ['Lisinopril', 'Aleve']],
  ]);

  const home = await page(s, services, 'GET', '/');
  assert.match(home.html, /Some of your medicines may not mix well/);
  assert.match(home.html, /Lisinopril and Aleve may not mix well/);

  const opened = await page(s, services, 'GET', `/conflicts/${conflicts[0].id}`);
  assert.match(opened.html, /<h1>Lisinopril and Aleve<\/h1>/);
  assert.match(opened.html, /These 2 medicines interact\. Talk to your doctor or a pharmacist soon\./);
  assert.match(opened.html, /Call 0113 496 0000/);
  assert.match(opened.html, /Ask any pharmacist/);
  assert.match(opened.html, /For your doctor or pharmacist/);
  assert.match(opened.html, /blood pressure lowering decreased, risk of renal failure/);
  assert.match(opened.html, /only with careful monitoring/);
  assert.match(opened.html, /<p>Monitor renal function\.<\/p><p>Make sure they drink enough\.<\/p>/);
  await page(s, services, 'GET', `/conflicts/${conflicts[0].id}`);
  assert.equal(calls.fullText, 1, 'the full text is fetched once');

  for (const m of s.record.medications) assert.ok((await page(s, services, 'GET', `/medicines/${m.id}`)).html);
  assert.match((await page(s, services, 'GET', '/medicines/rx-lisinopril')).html, /May not mix well with <strong>Aleve<\/strong>/);
  assert.ok((await page(s, services, 'GET', `/conflicts/${conflicts[0].id}/more`)).html);
});

test('the made-up rules are not used when there is a checker', async () => {
  const { services } = fakeServices();
  const s = createState();
  await signIn(s, services);
  // The made-up rules would flag paracetamol twice here; this checker does not.
  await page(s, services, 'POST', '/medicines/add', { choice: 'tylenol', name: '', reason: '', dose: '' });
  assert.deepEqual(findConflicts(s), []);
});

test('a medicine the checker could not check is marked, never passed as fine', async () => {
  const { services } = fakeServices();
  const s = createState();
  await signIn(s, services);
  await page(s, services, 'POST', '/medicines/add', { choice: '', name: 'Nurofen', reason: '', dose: '' });
  const home = await page(s, services, 'GET', '/');
  assert.match(home.html, /1 medicine was not checked/);
  assert.match(home.html, /We could not check Nurofen against your other medicines/);
  assert.equal(count(home.html, 'Not checked for conflicts'), 1);
});

test('claims that were never turned into statements are all marked not checked', async () => {
  const { services } = fakeServices({ converted: false });
  const s = createState();
  await signIn(s, services);
  const home = await page(s, services, 'GET', '/');
  assert.match(home.html, /2 medicines were not checked/);
  assert.match(home.html, /We could not check Hydrocodone and paracetamol and Lisinopril against/);
});

test('a failed check is said plainly, and is not shown as no conflicts', async () => {
  const { services } = fakeServices({ checkFails: true });
  const s = createState();
  await signIn(s, services);
  const home = await page(s, services, 'GET', '/');
  assert.match(home.html, /We could not check your medicines/);
  assert.match(home.html, /This does not mean they are safe to take together/);
  assert.match(home.html, /Lisinopril/, 'the list is still shown');
  assert.deepEqual(findConflicts(s), []);
});

test('a conflict for a medicine that is not on the list is still shown', async () => {
  const { services } = fakeServices();
  const s = createState();
  await signIn(s, services);
  s.check.medicines.push({ rxcui: '849574', name: 'naproxen sodium 220 MG Oral Tablet', drugCode: 'Y1', sources: ['MedicationStatement/someone-elses-session'] });
  s.check.conflicts.push({ interactionCode: '38010552', severity: 2, medicines: ['314076', '849574'], effect: 'x', whatToDo: 'y' });
  const home = await page(s, services, 'GET', '/');
  assert.match(home.html, /Lisinopril and naproxen sodium 220 MG Oral Tablet may not mix well/);
  assert.ok((await page(s, services, 'GET', `/conflicts/${findConflicts(s)[0].id}`)).html);
});

test('reset removes what was added and checks once more, so old warnings are withdrawn', async () => {
  const { services, statements, calls } = fakeServices();
  const s = createState();
  await signIn(s, services);
  await page(s, services, 'POST', '/medicines/add', { choice: 'aleve', name: '', reason: '', dose: '' });
  const before = calls.check;
  assert.deepEqual(await page(s, services, 'POST', '/demo/reset'), { redirect: '/connect?reset=1' });
  assert.equal(statements.some((x) => /^s\d+$/.test(x.id)), false);
  assert.equal(calls.check, before + 1);
  assert.equal(s.source, null);
});
