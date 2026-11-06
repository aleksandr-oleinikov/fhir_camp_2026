// Drug interaction checks. Reads a patient's active medicines from Aidbox,
// asks Scholz DataBank which of them may not mix well, and records each pair
// in Aidbox as a DetectedIssue. Spec: ../../docs/ddi-backend.md; the step
// numbers below are the ones in its section 2.
//
// Server only. It holds the Scholz key and the Aidbox secret, so it must never
// be required from lib/core.js or client/, which are bundled into the static
// demo.

const combiStatusText = require('../data/scholz-combi-status');

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const ISSUE_SYSTEM = 'urn:fhir-camp-2026:scholz-interaction';
const SCHOLZ_BASE = 'https://rest.scholzdatabank.com/ditwebservices';

// Scholz rejects long URLs: 30 RxCUIs pass, 40 return HTTP 400.
const MAX_PER_CHECK = 30;
const CHUNK_SIZE = 15;
const TIMEOUT_MS = 15000;
const MAX_PAGES = 20;

const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
const DIGITS = /^\d+$/;

// An error with the HTTP status the route should answer with. Messages are
// safe to log and to send to the UI: they never contain the key or secret.
class DdiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const upstream = (message) => new DdiError(502, message);

// ---- Configuration -----------------------------------------------------
const ENV = {
  aidboxUrl: 'AIDBOX_URL',
  aidboxClientId: 'AIDBOX_CLIENT_ID',
  aidboxClientSecret: 'AIDBOX_CLIENT_SECRET',
  scholzUci: 'SCHOLZ_UCI',
};

function configFromEnv(env = process.env) {
  return Object.fromEntries(Object.entries(ENV).map(([key, name]) => [key, env[name]]));
}

function requireConfig(config, keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) throw new DdiError(503, `Not configured: set ${missing.map((k) => ENV[k]).join(', ')}`);
}

// For log lines: the key and secret become "***".
function maskSecrets(config, text) {
  let out = String(text);
  for (const secret of [config.scholzUci, config.aidboxClientSecret]) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

// ---- Aidbox ------------------------------------------------------------
// Access tokens from the client credentials grant, per Aidbox and client,
// kept until shortly before they expire.
const tokenCache = new Map();
const signIns = new Map(); // sign-ins under way, so parallel requests share one
const TOKEN_FALLBACK_SECONDS = 300; // when Aidbox does not say how long a token lasts

// rejected is a token Aidbox has just refused; it is never handed out again.
async function accessToken(config, base, rejected) {
  const key = `${base.href}|${config.aidboxClientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.token !== rejected && cached.expires > Date.now()) return cached.token;
  if (!signIns.has(key)) signIns.set(key, signIn(config, base, key).finally(() => signIns.delete(key)));
  return signIns.get(key);
}

async function signIn(config, base, key) {
  let res;
  try {
    res = await fetch(`${base.href}auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: config.aidboxClientId, client_secret: config.aidboxClientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw upstream(`Could not reach Aidbox to sign in (${maskSecrets(config, e.message)})`);
  }
  if (!res.ok) throw upstream(`Aidbox sign-in returned HTTP ${res.status}; check AIDBOX_CLIENT_ID and AIDBOX_CLIENT_SECRET`);
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch (e) {
    body = null;
  }
  if (!body || !body.access_token) throw upstream('Aidbox sign-in did not return an access token');
  const seconds = Number(body.expires_in) > 0 ? Number(body.expires_in) : TOKEN_FALLBACK_SECONDS;
  tokenCache.set(key, { token: body.access_token, expires: Date.now() + Math.max(seconds - 30, 1) * 1000 });
  return body.access_token;
}

// Why Aidbox refused a request, from its OperationOutcome, for the log.
async function reason(res) {
  try {
    const issue = (JSON.parse(await res.text()).issue || [])[0] || {};
    const text = issue.diagnostics || (issue.details && issue.details.text) || '';
    return text ? `: ${String(text).slice(0, 200)}` : '';
  } catch (e) {
    return '';
  }
}

function aidboxClient(config) {
  const base = new URL(`${config.aidboxUrl.replace(/\/+$/, '')}/`);

  // path is relative to AIDBOX_URL, or a "next" link from a Bundle. Links are
  // re-pointed at AIDBOX_URL, so the token never goes to another host.
  // With missingOk, a resource that is not there (or was deleted) gives null.
  async function call(method, path, body, { missingOk = false } = {}) {
    const u = new URL(path, base);
    const label = `${method} ${u.pathname}`;
    const send = async (token) => {
      try {
        return await fetch(base.origin + u.pathname + u.search, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
          body: body && JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw upstream(`Could not reach Aidbox for ${label} (${maskSecrets(config, e.message)})`);
      }
    };
    let token = await accessToken(config, base);
    let res = await send(token);
    if (res.status === 401) {
      // The token was revoked or ran out early: sign in again, once.
      token = await accessToken(config, base, token);
      res = await send(token);
    }
    if (missingOk && (res.status === 404 || res.status === 410)) return null;
    if (!res.ok) throw upstream(`Aidbox ${label} returned HTTP ${res.status}${await reason(res)}`);
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      throw upstream(`Aidbox ${label} did not return JSON`);
    }
  }

  // Every page of a search. Stops with an error rather than a short list: a
  // medicine missing from the check would look like "no interactions".
  async function searchAll(path) {
    const out = [];
    let next = path;
    for (let page = 0; next; page++) {
      if (page >= MAX_PAGES) throw upstream(`Aidbox search returned more than ${MAX_PAGES} pages`);
      const bundle = (await call('GET', next)) || {};
      out.push(...(bundle.entry || []).map((e) => e.resource).filter(Boolean));
      next = ((bundle.link || []).find((l) => l.relation === 'next') || {}).url;
    }
    return out;
  }

  return { call, searchAll };
}

// Step 1. Active prescriptions and medicines the patient added, each with
// the Medication it points to.
async function loadMedicineResources(aidbox, patientId) {
  const query = (type) => `fhir/${type}?${new URLSearchParams({
    subject: `Patient/${patientId}`, status: 'active', _include: `${type}:medication`, _count: '100',
  })}`;
  const [requests, statements] = await Promise.all([
    aidbox.searchAll(query('MedicationRequest')),
    aidbox.searchAll(query('MedicationStatement')),
  ]);
  return [...requests, ...statements];
}

// Step 2. One entry per MedicationRequest or MedicationStatement, with the
// RxNorm codes found on it or on its Medication. A Medication can carry
// several (Epic lists the ingredients next to the product); step 3 picks.
function medicineEntries(resources) {
  const medications = new Map(resources.filter((r) => r.resourceType === 'Medication').map((m) => [m.id, m]));
  const seen = new Set();
  const entries = [];
  for (const r of resources) {
    if (r.resourceType !== 'MedicationRequest' && r.resourceType !== 'MedicationStatement') continue;
    if (r.status !== 'active') continue;
    const source = `${r.resourceType}/${r.id}`;
    if (seen.has(source)) continue;
    seen.add(source);

    const ref = r.medicationReference || {};
    const target = ref.reference || '';
    const medication = target.startsWith('#')
      ? (r.contained || []).find((c) => c.id === target.slice(1))
      : medications.get(target.split('/').pop());
    const concept = r.medicationCodeableConcept || (medication && medication.code) || {};
    const codings = (concept.coding || []).filter((c) => c.system === RXNORM && DIGITS.test(String(c.code || '')));
    entries.push({
      source,
      name: concept.text || (codings[0] && codings[0].display) || ref.display || 'Unnamed medicine',
      rxcuis: [...new Set(codings.map((c) => String(c.code)))],
    });
  }
  return entries;
}

// ---- Scholz DataBank ---------------------------------------------------
// One GET. arg is digits, or digits joined by commas, so it needs no escaping.
// HTTP is always 200; ResponseStatus.ErrorCode carries the result. Scholz
// sends every value as a string.
async function scholz(config, fn, arg) {
  const base = (config.scholzBase || SCHOLZ_BASE).replace(/\/+$/, '');
  if (!base.startsWith('https://')) throw new DdiError(503, 'Scholz DataBank must be called over https');
  const label = `${fn}/***/${arg}`;
  let res;
  try {
    res = await fetch(`${base}/${fn}/${encodeURIComponent(config.scholzUci)}/${arg}?format=json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw upstream(`Could not reach Scholz DataBank for ${label} (${maskSecrets(config, e.message)})`);
  }
  if (!res.ok) throw upstream(`Scholz ${label} returned HTTP ${res.status}`);
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch (e) {
    // An unregistered key gets an HTML page, not JSON.
    throw upstream(`Scholz ${label} did not return JSON; check the key`);
  }
  const status = (body && body.ResponseStatus) || {};
  return {
    body: body || {},
    code: String(status.ErrorCode == null ? '' : status.ErrorCode).trim(),
    // Scholz quotes a rejected key back in its message.
    message: maskSecrets(config, status.Message || ''),
  };
}

const scholzFailure = (what, { code, message }) =>
  upstream(`Scholz ${what} failed: ErrorCode ${code || 'missing'}${message ? ` (${message})` : ''}`);

// Step 3. RxCUI -> Scholz drug, or null when Scholz does not know the code
// (unknown, or ingredient level). Kept for the life of the process: the
// lookup takes one RxCUI per call.
const lookupCache = new Map();

// Scholz uses ErrorCode 8 for a bad key and also for some RxCUIs it cannot
// use (ethinyl estradiol, 4124, is one). Only the message tells them apart.
const rxcuiRejected = (reply) => reply.code === '8' && /\bRXCUI\b.*\bnot valid\b/i.test(reply.message);

async function lookup(config, rxcui) {
  if (lookupCache.has(rxcui)) return lookupCache.get(rxcui);
  const reply = await scholz(config, 'distinctdrugsbyrxcui', rxcui);
  const drug = (reply.body.DrugList || [])[0];
  let hit;
  if (reply.code === '2' || rxcuiRejected(reply)) hit = null;
  else if (reply.code === '1' && drug && drug.DrugCode) hit = { drugCode: String(drug.DrugCode), drugName: drug.DrugName || '' };
  else throw scholzFailure(`lookup of RxCUI ${rxcui}`, reply);
  lookupCache.set(rxcui, hit);
  return hit;
}

// Steps 2 and 3 together. The same RxCUI from two resources (prescribed and
// also bought) is one medicine with two sources. Everything that cannot be
// sent to the check goes to notChecked, because the check answers an unknown
// code with "no interactions".
async function resolveMedicines(config, entries) {
  const medicines = new Map();
  const notChecked = [];
  for (const e of entries) {
    if (!e.rxcuis.length) {
      notChecked.push({ source: e.source, name: e.name, reason: 'no RxNorm code' });
      continue;
    }
    let found = null;
    for (const rxcui of e.rxcuis) {
      const hit = await lookup(config, rxcui);
      if (hit) {
        found = { rxcui, ...hit };
        break;
      }
    }
    if (!found) {
      notChecked.push({ source: e.source, name: e.name, reason: 'RxNorm code not known to Scholz' });
      continue;
    }
    const m = medicines.get(found.rxcui)
      || { rxcui: found.rxcui, name: found.drugName || e.name, drugCode: found.drugCode, sources: [] };
    m.sources.push(e.source);
    medicines.set(found.rxcui, m);
  }
  return { medicines: [...medicines.values()], notChecked };
}

// Steps 4 and 5. The spelling "interactionsbyrxcuisex" is Scholz's.
async function checkOnce(config, rxcuis) {
  const reply = await scholz(config, 'interactionsbyrxcuisex', rxcuis.join(','));
  if (reply.code === '2') return [];
  if (reply.code === '1') return reply.body.InteractionListEx || [];
  throw scholzFailure('interaction check', reply);
}

// More than 30 medicines do not fit in one URL: split into chunks of 15 and
// check every pair of chunks, which covers every pair of medicines.
async function interactionRows(config, rxcuis) {
  if (rxcuis.length < 2) return [];
  if (rxcuis.length <= MAX_PER_CHECK) return checkOnce(config, rxcuis);
  const chunks = [];
  for (let i = 0; i < rxcuis.length; i += CHUNK_SIZE) chunks.push(rxcuis.slice(i, i + CHUNK_SIZE));
  const rows = [];
  for (let a = 0; a < chunks.length; a++) {
    for (let b = a + 1; b < chunks.length; b++) rows.push(...await checkOnce(config, [...chunks[a], ...chunks[b]]));
  }
  return rows;
}

// Step 6. 3 Serious, 2 Moderate, 1 Minor, or null for "do not show". The
// traffic light decides when Scholz sends one; otherwise Relevance does.
function severityOf(row) {
  const color = String(row.TrafficLightColor || '').trim().toLowerCase();
  if (color === 'green') return null;
  if (color) return color === 'red' ? 3 : color === 'yellow' ? 2 : 1;
  return { 5: 3, 4: 2, 3: 1 }[String(row.Relevance || '').trim()] || null;
}

// Step 6. Rows -> one conflict per interaction and set of drugs, keeping the
// most severe row. Members are matched to the patient's medicines by the
// Scholz drug code from step 3.
function toConflicts(rows, medicines) {
  const byDrugCode = new Map();
  for (const m of medicines) byDrugCode.set(m.drugCode, [...(byDrugCode.get(m.drugCode) || []), m]);

  const groups = new Map();
  for (const row of rows) {
    const severity = severityOf(row);
    if (!severity) continue;
    if (!row.InteractionCcode) throw upstream('Scholz returned an interaction without an InteractionCcode');
    const codes = [...new Set([1, 2, 3, 4].map((i) => row[`DrugCode${i}`]).filter(Boolean).map(String))];
    // Dropping the row here would hide a warning, so fail instead.
    const strangers = codes.filter((c) => !byDrugCode.has(c));
    if (strangers.length) {
      throw upstream(`Scholz reported an interaction for drug code ${strangers.join(', ')}, which matches none of the patient's medicines`);
    }
    const members = codes.flatMap((c) => byDrugCode.get(c));
    if (members.length < 2) continue;
    const key = `${row.InteractionCcode}|${[...codes].sort().join(',')}`;
    const kept = groups.get(key);
    if (kept && kept.severity >= severity) continue;
    groups.set(key, {
      interactionCode: String(row.InteractionCcode),
      severity,
      members,
      effect: row.EffLong || '',
      // CombiStatusText is cut at 50 characters; the dictionary has the full wording.
      whatToDo: combiStatusText[String(row.CombiStatus)] || row.CombiStatusText || '',
    });
  }
  return [...groups.values()].sort((a, b) => b.severity - a.severity);
}

// ---- DetectedIssue -----------------------------------------------------
const ISSUE_SEVERITY = { 3: 'high', 2: 'moderate', 1: 'low' };

// The spec's identifier is {patient}-{InteractionCcode}. Scholz can report
// the same interaction for two different pairs (lisinopril with naproxen and
// with ibuprofen), and those would overwrite each other, so in that case the
// RxCUIs are added to keep one record per pair.
function identifierValues(patientId, conflicts) {
  const perCode = new Map();
  for (const c of conflicts) perCode.set(c.interactionCode, (perCode.get(c.interactionCode) || 0) + 1);
  return conflicts.map((c) => {
    const pair = perCode.get(c.interactionCode) > 1 ? `-${c.members.map((m) => m.rxcui).sort().join('+')}` : '';
    return `${patientId}-${c.interactionCode}${pair}`;
  });
}

function toDetectedIssue(patientId, conflict, identifier, now) {
  return {
    resourceType: 'DetectedIssue',
    identifier: [{ system: ISSUE_SYSTEM, value: identifier }],
    status: 'final',
    code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'DRG', display: 'Drug Interaction Alert' }] },
    severity: ISSUE_SEVERITY[conflict.severity],
    patient: { reference: `Patient/${patientId}` },
    identifiedDateTime: now.toISOString(),
    implicated: conflict.members.flatMap((m) => m.sources).map((reference) => ({ reference })),
    detail: [conflict.effect, conflict.whatToDo].filter(Boolean).join(' | '),
  };
}

// Step 7. A repeat check updates the same records; pairs that are gone are
// set to cancelled. Returns the DetectedIssue reference for each conflict.
async function writeIssues(aidbox, patientId, conflicts, now) {
  const identifiers = identifierValues(patientId, conflicts);
  const references = [];
  for (const [i, conflict] of conflicts.entries()) {
    const saved = await aidbox.call(
      'PUT',
      `fhir/DetectedIssue?identifier=${encodeURIComponent(`${ISSUE_SYSTEM}|${identifiers[i]}`)}`,
      toDetectedIssue(patientId, conflict, identifiers[i], now),
    );
    if (!saved || !saved.id) throw upstream('Aidbox did not return the saved DetectedIssue');
    references.push(`DetectedIssue/${saved.id}`);
  }

  // DetectedIssue has no status search parameter in FHIR R4, so filter here.
  const current = new Set(identifiers);
  const existing = await aidbox.searchAll(`fhir/DetectedIssue?${new URLSearchParams({
    patient: `Patient/${patientId}`, identifier: `${ISSUE_SYSTEM}|`, _count: '100',
  })}`);
  for (const issue of existing) {
    const ours = (issue.identifier || []).find((x) => x.system === ISSUE_SYSTEM);
    if (issue.resourceType !== 'DetectedIssue' || !ours || issue.status !== 'final' || current.has(ours.value)) continue;
    await aidbox.call('PUT', `fhir/DetectedIssue/${encodeURIComponent(issue.id)}`, {
      ...issue,
      status: 'cancelled',
      ...(issue.implicated && { implicated: await survivingReferences(aidbox, issue.implicated) }),
    });
  }
  return references;
}

// A pair is usually gone because the patient removed a medicine, and Aidbox
// refuses to save a record that points at a deleted resource. A pointer to
// something deleted is kept as text instead.
async function survivingReferences(aidbox, references) {
  const out = [];
  for (const ref of references) {
    const checkable = /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(ref.reference || '');
    const alive = !checkable || await aidbox.call('GET', `fhir/${ref.reference}`, undefined, { missingOk: true });
    out.push(alive ? ref : { display: `${ref.reference} (deleted)` });
  }
  return out;
}

// ---- The two routes ----------------------------------------------------
// GET /patients/{id}/interactions
// Nothing is written to Aidbox until every Scholz call has succeeded.
async function checkInteractions(config, patientId, now = new Date()) {
  if (!FHIR_ID.test(patientId || '')) throw new DdiError(400, 'Not a valid patient id');
  requireConfig(config, Object.keys(ENV));
  const aidbox = aidboxClient(config);

  const entries = medicineEntries(await loadMedicineResources(aidbox, patientId));
  const { medicines, notChecked } = await resolveMedicines(config, entries);
  const conflicts = toConflicts(await interactionRows(config, medicines.map((m) => m.rxcui)), medicines);
  const references = await writeIssues(aidbox, patientId, conflicts, now);

  return {
    patient: `Patient/${patientId}`,
    medicines,
    conflicts: conflicts.map((c, i) => ({
      interactionCode: c.interactionCode,
      severity: c.severity,
      medicines: c.members.map((m) => m.rxcui),
      effect: c.effect,
      whatToDo: c.whatToDo,
      detectedIssue: references[i],
    })),
    notChecked,
  };
}

// Scholz text: "$" is a line break, "$$" a new paragraph.
function plainText(parts) {
  return [].concat(parts || []).join(' ')
    .replace(/\s*\$\$\s*/g, '\n\n')
    .replace(/\s*\$\s*/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// GET /patients/{id}/interactions/{interactionCode}. Step 8.
async function interactionFullText(config, interactionCode) {
  if (!DIGITS.test(interactionCode || '')) throw new DdiError(400, 'Not a valid interaction code');
  requireConfig(config, ['scholzUci']);
  const reply = await scholz(config, 'interactionfulltext', interactionCode);
  const text = (reply.body.InteractionFullTextList || [])[0];
  if (reply.code === '2' || (reply.code === '1' && !text)) throw new DdiError(404, 'No text for this interaction');
  if (reply.code !== '1') throw scholzFailure('full text', reply);
  return { interactionCode, mechanism: plainText(text.Mechanism), management: plainText(text.Management) };
}

module.exports = {
  checkInteractions, interactionFullText, configFromEnv, maskSecrets, DdiError,
  // For scripts/ that prepare data in Aidbox.
  aidboxClient,
  // For tests.
  severityOf, toConflicts, plainText, ISSUE_SYSTEM,
  clearCaches: () => {
    lookupCache.clear();
    tokenCache.clear();
    signIns.clear();
  },
};
