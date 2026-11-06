// Reads a patient's medicines from the FHIR server and writes back the ones
// they add. Shared by the server and the static build: the only outside API
// used is fetch, which Node 20+ and browsers both have.
//
// Two record shapes are supported:
//   Epic:     MedicationRequest (+ Medication)
//   Medicare: ExplanationOfBenefit pharmacy claims (CARIN Blue Button)
// plus MedicationStatement for anything the patient adds.

const otc = require('../data/otc');
const { drugs, ndc } = require('../data/drug-codes');

// Every resource the demo writes carries this tag, so a reset can find and
// delete them without touching the original data.
const DEMO_TAG = { system: 'urn:fhir-camp-demo', code: 'added-by-patient' };
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

// MedicationStatements made from pharmacy claims (lib/claim-statements.js)
// carry this tag. They are the claim medicines again, in the shape the drug
// interaction check reads, so they are not listed a second time.
const CLAIMS_TAG = { system: 'urn:fhir-camp-demo', code: 'derived-from-claims' };
const hasTag = (r, tag) => ((r.meta && r.meta.tag) || []).some((t) => t.system === tag.system && t.code === tag.code);

// Record dates are years old. They are shifted so the latest one lands this
// many days before "today", and claims count as current if their supply ran
// out within the window below.
const LATEST_EVENT_DAYS_AGO = 21;
const CURRENT_WINDOW_DAYS = 90;

class FhirError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---- Server access -----------------------------------------------------
// config.client, when given, is used instead of the bearer-token access
// below. The local server passes one that talks to Aidbox.
function connect(config) {
  if (config.client) return config.client;
  const base = config.baseUrl.replace(/\/$/, '');
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/fhir+json',
          ...(body && { 'Content-Type': 'application/fhir+json' }),
        },
        body: body && JSON.stringify(body),
      });
    } catch (e) {
      throw new FhirError(`Could not reach the FHIR server (${e.message})`, 0);
    }
    if (!res.ok) throw new FhirError(`${method} ${path.split('?')[0]} returned ${res.status}`, res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  // The server's "next page" links reject the token, so ask for one big page.
  async function search(type, params) {
    const bundle = await call('GET', `${type}?${new URLSearchParams({ ...params, _count: '1000' })}`);
    return (bundle.entry || []).map((e) => e.resource);
  }
  return { call, search };
}

async function loadRecord(config, patientId, today) {
  const { call, search } = connect(config);
  const [patient, requests, statements, claims] = await Promise.all([
    call('GET', `Patient/${encodeURIComponent(patientId)}`),
    search('MedicationRequest', { patient: patientId, _include: 'MedicationRequest:medication' }),
    search('MedicationStatement', { patient: patientId }),
    search('ExplanationOfBenefit', { patient: patientId }),
  ]);
  return mapRecord({ patient, resources: [...requests, ...statements, ...claims] }, today, config.practice);
}

// Saves a medicine the patient added. Returns it in the shape the pages use.
async function addMedicine(config, patientId, input, now = new Date()) {
  const created = await connect(config).call('POST', 'MedicationStatement', toMedicationStatement(input, patientId, now));
  return fromStatement(created, config.practice);
}

// Deletes everything the demo added for this patient. Returns how many.
async function removeDemoAdditions(config, patientId) {
  const { call, search } = connect(config);
  const added = await search('MedicationStatement', { patient: patientId, _tag: `${DEMO_TAG.system}|${DEMO_TAG.code}` });
  for (const r of added) await call('DELETE', `MedicationStatement/${encodeURIComponent(r.id)}`);
  return added.length;
}

// A medicine from the over-the-counter list is saved with its RxNorm code, so
// the drug interaction check can use it. A typed name has no code.
function toMedicationStatement({ name, reason, dose }, patientId, now) {
  const patient = { reference: `Patient/${patientId}` };
  const picked = otc.find((o) => o.name.toLowerCase() === name.toLowerCase());
  return {
    resourceType: 'MedicationStatement',
    meta: { tag: [DEMO_TAG] },
    status: 'active',
    medicationCodeableConcept: {
      ...(picked && picked.rxcui && { coding: [{ system: RXNORM, code: picked.rxcui, display: picked.rxnorm }] }),
      text: name,
    },
    subject: patient,
    dateAsserted: now.toISOString(),
    informationSource: patient,
    ...(reason && { reasonCode: [{ text: reason }] }),
    ...(dose && { dosage: [{ text: dose }] }),
  };
}

// ---- Mapping FHIR onto the page fields ---------------------------------
const DAY = 86400000;
const toDay = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const localIsoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ingredientName = (s) => s.trim().toLowerCase().replace(/^acetaminophen$/, 'paracetamol');

// "For polycystic ovaries"
function reasonText(codes) {
  const text = codes && codes[0] && (codes[0].text || (codes[0].coding || [])[0]?.display);
  return text ? `For ${text.replace(/^for\s+/i, '').replace(/^\w/, (c) => c.toLowerCase())}` : '';
}

// Epic names look like "drospirenone-ethinyl estradiol 3-0.02 MG per tablet".
function splitName(label) {
  const m = label.match(/^(.*?)\s+(\d.*)$/);
  const name = (m ? m[1] : label).trim();
  return {
    name: capitalise(name),
    strength: m ? m[2].replace(/\bMG\b/g, 'mg').replace(/\bML\b/g, 'mL') : '',
    ingredients: name.split(/\s*(?:-|\/|\band\b)\s*/i).filter(Boolean).map(ingredientName),
  };
}

// "Physician" and similar placeholders are not worth showing.
const personName = (display) => (display && /\s/.test(display.trim()) ? display.trim() : null);

function patientName(patient) {
  const n = (patient.name || []).find((x) => x.use === 'official') || (patient.name || [])[0] || {};
  const given = (n.given || [])[0] || n.text || 'there';
  return given.replace(/\d+/g, ''); // synthetic names carry digits, e.g. "Chi716"
}

function fromRequest(r, medicationsById, practice, shift) {
  const ref = r.medicationReference && r.medicationReference.reference;
  const med = ref && medicationsById.get(ref.split('/').pop());
  const label = (med && med.code && med.code.text) || (r.medicationReference && r.medicationReference.display)
    || (r.medicationCodeableConcept && r.medicationCodeableConcept.text) || 'Unnamed medicine';
  const dosage = (r.dosageInstruction || [])[0] || {};
  const dispense = r.dispenseRequest || {};
  const supplyDays = dispense.expectedSupplyDuration && dispense.expectedSupplyDuration.value;
  const repeats = dispense.numberOfRepeatsAllowed;
  const { name, strength, ingredients } = splitName(label);
  return {
    resourceType: 'MedicationRequest',
    id: `mr-${r.id}`,
    refs: [`MedicationRequest/${r.id}`],
    status: 'active',
    source: 'record',
    medication: name,
    strength,
    ingredients,
    reason: reasonText(r.reasonCode),
    requester: personName(r.requester && r.requester.display),
    requesterPhone: practice.phone,
    dosageInstruction: dosage.patientInstruction || dosage.text || '',
    ...(repeats && supplyDays && r.authoredOn && {
      repeat: { nextDue: shift(isoDay(toDay(r.authoredOn) + supplyDays * DAY)), remaining: repeats },
    }),
  };
}

const isPharmacyClaim = (e) => ((e.type && e.type.coding) || []).some((c) => c.code === 'pharmacy' || c.code === 'PDE');

// Every medicine line on the pharmacy claims. key is the entry in
// data/drug-codes.js, or undefined when the NDC code is not in that table.
function pharmacyItems(claims) {
  const out = [];
  for (const e of claims.filter(isPharmacyClaim)) {
    const daysSupply = ((e.supportingInfo || []).find((s) => ((s.category && s.category.coding) || []).some((c) => c.code === 'dayssupply')) || {}).valueQuantity;
    for (const item of e.item || []) {
      const code = ((item.productOrService && item.productOrService.coding) || []).find((c) => /ndc/.test(c.system || ''));
      if (!code) continue;
      out.push({
        key: ndc[code.code],
        ndc: code.code,
        filled: item.servicedDate || (e.billablePeriod && e.billablePeriod.start),
        days: (daysSupply && daysSupply.value) || 30,
        quantity: item.quantity && item.quantity.value,
        claimId: e.id,
      });
    }
  }
  return out;
}

// One entry per medicine, from its most recent fill.
function pharmacyFills(claims) {
  const latest = new Map();
  for (const fill of pharmacyItems(claims)) {
    if (!fill.key || !fill.filled) continue;
    const prev = latest.get(fill.key);
    if (!prev || fill.filled > prev.filled) latest.set(fill.key, fill);
  }
  return [...latest.values()];
}

// statement: the MedicationStatement made from this medicine's claims, if any.
function fromFill(fill, practice, shift, todayMs, statement) {
  const drug = drugs[fill.key];
  const filled = shift(fill.filled);
  const runsOut = isoDay(toDay(filled) + fill.days * DAY);
  if (toDay(runsOut) < todayMs - CURRENT_WINDOW_DAYS * DAY) return null;
  return {
    resourceType: 'ExplanationOfBenefit',
    id: `rx-${fill.key}`,
    refs: statement ? [`MedicationStatement/${statement.id}`] : [],
    status: 'active',
    source: 'record',
    medication: drug.name,
    strength: drug.strength,
    ingredients: drug.ingredients,
    reason: '',
    requester: null,
    requesterPhone: practice.phone,
    dosageInstruction: '',
    lastSupply: { date: filled, quantity: fill.quantity, unit: drug.unit, days: fill.days },
    ...(toDay(runsOut) >= todayMs && { repeat: { nextDue: runsOut, remaining: null } }),
  };
}

function fromStatement(s, practice) {
  const concept = s.medicationCodeableConcept || {};
  const name = concept.text || (concept.coding || [])[0]?.display || 'Unnamed medicine';
  const picked = otc.find((o) => o.name.toLowerCase() === name.toLowerCase());
  // Made from claims: it came from the record, the patient did not add it.
  const fromRecord = hasTag(s, CLAIMS_TAG);
  return {
    resourceType: 'MedicationStatement',
    id: `ms-${s.id}`,
    refs: [`MedicationStatement/${s.id}`],
    status: s.status === 'active' ? 'active' : s.status,
    source: fromRecord ? 'record' : 'patient',
    ...(fromRecord && { requester: null, requesterPhone: practice && practice.phone }),
    addedOn: (s.dateAsserted || (s.meta && s.meta.lastUpdated) || '').slice(0, 10) || undefined,
    medication: name,
    ...(picked && { strength: `Contains ${picked.contains}`, ingredients: picked.ingredients }),
    reason: reasonText(s.reasonCode),
    dosageInstruction: ((s.dosage || [])[0] || {}).text || '',
  };
}

// patient: a FHIR Patient. resources: any mix of MedicationRequest, Medication,
// MedicationStatement and ExplanationOfBenefit for that patient.
function mapRecord({ patient, resources }, today, practice) {
  const of = (type) => resources.filter((r) => r.resourceType === type);
  const todayMs = toDay(localIsoDay(today));
  const requests = of('MedicationRequest').filter((r) => r.status === 'active');
  const fills = pharmacyFills(of('ExplanationOfBenefit'));

  const recordDates = [...requests.map((r) => r.authoredOn), ...fills.map((f) => f.filled)].filter(Boolean).sort();
  const latest = recordDates[recordDates.length - 1];
  const offset = latest ? todayMs - LATEST_EVENT_DAYS_AGO * DAY - toDay(latest) : 0;
  const shift = (iso) => isoDay(toDay(iso) + offset);

  const medicationsById = new Map(of('Medication').map((m) => [m.id, m]));
  const statements = of('MedicationStatement').filter((s) => s.status === 'active');
  const rxnormCodes = (s) => ((s.medicationCodeableConcept && s.medicationCodeableConcept.coding) || [])
    .filter((c) => c.system === RXNORM).map((c) => c.code);
  const madeFromClaims = (key) => statements.find((s) => hasTag(s, CLAIMS_TAG) && rxnormCodes(s).includes(drugs[key].rxcui));
  const fromClaims = fills.map((f) => fromFill(f, practice, shift, todayMs, madeFromClaims(f.key))).filter(Boolean);
  // A statement made from claims is listed only if its claim medicine is not.
  const alreadyListed = new Set(fromClaims.flatMap((m) => m.refs));
  const medications = [
    ...requests.map((r) => fromRequest(r, medicationsById, practice, shift)),
    ...fromClaims,
    ...statements.filter((s) => !alreadyListed.has(`MedicationStatement/${s.id}`)).map((s) => fromStatement(s, practice)),
  ];

  return {
    patient: { resourceType: 'Patient', id: patient.id, name: [{ given: [patientName(patient)] }], practice },
    medications,
    datesShiftedByDays: Math.round(offset / DAY),
  };
}

module.exports = { loadRecord, addMedicine, removeDemoAdditions, mapRecord, pharmacyItems, toMedicationStatement, FhirError, DEMO_TAG, CLAIMS_TAG, RXNORM };
