const test = require('node:test');
const assert = require('node:assert/strict');
const { mapRecord, toMedicationStatement, DEMO_TAG } = require('../lib/fhir');
const { EPIC, MEDICARE, resources } = require('./fixtures');

const TODAY = new Date('2026-11-06T09:00:00');
const practice = { name: "your doctor's surgery", phone: '0113 496 0000' };
const map = (id) => {
  const r = resources[id];
  return mapRecord({ patient: r.patient, resources: [...r.MedicationRequest, ...r.ExplanationOfBenefit] }, TODAY, practice);
};

test('Epic MedicationRequest becomes a medicine with plain fields', () => {
  const { patient, medications } = map(EPIC);
  assert.equal(patient.name[0].given[0], 'Camila');
  assert.equal(medications.length, 1);
  const m = medications[0];
  assert.equal(m.medication, 'Drospirenone-ethinyl estradiol');
  assert.equal(m.strength, '3-0.02 mg per tablet');
  assert.deepEqual(m.ingredients, ['drospirenone', 'ethinyl estradiol']);
  assert.equal(m.reason, 'For polycystic ovaries');
  assert.equal(m.requester, null, '"Physician" is not a name worth showing');
  assert.equal(m.requesterPhone, practice.phone);
  assert.equal(m.dosageInstruction, 'Take 1 tablet by mouth 1 (one) time each day.');
  // Written 2019-05-28, shifted to 3 weeks before today; 28 days' supply.
  assert.deepEqual(m.repeat, { nextDue: '2026-11-13', remaining: 12 });
});

test('Medicare pharmacy claims become current medicines, one per drug', () => {
  const { patient, medications } = map(MEDICARE);
  assert.equal(patient.name[0].given[0], 'Chi', 'digits stripped from synthetic names');
  assert.deepEqual(medications.map((m) => m.medication).sort(), ['Hydrocodone and paracetamol', 'Lisinopril']);

  const lisinopril = medications.find((m) => m.medication === 'Lisinopril');
  // Latest fill anywhere (2024-12-18) lands on 2026-10-16, so 2024-11-18 lands on 2026-09-16.
  assert.equal(lisinopril.lastSupply.date, '2026-09-16', 'uses the latest fill, including the Zestril-branded one');
  assert.deepEqual(lisinopril.repeat, { nextDue: '2026-12-15', remaining: null });

  const hydrocodone = medications.find((m) => m.medication === 'Hydrocodone and paracetamol');
  assert.deepEqual(hydrocodone.ingredients, ['hydrocodone', 'paracetamol']);
  assert.equal(hydrocodone.repeat, undefined, 'supply ran out before today, so no repeat due');
});

test('MedicationStatement written back is tagged and readable again', () => {
  const s = toMedicationStatement({ name: 'Advil', reason: 'back pain', dose: '' }, MEDICARE, new Date('2026-11-06T10:00:00Z'));
  assert.deepEqual(s.meta.tag, [DEMO_TAG]);
  assert.deepEqual(s.medicationCodeableConcept, {
    coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '310965', display: 'ibuprofen 200 MG Oral Tablet' }],
    text: 'Advil',
  }, 'a medicine from the list is saved with its RxNorm code');
  assert.deepEqual(toMedicationStatement({ name: 'Nurofen' }, MEDICARE, new Date()).medicationCodeableConcept, { text: 'Nurofen' }, 'a typed name has no code');
  assert.equal(s.subject.reference, `Patient/${MEDICARE}`);
  assert.equal(s.dosage, undefined, 'empty answers are left out');

  const { medications } = mapRecord({ patient: resources[MEDICARE].patient, resources: [{ ...s, id: 'x1' }] }, TODAY, practice);
  assert.equal(medications[0].id, 'ms-x1');
  assert.equal(medications[0].source, 'patient');
  assert.deepEqual(medications[0].ingredients, ['ibuprofen'], 'ingredients come from the over-the-counter list');
  assert.equal(medications[0].reason, 'For back pain');
  assert.equal(medications[0].addedOn, '2026-11-06');
});
