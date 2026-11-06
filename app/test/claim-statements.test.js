const test = require('node:test');
const assert = require('node:assert/strict');
const { statementsFromClaims, CLAIMS_TAG } = require('../lib/claim-statements');
const { mapRecord } = require('../lib/fhir');
const { MEDICARE, resources } = require('./fixtures');

const NOW = new Date('2026-11-06T10:00:00Z');
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const { patient, ExplanationOfBenefit: claims } = resources[MEDICARE];

test('pharmacy claims become one MedicationStatement per medicine, with its RxNorm code', () => {
  const { statements, unknownNdc } = statementsFromClaims(patient, claims, NOW);
  assert.deepEqual(statements.map((s) => [s.id, s.status]), [
    [`claims-hydrocodone-paracetamol-${MEDICARE}`, 'active'],
    [`claims-lisinopril-${MEDICARE}`, 'active'],
    [`claims-naproxen-${MEDICARE}`, 'completed'],
  ]);
  assert.deepEqual(unknownNdc, ['00427080094'], 'a code that is not in the table is reported, not guessed');

  assert.deepEqual(statements[1], {
    resourceType: 'MedicationStatement',
    id: `claims-lisinopril-${MEDICARE}`,
    meta: { tag: [CLAIMS_TAG] },
    status: 'active',
    medicationCodeableConcept: { coding: [{ system: RXNORM, code: '314076', display: 'lisinopril 10 MG Oral Tablet' }], text: 'lisinopril 10 MG Oral Tablet' },
    subject: { reference: `Patient/${MEDICARE}` },
    effectivePeriod: { start: '2023-11-13' },
    dateAsserted: '2026-11-06T10:00:00.000Z',
    derivedFrom: [{ reference: 'ExplanationOfBenefit/c2' }],
    note: [{ text: 'Derived from 2 Medicare pharmacy claims. Last supplied 2024-11-18: 90 tablets for 90 days.' }],
  });

  const naproxen = statements[2];
  assert.deepEqual(naproxen.effectivePeriod, { start: '2015-03-25', end: '2015-05-27' }, 'a finished course ends when its supply ran out');
  assert.equal(naproxen.note[0].text, 'Derived from 1 Medicare pharmacy claim. Last supplied 2015-03-25: 63 tablets for 63 days.');
});

test('the active statements are the medicines the medicines screen shows as current', () => {
  const { statements } = statementsFromClaims(patient, claims, NOW);
  const onScreen = mapRecord({ patient, resources: claims }, NOW, {}).medications.map((m) => m.id.replace(/^rx-/, '')).sort();
  const active = statements.filter((s) => s.status === 'active').map((s) => s.id.replace(/^claims-/, '').replace(`-${MEDICARE}`, '')).sort();
  assert.deepEqual(active, onScreen);
});

test('on the medicines screen a statement made from claims is folded into its claim medicine', () => {
  const practice = { phone: '0113 496 0000' };
  const { statements } = statementsFromClaims(patient, claims, NOW);
  const { medications } = mapRecord({ patient, resources: [...claims, ...statements] }, NOW, practice);
  assert.deepEqual(medications.map((m) => [m.id, m.refs]), [
    ['rx-lisinopril', [`MedicationStatement/claims-lisinopril-${MEDICARE}`]],
    ['rx-hydrocodone-paracetamol', [`MedicationStatement/claims-hydrocodone-paracetamol-${MEDICARE}`]],
  ], 'listed once, and it knows which statement stands for it');

  // Without its claim, the statement is listed on its own, as a medicine from the record.
  const alone = mapRecord({ patient, resources: [statements[1]] }, NOW, practice).medications;
  assert.deepEqual(alone.map((m) => [m.id, m.medication, m.source, m.requesterPhone]), [
    [`ms-claims-lisinopril-${MEDICARE}`, 'lisinopril 10 MG Oral Tablet', 'record', '0113 496 0000'],
  ]);
});

test('no pharmacy claims, no statements', () => {
  assert.deepEqual(statementsFromClaims(patient, [{ resourceType: 'ExplanationOfBenefit', id: 'x', type: { coding: [{ code: 'OUTPATIENT' }] }, item: [] }], NOW), { statements: [], unknownNdc: [] });
});
