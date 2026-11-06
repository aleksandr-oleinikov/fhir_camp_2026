// Small hand-written FHIR resources shaped like the test server's, and a
// fake fetch that serves them. No network.

const EPIC = 'erXuFYUfucBZaryVksYEcMg3'; // same ids as data/fhir-config.js
const MEDICARE = '-10000010254618';

const pharmacyClaim = (id, ndc, date, days, quantity) => ({
  resourceType: 'ExplanationOfBenefit',
  id,
  patient: { reference: `Patient/${MEDICARE}` },
  type: { coding: [{ system: 'https://bluebutton.cms.gov/resources/codesystem/eob-type', code: 'PDE' }, { system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'pharmacy' }] },
  billablePeriod: { start: date },
  supportingInfo: [{ category: { coding: [{ code: 'dayssupply' }] }, valueQuantity: { value: days } }],
  item: [{ productOrService: { coding: [{ system: 'http://hl7.org/fhir/sid/ndc', code: ndc }] }, servicedDate: date, quantity: { value: quantity } }],
});

const resources = {
  [EPIC]: {
    patient: { resourceType: 'Patient', id: EPIC, name: [{ use: 'official', given: ['Camila', 'Maria'], family: 'Lopez' }] },
    MedicationRequest: [
      {
        resourceType: 'MedicationRequest',
        id: 'mr1',
        status: 'active',
        medicationReference: { reference: 'Medication/med1', display: 'drospirenone-ethinyl estradiol 3-0.02 MG per tablet' },
        authoredOn: '2019-05-28',
        requester: { display: 'Physician' },
        reasonCode: [{ text: 'Polycystic ovaries' }],
        dosageInstruction: [{ text: 'Take 1 tablet…, Starting Tue 5/28/2019', patientInstruction: 'Take 1 tablet by mouth 1 (one) time each day.' }],
        dispenseRequest: { numberOfRepeatsAllowed: 12, expectedSupplyDuration: { value: 28 } },
      },
      { resourceType: 'Medication', id: 'med1', code: { text: 'drospirenone-ethinyl estradiol 3-0.02 MG per tablet' } },
    ],
    ExplanationOfBenefit: [],
  },
  [MEDICARE]: {
    patient: { resourceType: 'Patient', id: MEDICARE, name: [{ use: 'usual', given: ['Chi716'], family: 'Greenfelder433' }] },
    MedicationRequest: [],
    ExplanationOfBenefit: [
      pharmacyClaim('c1', '58016096302', '2023-11-13', 90, 90), // lisinopril
      pharmacyClaim('c2', '53978100009', '2024-11-18', 90, 90), // Zestril: same medicine, later fill
      pharmacyClaim('c3', '27808011402', '2024-12-18', 10, 40), // hydrocodone and paracetamol
      pharmacyClaim('c4', '68115025030', '2015-03-25', 63, 63), // naproxen, long finished
      pharmacyClaim('c5', '00427080094', '2024-12-01', 90, 90), // unknown code
      { resourceType: 'ExplanationOfBenefit', id: 'c6', type: { coding: [{ code: 'OUTPATIENT' }] }, item: [] },
    ],
  },
};

// A fetch stand-in for the FHIR server. Keeps MedicationStatements it is sent.
function fakeServer() {
  const statements = [];
  const calls = [];
  let nextId = 1;
  const json = (status, body) => ({ ok: status < 400, status, text: async () => (body ? JSON.stringify(body) : '') });
  const bundle = (list) => json(200, { resourceType: 'Bundle', entry: list.map((resource) => ({ resource })) });

  async function fetch(url, opts = {}) {
    const method = opts.method || 'GET';
    const u = new URL(url);
    const path = u.pathname.split('/fhir/')[1].split('/').slice(1); // drop the tenant id
    calls.push(`${method} ${path.join('/')}${u.search}`);
    if (!/^Bearer \S+/.test((opts.headers || {}).Authorization || '')) return json(401);
    const pid = u.searchParams.get('patient');
    const [type, id] = path;
    if (method === 'GET' && type === 'Patient') return resources[id] ? json(200, resources[id].patient) : json(404);
    if (method === 'GET' && type === 'MedicationStatement') {
      const tag = u.searchParams.get('_tag');
      return bundle(statements.filter((s) => s.subject.reference === `Patient/${pid}`
        && (!tag || s.meta.tag.some((t) => `${t.system}|${t.code}` === tag))));
    }
    if (method === 'GET') return bundle((resources[pid] && resources[pid][type]) || []);
    if (method === 'POST' && type === 'MedicationStatement') {
      const created = { ...JSON.parse(opts.body), id: `s${nextId++}` };
      statements.push(created);
      return json(201, created);
    }
    if (method === 'DELETE' && type === 'MedicationStatement') {
      const i = statements.findIndex((s) => s.id === id);
      if (i >= 0) statements.splice(i, 1);
      return json(200, { resourceType: 'OperationOutcome' });
    }
    return json(400);
  }
  return { fetch, statements, calls };
}

module.exports = { EPIC, MEDICARE, resources, fakeServer };
