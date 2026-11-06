// Prepares a Medicare patient in Aidbox for the drug interaction check: reads
// their pharmacy claims and saves one MedicationStatement per medicine, with
// its RxNorm code. Safe to run again: each statement has a fixed id.
//
//   node --env-file=.env scripts/claims-to-statements.js <patientId>          shows what it would save
//   node --env-file=.env scripts/claims-to-statements.js <patientId> --write  saves it
//
// Needs AIDBOX_URL, AIDBOX_CLIENT_ID and AIDBOX_CLIENT_SECRET.

const ddi = require('../lib/ddi');
const { statementsFromClaims } = require('../lib/claim-statements');

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const patientId = args.find((a) => a !== '--write');
  if (!patientId) throw new Error('Usage: claims-to-statements.js <patientId> [--write]');

  const config = ddi.configFromEnv();
  const missing = ['AIDBOX_URL', 'AIDBOX_CLIENT_ID', 'AIDBOX_CLIENT_SECRET'].filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Not configured: set ${missing.join(', ')}`);
  const aidbox = ddi.aidboxClient(config);

  const patient = await aidbox.call('GET', `fhir/Patient/${encodeURIComponent(patientId)}`);
  const search = { patient: `Patient/${patientId}` };
  const pages = await aidbox.searchAll(`fhir/ExplanationOfBenefit?${new URLSearchParams({ ...search, _sort: '_id', _count: '100' })}`);
  const claims = [...new Map(pages.map((c) => [c.id, c])).values()];
  // Paging can repeat or drop rows. Every claim must be here before any is trusted.
  const { total } = await aidbox.call('GET', `fhir/ExplanationOfBenefit?${new URLSearchParams({ ...search, _summary: 'count' })}`);
  if (claims.length !== total) throw new Error(`Read ${claims.length} claims but Aidbox has ${total}`);

  const { statements, unknownNdc } = statementsFromClaims(patient, claims);
  console.log(`${claims.length} claims for Patient/${patientId}, ${statements.length} medicines:`);
  for (const s of statements) {
    const period = `${s.effectivePeriod.start} to ${s.effectivePeriod.end || 'now'}`;
    console.log(`  ${s.status.padEnd(9)} ${s.medicationCodeableConcept.coding[0].code.padEnd(8)} ${s.medicationCodeableConcept.text}  (${period})`);
    console.log(`            ${s.note[0].text}`);
  }
  if (unknownNdc.length) console.log(`Left out, NDC code not in data/drug-codes.js: ${unknownNdc.join(', ')}`);

  if (!write) {
    console.log('Nothing saved. Add --write to save these to Aidbox.');
    return;
  }
  for (const s of statements) await aidbox.call('PUT', `fhir/MedicationStatement/${encodeURIComponent(s.id)}`, s);
  console.log(`Saved ${statements.length} MedicationStatements.`);
}

main().catch((e) => {
  console.error(ddi.maskSecrets(ddi.configFromEnv(), e.message));
  process.exit(1);
});
