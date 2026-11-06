// Shared app logic. Used by the Express dev server (server.js) and by the
// static, in-browser demo build (client/main.js). No Node or browser APIs here.

const seed = require('../data/patient');
const interactions = require('../data/interactions');
const otc = require('../data/otc');
const fhirConfig = require('../data/fhir-config');
const fhir = require('./fhir');

// Fixed "today" so the mock data stays sensible. Swap for new Date() with real data.
const TODAY = new Date('2026-11-06T09:00:00');

// ---- State -------------------------------------------------------------
// Everything that changes during a demo lives here, so it can be saved as JSON.
// source is null until the patient "signs in" on the connect screens, then a
// FHIR patient id from data/fhir-config.js, or 'mock' for data/patient.js.
// A FHIR record is loaded on the first request after that, see ensureLoaded.
function createState(source = null) {
  return {
    source,
    loaded: !source || source === 'mock',
    loadError: null,
    record: JSON.parse(JSON.stringify(seed)),
    repeatRequests: [],
    nextId: 100,
  };
}

const usesFhir = (state) => Boolean(state.source) && state.source !== 'mock';

// Replace the made-up medicines with the FHIR patient's. Appointments and
// test results stay made up for now.
async function loadFromFhir(state) {
  const mapped = await fhir.loadRecord(fhirConfig, state.source, TODAY);
  state.record.patient = mapped.patient;
  state.record.medications = mapped.medications;
  state.record.pendingRecordChanges = [];
  state.record.medicationsLastUpdated = new Date().toISOString();
  state.loadError = null;
}

async function ensureLoaded(state) {
  if (state.loaded) return;
  state.loaded = true; // also on failure, so every page does not retry; "Update my list" does
  try {
    await loadFromFhir(state);
  } catch (e) {
    state.loadError = e.message;
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
    formatDate, formatTime, relativeDay, formatWhen, SEVERITY,
    patientName: state.record.patient.name[0].given[0],
    usesFhir: usesFhir(state),
    signedIn: Boolean(state.source),
    // URL for a file in public/. The static build swaps this for embedded data.
    asset: (file) => `/${file}`,
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

// Small, non-alarming tags. "!" is kept for conflicts only.
function toMedicine(state, m) {
  const tags = [];
  const requested = state.repeatRequests.includes(m.id);
  if (m.repeat && !requested && daysFromToday(m.repeat.nextDue) <= 7) {
    tags.push({ tone: 'neutral', text: `Repeat due ${formatDate(m.repeat.nextDue)}` });
  }
  if (m.changeNote) tags.push({ tone: 'neutral', text: m.changeNote });
  if (m.lastSupply) tags.push({ tone: 'neutral', text: `Last collected ${formatDate(m.lastSupply.date)}` });
  if (m.source === 'patient') tags.push({ tone: 'neutral', text: 'Bought by you' });
  return { ...m, tags, requested };
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

// Every pair of active medicines that a rule covers, most serious first.
// Two products with the same ingredient (Ibuprofen and Advil) each get their own conflict.
// A rule naming one ingredient twice (paracetamol) catches doubling up, once per pair.
function findConflicts(state, meds = activeMedicines(state)) {
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
      },
    };
  }],

  ['GET', '/medicines', () => ({ redirect: '/' })],

  // Conflict summary (wireframe 3): reached by tapping the "!" marks.
  ['GET', '/conflicts/:id', (s, p) => {
    const conflict = findConflicts(s).find((c) => c.id === p.id);
    if (!conflict) return notFound();
    return {
      view: 'conflicts/summary',
      locals: { title: `${conflict.meds[0].medication} and ${conflict.meds[1].medication}`, conflict },
    };
  }],

  // Fuller conflict page. Kept, but not linked from anywhere yet.
  ['GET', '/conflicts/:id/more', (s, p, q) => {
    const conflict = findConflicts(s).find((c) => c.id === p.id);
    if (!conflict) return notFound();
    const meds = [...conflict.meds].sort((a) => (a.id === q.from ? -1 : 1));
    return {
      view: 'conflicts/detail',
      locals: {
        title: `${meds[0].medication} and ${meds[1].medication}`,
        conflict: { ...conflict, meds },
        practice: s.record.patient.practice,
      },
    };
  }],

  ['POST', '/medicines/update', async (s) => {
    if (usesFhir(s)) {
      const before = new Set(s.record.medications.map((m) => m.id));
      try {
        await loadFromFhir(s);
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

  ['POST', '/medicines/add', async (s, p, q, body) => {
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
        const med = await fhir.addMedicine(fhirConfig, s.source, { name, reason: values.reason, dose: values.dose });
        s.record.medications.push(med);
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
  ['POST', '/connect/:payer', async (s, p, q, body) => {
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
    await ensureLoaded(s);
    return { redirect: '/' };
  }],

  ['POST', '/sign-out', (s) => {
    Object.assign(s, createState());
    return { redirect: '/connect?signedOut=1' };
  }],

  // Starts the demo again: removes medicines it added to the FHIR server and signs out.
  ['POST', '/demo/reset', async (s) => {
    let failed = false;
    if (usesFhir(s)) {
      try {
        await fhir.removeDemoAdditions(fhirConfig, s.source);
      } catch (e) {
        failed = true;
      }
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
async function handle(state, method, path, query = {}, body = {}) {
  // Nothing but the connect screens until the patient has "signed in".
  if (!state.source && !path.startsWith('/connect') && path !== '/demo/reset') {
    return { redirect: '/connect' };
  }
  await ensureLoaded(state);
  for (const r of compiled) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const result = await r.handler(state, params, query, body);
    if (result.view) result.locals = { ...baseLocals(state), ...result.locals };
    return result;
  }
  const result = notFound();
  result.locals = { ...baseLocals(state), ...result.locals };
  return result;
}

module.exports = { createState, handle, findConflicts };
