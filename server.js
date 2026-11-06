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
const yearFmt = new Intl.DateTimeFormat('en-GB', { year: 'numeric' });

function formatDate(iso) {
  const d = new Date(iso);
  const text = dayFmt.format(d);
  return d.getFullYear() === TODAY.getFullYear() ? text : `${text} ${yearFmt.format(d)}`;
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

app.locals.formatDate = formatDate;
app.locals.formatTime = formatTime;
app.locals.relativeDay = relativeDay;
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

function toMedicine(m) {
  const due = m.repeat ? daysFromToday(m.repeat.nextDue) : null;
  return { ...m, dueSoon: due !== null && due <= 7 };
}

// Requests made during this server run. In-memory only.
const repeatRequests = new Set();

function findOr404(list, id, res) {
  const item = list.find((x) => x.id === id);
  if (!item) res.status(404).render('404', { title: 'Page not found' });
  return item;
}

// ---- Routes ------------------------------------------------------------
app.get('/', (req, res) => {
  const appts = record.appointments.map(toAppointment).filter((a) => a.upcoming)
    .sort((a, b) => a.start.localeCompare(b.start));
  const results = record.observations.map(toResult);
  const meds = record.medications.map(toMedicine);
  res.render('index', {
    title: 'Home',
    summary: {
      nextAppointment: appts[0],
      resultsToCheck: results.filter((r) => r.statusInfo.tone === 'warn').length,
      repeatsDue: meds.filter((m) => m.dueSoon && !repeatRequests.has(m.id)).length,
    },
  });
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

app.get('/medicines', (req, res) => {
  const medicines = record.medications.filter((m) => m.status === 'active').map(toMedicine);
  res.render('medicines/list', { title: 'Medicines', medicines, requested: repeatRequests });
});

app.get('/medicines/:id', (req, res) => {
  const m = findOr404(record.medications, req.params.id, res);
  if (m) {
    res.render('medicines/detail', {
      title: m.medication,
      med: toMedicine(m),
      requested: repeatRequests.has(m.id),
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

app.use((req, res) => res.status(404).render('404', { title: 'Page not found' }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running at http://localhost:${port}`));
