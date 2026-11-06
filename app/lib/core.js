// Shared app logic. Used by the Express dev server (server.js) and by the
// static, in-browser demo build (client/main.js). No Node or browser APIs here.

const seed = require('../data/patient');
const interactions = require('../data/interactions');
const otc = require('../data/otc');
const fhirConfig = require('../data/fhir-config');
const fhir = require('./fhir');

// Fixed "today" so the mock data stays sensible. Swap for new Date() with real data.
const TODAY = new Date('2026-11-06T09:00:00');

// ---- Outside services --------------------------------------------------
// Where the record comes from and what checks it for conflicts. This default
// is what the static demo uses: the shared test server, and no checker, so
// the made-up rules in data/interactions.js apply. The local server passes
// its own to handle(): Aidbox and Scholz DataBank (lib/aidbox-services.js).
const defaultServices = {
  loadRecord: (patientId, today) => fhir.loadRecord(fhirConfig, patientId, today),
  addMedicine: (patientId, input) => fhir.addMedicine(fhirConfig, patientId, input),
  removeDemoAdditions: (patientId) => fhir.removeDemoAdditions(fhirConfig, patientId),
  // (patientId) => { medicines, conflicts, notChecked }, as GET /patients/{id}/interactions
  checkInteractions: null,
  // (interactionCode) => { mechanism, management }
  interactionFullText: null,
};

// ---- State -------------------------------------------------------------
// Everything that changes during a demo lives here, so it can be saved as JSON.
// source is null until the patient "signs in" on the connect screens, then a
// FHIR patient id from data/fhir-config.js, or 'mock' for data/patient.js.
// A FHIR record is loaded on the first request after that, see ensureLoaded.
// check is the latest answer from the interaction checker, or null when the
// made-up rules are in use.
function createState(source = null) {
  return {
    source,
    loaded: !source || source === 'mock',
    loadError: null,
    check: null,
    record: JSON.parse(JSON.stringify(seed)),
    repeatRequests: [],
    nextId: 100,
  };
}

const usesFhir = (state) => Boolean(state.source) && state.source !== 'mock';

// Replace the made-up medicines with the FHIR patient's. Appointments and
// test results stay made up for now.
async function loadFromFhir(state, svc) {
  const mapped = await svc.loadRecord(state.source, TODAY);
  state.record.patient = mapped.patient;
  state.record.medications = mapped.medications;
  state.record.pendingRecordChanges = [];
  state.record.medicationsLastUpdated = new Date().toISOString();
  state.loadError = null;
  await checkMedicines(state, svc);
}

async function ensureLoaded(state, svc) {
  if (state.loaded) return;
  state.loaded = true; // also on failure, so every page does not retry; "Update my list" does
  try {
    await loadFromFhir(state, svc);
  } catch (e) {
    state.loadError = e.message;
  }
}

// Ask the checker about the medicines now on the record. Called whenever the
// list changes, not on every page. A failure is kept, so the pages can say
// the medicines were not checked rather than show no conflicts.
async function checkMedicines(state, svc) {
  if (!svc.checkInteractions || !usesFhir(state)) {
    state.check = null;
    return;
  }
  try {
    const { medicines, conflicts, notChecked } = await svc.checkInteractions(state.source);
    state.check = { medicines, conflicts, notChecked, fullText: {}, error: null };
  } catch (e) {
    state.check = { medicines: [], conflicts: [], notChecked: [], fullText: {}, error: e.message };
  }
}

// ---- Formatting: plain English, e.g. "Thursday 12 November" -------------
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

function formatDate(iso) {
  const d = new Date(iso);
  const text = dayFmt.format(d);
  return d.getFullYear() === TODAY.getFullYear() ? text : `${text} ${d.getFullYear()}`;
}

function formatTime(iso) {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

function daysFromToday(iso) {
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((start(new Date(iso)) - start(TODAY)) / 86400000);
}

function relativeDay(iso) {
  const n = daysFromToday(iso);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1) return `In ${n} days`;
  return `${-n} days ago`;
}

// "today at 7:45am" / "Thursday 5 November at 7:45am"
function formatWhen(iso) {
  const n = daysFromToday(iso);
  const day = n === 0 ? 'today' : n === -1 ? 'yesterday' : formatDate(iso);
  return `${day} at ${formatTime(iso)}`;
}

// Severity scale from wireframe 2: one to three "!" marks.
const SEVERITY = {
  3: { label: 'Serious', advice: 'Act today' },
  2: { label: 'Moderate', advice: 'Check with a pharmacist or doctor soon' },
  1: { label: 'Minor', advice: 'Good to know' },
};

// Locals every template can use.
function baseLocals(state) {
  return {
    formatDate, formatTime, relativeDay, formatWhen, SEVERITY, joinNames,
    patientName: state.record.patient.name[0].given[0],
    usesFhir: usesFhir(state),
    signedIn: Boolean(state.source),
  };
}

// ---- View models -------------------------------------------------------
function toAppointment(a) {
  return { ...a, upcoming: a.status === 'booked' && daysFromToday(a.start) >= 0 };
}

const RESULT_STATUS = {
  normal: { label: 'Normal', tone: 'ok' },
  high: { label: 'Higher than normal', tone: 'warn' },
  low: { label: 'Lower than normal', tone: 'warn' },
  waiting: { label: 'Waiting for result', tone: 'neutral' },
};

function toResult(o) {
  const key = o.status === 'preliminary' ? 'waiting' : o.interpretation;
  let range = null;
  if (o.referenceRange) {
    const { low, high } = o.referenceRange;
    if (low != null && high != null) range = `${low} to ${high} ${o.unit}`;
    else if (high != null) range = `Below ${high} ${o.unit}`;
    else if (low != null) range = `Above ${low} ${o.unit}`;
  }
  return { ...o, statusInfo: RESULT_STATUS[key], range };
}

// With a checker, a medicine is covered only if the check actually saw one of
// the FHIR resources it stands for. Anything else has not been checked, for
// example a typed name with no code, or claims never turned into statements.
function uncheckedIds(state) {
  if (!state.check || state.check.error) return new Set();
  const seen = new Set(state.check.medicines.flatMap((m) => m.sources));
  return new Set(state.record.medications
    .filter((m) => m.status === 'active' && !(m.refs || []).some((ref) => seen.has(ref)))
    .map((m) => m.id));
}

// Small, non-alarming tags. "!" is kept for conflicts only.
function toMedicine(state, m) {
  const tags = [];
  const notChecked = uncheckedIds(state).has(m.id);
  if (notChecked) tags.push({ tone: 'warn', text: 'Not checked for conflicts' });
  const requested = state.repeatRequests.includes(m.id);
  if (m.repeat && !requested && daysFromToday(m.repeat.nextDue) <= 7) {
    tags.push({ tone: 'neutral', text: `Repeat due ${formatDate(m.repeat.nextDue)}` });
  }
  if (m.changeNote) tags.push({ tone: 'neutral', text: m.changeNote });
  if (m.lastSupply) tags.push({ tone: 'neutral', text: `Last collected ${formatDate(m.lastSupply.date)}` });
  if (m.source === 'patient') tags.push({ tone: 'neutral', text: 'Bought by you' });
  return { ...m, tags, requested, notChecked };
}

function activeMedicines(state) {
  return state.record.medications
    .filter((m) => m.status === 'active')
    .map((m) => toMedicine(state, m))
    .sort((a, b) => a.medication.localeCompare(b.medication));
}

// What a medicine is matched on for conflicts: its active ingredients when
// known (e.g. Advil -> ibuprofen), otherwise the first word of its name.
const matchKeys = (m) => m.ingredients || [m.medication.trim().split(/\s+/)[0].toLowerCase()];

// "A and B", "A, B and C"
function joinNames(meds) {
  const names = meds.map((m) => m.medication);
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Patient wording for a conflict from the checker, by severity. The checker's
// own text is written for clinicians and is shown separately, as it is.
// Placeholders like the made-up rules: not clinically reviewed.
const CHECKED_WORDING = {
  3: (n) => ({
    summary: `These ${n} medicines interact. You need to talk to your doctor or a pharmacist today.`,
    whatToDo: ['Talk to your doctor or a pharmacist today.', 'Do not stop a medicine your doctor prescribed until you have spoken to them.'],
  }),
  2: (n) => ({
    summary: `These ${n} medicines interact. Talk to your doctor or a pharmacist soon.`,
    whatToDo: ['Talk to a pharmacist or your doctor soon.', 'Do not stop a medicine your doctor prescribed until you have spoken to them.'],
  }),
  1: (n) => ({
    summary: `These ${n} medicines interact slightly. You do not need to change anything, but mention it next time you see your doctor.`,
    whatToDo: ['Keep taking your medicines as normal.', 'Mention it next time you see your doctor or a pharmacist.'],
  }),
};

const sentence = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1).replace(/\.?$/, '.') : '');

// Conflicts from the checker, in the shape the pages use. The checker names
// FHIR resources; each is matched to the medicine on the list that stands
// for it. One checked medicine can be two entries on the list (prescribed
// and also bought), and each combination is its own conflict. A member that
// is not on the list is still shown, by the checker's name, so no warning
// is lost.
function checkedConflicts(state, meds) {
  const byRef = new Map();
  for (const m of meds) for (const ref of m.refs || []) byRef.set(ref, m);
  const checked = new Map(state.check.medicines.map((m) => [m.rxcui, m]));
  const out = [];
  for (const c of state.check.conflicts) {
    const members = c.medicines.map((rxcui) => {
      const medicine = checked.get(rxcui) || { name: 'Another medicine', sources: [] };
      const onList = [...new Set(medicine.sources.map((ref) => byRef.get(ref)).filter(Boolean))];
      return onList.length ? onList : [{
        id: `unlisted-${rxcui}`, medication: medicine.name, source: 'record', tags: [],
        requester: null, requesterPhone: state.record.patient.practice.phone,
      }];
    });
    const combinations = members.reduce((sets, group) => sets.flatMap((set) => group.map((m) => [...set, m])), [[]]);
    for (const combination of combinations) {
      out.push({
        id: `${c.interactionCode}-${combination.map((m) => m.id).join('-')}`,
        severity: c.severity,
        severityInfo: SEVERITY[c.severity],
        meds: combination,
        ...CHECKED_WORDING[c.severity](combination.length),
        whatCouldHappen: sentence(c.effect),
        interactionCode: c.interactionCode,
        clinical: { effect: c.effect, advice: c.whatToDo },
      });
    }
  }
  return out.sort((x, y) => y.severity - x.severity);
}

// Every pair of active medicines that may not mix well, most serious first.
// With a checker, the pairs are the checker's. Otherwise the made-up rules:
// Two products with the same ingredient (Ibuprofen and Advil) each get their own conflict.
// A rule naming one ingredient twice (paracetamol) catches doubling up, once per pair.
function findConflicts(state, meds = activeMedicines(state)) {
  if (state.check) return state.check.error ? [] : checkedConflicts(state, meds);
  const byKey = new Map();
  for (const m of meds) for (const k of matchKeys(m)) byKey.set(k, [...(byKey.get(k) || []), m]);
  const out = [];
  for (const r of interactions) {
    const [left, right] = r.medicines.map((k) => byKey.get(k) || []);
    const sameIngredient = r.medicines[0] === r.medicines[1];
    for (const a of left) for (const b of right) {
      if (a.id === b.id || (sameIngredient && a.id > b.id)) continue;
      out.push({ ...r, id: `${r.id}-${a.id}-${b.id}`, meds: [a, b], severityInfo: SEVERITY[r.severity] });
    }
  }
  return out.sort((x, y) => y.severity - x.severity);
}

// ---- Routes ------------------------------------------------------------
// Each handler returns one of:
//   { view, locals, status? }  render a template
//   { redirect }               go to another path (after a form post)
const notFound = () => ({ status: 404, view: '404', locals: { title: 'Page not found' } });

const routes = [
  // Home is the medicines screen (wireframe 1).
  ['GET', '/', (s, p, q) => {
    const meds = activeMedicines(s);
    let notice = null;
    if (q.updated === 'changes') notice = 'Your list is up to date. We found changes from your doctor, shown below.';
    if (q.updated === 'none') notice = 'Your list is up to date. Nothing has changed.';
    if (q.reset === '1') notice = 'The demo has been reset.';
    const added = q.added && s.record.medications.find((m) => m.id === q.added);
    if (added) notice = `${added.medication} has been added to your list.`;
    const conflicts = findConflicts(s, meds);
    const inConflict = new Set(conflicts.flatMap((c) => c.meds.map((m) => m.id)));
    return {
      view: 'index',
      locals: {
        title: 'Your medicines',
        conflicts,
        others: meds.filter((m) => !inConflict.has(m.id)),
        lastUpdated: s.record.medicationsLastUpdated,
        notice,
        loadError: s.loadError,
        checkError: Boolean(s.check && s.check.error),
        notChecked: meds.filter((m) => m.notChecked),
      },
    };
  }],

  ['GET', '/medicines', () => ({ redirect: '/' })],

  // Conflict summary (wireframe 3): reached by tapping the "!" marks.
  ['GET', '/conflicts/:id', async (s, p, q, body, svc) => {
    const conflict = findConflicts(s).find((c) => c.id === p.id);
    if (!conflict) return notFound();
    // The checker's full text is fetched when the warning is opened, once.
    if (conflict.interactionCode && svc.interactionFullText) {
      const kept = s.check.fullText;
      if (!kept[conflict.interactionCode]) {
        try {
          const { mechanism, management } = await svc.interactionFullText(conflict.interactionCode);
          kept[conflict.interactionCode] = { mechanism, management };
        } catch (e) { /* the page still has the short text */ }
      }
      Object.assign(conflict.clinical, kept[conflict.interactionCode]);
    }
    return { view: 'conflicts/summary', locals: { title: joinNames(conflict.meds), conflict } };
  }],

  // Fuller conflict page. Kept, but not linked from anywhere yet.
  ['GET', '/conflicts/:id/more', (s, p, q) => {
    const conflict = findConflicts(s).find((c) => c.id === p.id);
    if (!conflict) return notFound();
    const meds = [...conflict.meds].sort((a) => (a.id === q.from ? -1 : 1));
    return {
      view: 'conflicts/detail',
      locals: {
        title: joinNames(meds),
        conflict: { ...conflict, meds },
        practice: s.record.patient.practice,
      },
    };
  }],

  ['POST', '/medicines/update', async (s, p, q, body, svc) => {
    if (usesFhir(s)) {
      const before = new Set(s.record.medications.map((m) => m.id));
      try {
        await loadFromFhir(s, svc);
      } catch (e) {
        s.loadError = e.message;
        return { redirect: '/' };
      }
      return { redirect: `/?updated=${s.record.medications.some((m) => !before.has(m.id)) ? 'changes' : 'none'}` };
    }
    const changes = s.record.pendingRecordChanges.splice(0);
    s.record.medications.push(...changes);
    s.record.medicationsLastUpdated = new Date().toISOString();
    return { redirect: `/?updated=${changes.length ? 'changes' : 'none'}` };
  }],

  ['GET', '/medicines/add', () => ({
    view: 'medicines/add',
    locals: { title: 'Add a medicine', values: {}, errors: null, saveError: false, otc },
  })],

  ['POST', '/medicines/add', async (s, p, q, body, svc) => {
    const values = {
      choice: (body.choice || '').trim(),
      name: (body.name || '').trim(),
      reason: (body.reason || '').trim(),
      dose: (body.dose || '').trim(),
    };
    // A typed name wins over the list, in case they picked one then typed another.
    const picked = otc.find((o) => o.id === values.choice);
    const name = values.name || (picked && picked.name);
    if (!name) {
      return {
        status: 400,
        view: 'medicines/add',
        locals: {
          title: 'Error: Add a medicine', values, otc, saveError: false,
          errors: { choice: 'Choose a medicine from the list, or type its name' },
        },
      };
    }
    const fromList = !values.name && picked;
    if (usesFhir(s)) {
      try {
        const med = await svc.addMedicine(s.source, { name, reason: values.reason, dose: values.dose });
        s.record.medications.push(med);
        await checkMedicines(s, svc);
        return { redirect: `/?added=${encodeURIComponent(med.id)}` };
      } catch (e) {
        return {
          status: 502,
          view: 'medicines/add',
          locals: { title: 'Error: Add a medicine', values, otc, errors: null, saveError: true },
        };
      }
    }
    const id = `m${s.nextId++}`;
    s.record.medications.push({
      resourceType: 'MedicationStatement',
      id,
      status: 'active',
      source: 'patient',
      addedOn: TODAY.toISOString().slice(0, 10),
      medication: name,
      ...(fromList && { strength: `Contains ${picked.contains}`, ingredients: picked.ingredients }),
      reason: values.reason ? `For ${values.reason.replace(/^for\s+/i, '')}` : '',
      dosageInstruction: values.dose,
    });
    return { redirect: `/?added=${id}` };
  }],

  ['GET', '/medicines/:id', (s, p, q) => {
    const m = s.record.medications.find((x) => x.id === p.id);
    if (!m) return notFound();
    return {
      view: 'medicines/detail',
      locals: {
        title: m.medication,
        med: toMedicine(s, m),
        conflicts: findConflicts(s).filter((c) => c.meds.some((x) => x.id === m.id)),
        justRequested: q.requested === '1',
      },
    };
  }],

  ['POST', '/medicines/:id/repeat', (s, p) => {
    const m = s.record.medications.find((x) => x.id === p.id);
    if (!m) return notFound();
    if (m.repeat && !s.repeatRequests.includes(m.id)) s.repeatRequests.push(m.id);
    return { redirect: `/medicines/${m.id}?requested=1` };
  }],

  // Fake sign-in, wireframe "Connect to payer". Only payers with a patient lead anywhere.
  ['GET', '/connect', (s, p, q) => ({
    view: 'connect/index',
    locals: {
      title: 'Connect to payer',
      payers: fhirConfig.payers,
      notice: q.reset === '1' ? 'The demo has been reset.' : q.signedOut === '1' ? 'You have signed out.' : null,
      resetError: q.resetError === '1',
    },
  })],

  ['GET', '/connect/:payer', (s, p) => {
    const payer = fhirConfig.payers.find((x) => x.id === p.payer && x.patientId);
    if (!payer) return notFound();
    return { view: 'connect/sign-in', locals: { title: `Sign in to ${payer.name}`, payer, values: {}, errors: null } };
  }],

  // Any username and password will do; neither is kept.
  ['POST', '/connect/:payer', async (s, p, q, body, svc) => {
    const payer = fhirConfig.payers.find((x) => x.id === p.payer && x.patientId);
    if (!payer) return notFound();
    const values = { username: (body.username || '').trim() };
    const errors = {};
    if (!values.username) errors.username = 'Enter your username';
    if (!body.password) errors.password = 'Enter your password';
    if (Object.keys(errors).length) {
      return { status: 400, view: 'connect/sign-in', locals: { title: `Error: Sign in to ${payer.name}`, payer, values, errors } };
    }
    Object.assign(s, createState(payer.patientId));
    await ensureLoaded(s, svc);
    return { redirect: '/' };
  }],

  ['POST', '/sign-out', (s) => {
    Object.assign(s, createState());
    return { redirect: '/connect?signedOut=1' };
  }],

  // Starts the demo again: removes medicines it added to the FHIR server and signs out.
  ['POST', '/demo/reset', async (s, p, q, body, svc) => {
    let failed = false;
    if (usesFhir(s)) {
      try {
        await svc.removeDemoAdditions(s.source);
      } catch (e) {
        failed = true;
      }
      // Check once more, so the checker withdraws warnings for what was removed.
      await checkMedicines(s, svc);
    }
    Object.assign(s, createState());
    return { redirect: `/connect?reset=1${failed ? '&resetError=1' : ''}` };
  }],

  ['GET', '/appointments', (s) => {
    const all = s.record.appointments.map(toAppointment);
    return {
      view: 'appointments/list',
      locals: {
        title: 'Appointments',
        upcoming: all.filter((a) => a.upcoming).sort((a, b) => a.start.localeCompare(b.start)),
        past: all.filter((a) => !a.upcoming).sort((a, b) => b.start.localeCompare(a.start)),
      },
    };
  }],

  ['GET', '/appointments/:id', (s, p) => {
    const a = s.record.appointments.find((x) => x.id === p.id);
    if (!a) return notFound();
    return { view: 'appointments/detail', locals: { title: a.serviceType, appt: toAppointment(a) } };
  }],

  ['GET', '/results', (s) => {
    const results = s.record.observations.map(toResult)
      .sort((a, b) => b.effectiveDateTime.localeCompare(a.effectiveDateTime));
    return { view: 'results/list', locals: { title: 'Test results', results } };
  }],

  ['GET', '/results/:id', (s, p) => {
    const o = s.record.observations.find((x) => x.id === p.id);
    if (!o) return notFound();
    return { view: 'results/detail', locals: { title: o.plainName, result: toResult(o) } };
  }],
];

// Turn '/medicines/:id' into a matcher once.
const compiled = routes.map(([method, pattern, handler]) => {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
  return { method, re, names, handler };
});

// Run one request against the state. state may be changed by POST handlers.
// services: see defaultServices above.
async function handle(state, method, path, query = {}, body = {}, services = defaultServices) {
  // Nothing but the connect screens until the patient has "signed in".
  if (!state.source && !path.startsWith('/connect') && path !== '/demo/reset') {
    return { redirect: '/connect' };
  }
  await ensureLoaded(state, services);
  for (const r of compiled) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const result = await r.handler(state, params, query, body, services);
    if (result.view) result.locals = { ...baseLocals(state), ...result.locals };
    return result;
  }
  const result = notFound();
  result.locals = { ...baseLocals(state), ...result.locals };
  return result;
}

module.exports = { createState, handle, findConflicts };
