const path = require('node:path');
const express = require('express');
const record = require('./data/patient');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

// Fixed "today" so the mock data stays sensible. Swap for new Date() with real data.
const TODAY = new Date('2026-11-06T09:00:00');

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

Object.assign(app.locals, { formatDate, formatTime, relativeDay, formatWhen });
app.locals.patientName = record.patient.name[0].given[0];

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

// In-memory state for this server run only.
const repeatRequests = new Set();
let nextId = 100;

// Flags drive the "Needs your attention" group.
// level 'action' = the patient needs to do something (wireframe "!")
// level 'info'   = something changed or is unchecked (wireframe "o")
function toMedicine(m) {
  const flags = [];
  const requested = repeatRequests.has(m.id);
  if (m.repeat && !requested) {
    if (m.repeat.remaining === 0) {
      flags.push({ level: 'action', text: 'Your doctor needs to review this before your next repeat' });
    } else if (daysFromToday(m.repeat.nextDue) <= 7) {
      flags.push({ level: 'action', text: `Repeat due ${formatDate(m.repeat.nextDue)}` });
    }
  }
  if (m.changeNote) flags.push({ level: 'info', text: m.changeNote });
  if (m.source === 'patient') {
    flags.push({ level: 'info', text: 'Added by you. Your doctor has not checked it yet.' });
  }
  const level = flags.some((f) => f.level === 'action') ? 'action' : flags.length ? 'info' : null;
  return { ...m, flags, level, requested };
}

function activeMedicines() {
  const order = { action: 0, info: 1 };
  return record.medications
    .filter((m) => m.status === 'active')
    .map(toMedicine)
    .sort((a, b) => (order[a.level] ?? 2) - (order[b.level] ?? 2) || a.medication.localeCompare(b.medication));
}

function findOr404(list, id, res) {
  const item = list.find((x) => x.id === id);
  if (!item) res.status(404).render('404', { title: 'Page not found' });
  return item;
}

// ---- Routes ------------------------------------------------------------
// Home is the medicines screen (wireframe 1).
app.get('/', (req, res) => {
  const meds = activeMedicines();
  let notice = null;
  if (req.query.updated === 'changes') notice = 'Your list is up to date. We found changes from your doctor, shown below.';
  if (req.query.updated === 'none') notice = 'Your list is up to date. Nothing has changed.';
  const added = req.query.added && record.medications.find((m) => m.id === req.query.added);
  if (added) notice = `${added.medication} has been added to your list.`;

  res.render('index', {
    title: 'Your medicines',
    attention: meds.filter((m) => m.level),
    others: meds.filter((m) => !m.level),
    lastUpdated: record.medicationsLastUpdated,
    notice,
  });
});

app.get('/medicines', (req, res) => res.redirect(301, '/'));

app.post('/medicines/update', (req, res) => {
  const changes = record.pendingRecordChanges.splice(0);
  record.medications.push(...changes);
  record.medicationsLastUpdated = new Date().toISOString();
  res.redirect(303, `/?updated=${changes.length ? 'changes' : 'none'}`);
});

app.get('/medicines/add', (req, res) => {
  res.render('medicines/add', { title: 'Add a medicine', values: {}, errors: null });
});

app.post('/medicines/add', (req, res) => {
  const values = {
    name: (req.body.name || '').trim(),
    reason: (req.body.reason || '').trim(),
    dose: (req.body.dose || '').trim(),
  };
  if (!values.name) {
    return res.status(400).render('medicines/add', {
      title: 'Error: Add a medicine',
      values,
      errors: { name: 'Enter the name of the medicine' },
    });
  }
  const id = `m${nextId++}`;
  record.medications.push({
    resourceType: 'MedicationStatement',
    id,
    status: 'active',
    source: 'patient',
    addedOn: TODAY.toISOString().slice(0, 10),
    medication: values.name,
    reason: values.reason ? `For ${values.reason.replace(/^for\s+/i, '')}` : '',
    dosageInstruction: values.dose,
  });
  res.redirect(303, `/?added=${id}`);
});

app.get('/medicines/:id', (req, res) => {
  const m = findOr404(record.medications, req.params.id, res);
  if (m) {
    res.render('medicines/detail', {
      title: m.medication,
      med: toMedicine(m),
      justRequested: req.query.requested === '1',
    });
  }
});

app.post('/medicines/:id/repeat', (req, res) => {
  const m = findOr404(record.medications, req.params.id, res);
  if (!m) return;
  if (m.repeat) repeatRequests.add(m.id);
  res.redirect(303, `/medicines/${m.id}?requested=1`);
});

app.get('/appointments', (req, res) => {
  const all = record.appointments.map(toAppointment);
  res.render('appointments/list', {
    title: 'Appointments',
    upcoming: all.filter((a) => a.upcoming).sort((a, b) => a.start.localeCompare(b.start)),
    past: all.filter((a) => !a.upcoming).sort((a, b) => b.start.localeCompare(a.start)),
  });
});

app.get('/appointments/:id', (req, res) => {
  const a = findOr404(record.appointments, req.params.id, res);
  if (a) res.render('appointments/detail', { title: a.serviceType, appt: toAppointment(a) });
});

app.get('/results', (req, res) => {
  const results = record.observations.map(toResult)
    .sort((a, b) => b.effectiveDateTime.localeCompare(a.effectiveDateTime));
  res.render('results/list', { title: 'Test results', results });
});

app.get('/results/:id', (req, res) => {
  const o = findOr404(record.observations, req.params.id, res);
  if (o) res.render('results/detail', { title: o.plainName, result: toResult(o) });
});

app.use((req, res) => res.status(404).render('404', { title: 'Page not found' }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running at http://localhost:${port}`));
