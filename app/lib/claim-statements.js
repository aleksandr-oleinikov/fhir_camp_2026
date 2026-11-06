// Turns Medicare pharmacy claims into MedicationStatements with RxNorm codes:
// the shape the drug interaction check (lib/ddi.js) reads. One statement per
// medicine, built from all of its claims.
//
// A claim says what was supplied and when, not whether the patient still
// takes it. "Still taking it" is decided exactly as the medicines screen
// decides it (mapRecord in lib/fhir.js): the record's dates are treated as if
// the latest fill were three weeks ago, and a medicine is current if its last
// supply ran out within 90 days of today. The dates written to the statement
// are the real claim dates.

const { drugs } = require('../data/drug-codes');
// CLAIMS_TAG marks what this conversion wrote, so it can be found and removed.
// It is not the tag "Reset the demo" deletes.
const { mapRecord, pharmacyItems, RXNORM, CLAIMS_TAG } = require('./fhir');

const DAY = 86400000;
const day = (iso) => iso.slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${day(iso)}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// patient: a FHIR Patient. claims: that patient's ExplanationOfBenefits.
// Returns the statements, and the NDC codes that are not in
// data/drug-codes.js and so could not be turned into anything.
function statementsFromClaims(patient, claims, now = new Date()) {
  const items = pharmacyItems(claims).filter((i) => i.filled);
  const current = new Set(
    mapRecord({ patient, resources: claims }, now, {}).medications.map((m) => m.id.replace(/^rx-/, '')),
  );

  const byDrug = new Map();
  for (const item of items.filter((i) => i.key)) byDrug.set(item.key, [...(byDrug.get(item.key) || []), item]);

  const statements = [...byDrug].map(([key, fills]) => {
    fills.sort((a, b) => a.filled.localeCompare(b.filled));
    const first = fills[0];
    const last = fills[fills.length - 1];
    const drug = drugs[key];
    const active = current.has(key);
    const id = `claims-${key}-${patient.id}`;
    if (!/^[A-Za-z0-9\-.]{1,64}$/.test(id)) throw new Error(`Cannot make a FHIR id from "${id}"`);
    return {
      resourceType: 'MedicationStatement',
      id,
      meta: { tag: [CLAIMS_TAG] },
      status: active ? 'active' : 'completed',
      medicationCodeableConcept: { coding: [{ system: RXNORM, code: drug.rxcui, display: drug.rxnorm }], text: drug.rxnorm },
      subject: { reference: `Patient/${patient.id}` },
      effectivePeriod: { start: day(first.filled), ...(!active && { end: addDays(last.filled, last.days) }) },
      dateAsserted: now.toISOString(),
      derivedFrom: [{ reference: `ExplanationOfBenefit/${last.claimId}` }],
      note: [{
        text: `Derived from ${fills.length} Medicare pharmacy claim${fills.length === 1 ? '' : 's'}. `
          + `Last supplied ${day(last.filled)}${last.quantity ? `: ${last.quantity} ${drug.unit}` : ''} for ${last.days} days.`,
      }],
    };
  });

  return {
    statements: statements.sort((a, b) => a.id.localeCompare(b.id)),
    unknownNdc: [...new Set(items.filter((i) => !i.key).map((i) => i.ndc))].sort(),
  };
}

module.exports = { statementsFromClaims, CLAIMS_TAG };
