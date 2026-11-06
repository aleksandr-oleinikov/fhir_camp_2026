// Drug interaction checks against a fake Aidbox and a fake Scholz DataBank.
// No network. Scholz replies are shaped like its published response types
// (every value a string) and follow docs/ddi-backend.md section 6. The drug
// code Y23723 and interaction 38010552 come from there; the other Scholz
// codes and texts are made up for the tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const ddi = require('../lib/ddi');

const PATIENT = 'pt-1';
const UCI = 'secret-uci-123';
const config = { aidboxUrl: 'https://aidbox.test', aidboxClientId: 'ddi', aidboxClientSecret: 'hunter2', scholzUci: UCI };
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const NOW = new Date('2026-11-06T10:00:00Z');

const DRUGS = {
  314076: { DrugCode: 'Y23723', DrugName: 'lisinopril 10 MG Oral Tablet' },
  849574: { DrugCode: 'Y30001', DrugName: 'naproxen sodium 220 MG Oral Tablet' },
  310965: { DrugCode: 'Y30002', DrugName: 'ibuprofen 200 MG Oral Tablet' },
  198211: { DrugCode: 'Y30003', DrugName: 'simvastatin 40 MG Oral Tablet' },
  197853: { DrugCode: 'Y30004', DrugName: 'ketoconazole 200 MG Oral Tablet' },
};

// Scholz answers these with ErrorCode 8 "RXCUI is not valid" instead of 2.
const REJECTED_RXCUIS = ['4124'];

const aceNsaid = (other) => ({
  DrugCode1: 'Y23723', DrugCode2: other, DrugCode3: '', DrugCode4: '',
  InteractionCcode: '38010552', CombiStatus: '3', CombiStatusText: 'only with careful monitoring; dose adjustment if n',
  EffLong: 'blood pressure lowering decreased, crea. a. potass.up, risk of renal failure',
  Relevance: '4', TrafficLightColor: 'yellow',
});
const INTERACTIONS = [
  aceNsaid('Y30001'),
  // The same pair again at a lower level: only the more severe row is kept.
  { ...aceNsaid('Y30001'), Relevance: '3', TrafficLightColor: 'gray', EffLong: 'minor variant' },
  aceNsaid('Y30002'),
  {
    DrugCode1: 'Y30003', DrugCode2: 'Y30004', InteractionCcode: '40010501', CombiStatus: '1', CombiStatusText: 'contraindicated',
    EffLong: 'risk of myopathy', Relevance: '5', TrafficLightColor: 'red',
  },
];

const request = (id, rxcui, extra = {}) => ({
  resourceType: 'MedicationRequest', id, status: 'active', subject: { reference: `Patient/${PATIENT}` },
  medicationCodeableConcept: { coding: [{ system: RXNORM, code: rxcui }], text: `medicine ${rxcui}` }, ...extra,
});
const statement = (id, concept) => ({
  resourceType: 'MedicationStatement', id, status: 'active', subject: { reference: `Patient/${PATIENT}` },
  medicationCodeableConcept: concept,
});

// store: { MedicationRequest: [], MedicationStatement: [], Medication: [] }
function fakeBackends(store, { drugs = DRUGS, interactions = INTERACTIONS, scholzDown = false, htmlForKey = false, pageSize = 100, refuseIssues = null } = {}) {
  const issues = [];
  const calls = [];
  const tokens = { issued: 0, valid: null }; // only the latest access token is accepted
  let nextId = 1;
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const scholz = (code, extra = {}) => reply(200, { ResponseStatus: { ErrorCode: String(code) }, ...extra });

  async function fetch(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    calls.push(`${method} ${u.host}${u.pathname}${u.search}`);

    if (u.host === 'rest.scholzdatabank.com') {
      if (scholzDown) throw new Error(`connect ETIMEDOUT while calling ${url}`);
      const [fn, uci, arg] = u.pathname.split('/').slice(2).map(decodeURIComponent);
      if (uci !== UCI) return htmlForKey ? reply(200, '<html>please register</html>') : scholz(8, { ResponseStatus: { ErrorCode: '8', Message: `Problem at Input Level:${uci} : UCI is not valid...` } });
      const badRxcui = { ResponseStatus: { ErrorCode: '8', Message: 'Entered RXCUI is not valid,please enter valid RXCUI..' }, DrugList: [{}] };
      if (fn === 'distinctdrugsbyrxcui') {
        if (arg.includes(',') || REJECTED_RXCUIS.includes(arg)) return scholz(8, badRxcui);
        return drugs[arg] ? scholz(1, { DrugList: [{ RXcui: arg, ...drugs[arg] }] }) : scholz(2, { DrugList: [] });
      }
      if (fn === 'interactionsbyrxcuisex') {
        if (arg.split(',').some((rxcui) => REJECTED_RXCUIS.includes(rxcui))) return scholz(8, badRxcui);
        const sent = new Set(arg.split(',').map((rxcui) => drugs[rxcui] && drugs[rxcui].DrugCode));
        const rows = interactions.filter((r) => sent.has(r.DrugCode1) && sent.has(r.DrugCode2));
        return rows.length ? scholz(1, { InteractionListEx: rows }) : scholz(2, { InteractionListEx: [] });
      }
      if (fn === 'interactionfulltext') {
        return arg === '38010552'
          ? scholz(1, { InteractionFullTextList: [{ InteractionCode: arg, Mechanism: ['NSAIDs reduce prostaglandins.$Less blood flow to the kidney.'], Management: ['Check blood pressure.$$Check kidney function.', 'Avoid long courses.'] }] })
          : scholz(2, { InteractionFullTextList: [] });
      }
      return reply(404, '');
    }

    if (u.host !== 'aidbox.test') throw new Error(`unexpected host ${u.host}`);
    if (method === 'POST' && u.pathname === '/auth/token') {
      const sent = JSON.parse(opts.body);
      if (sent.grant_type !== 'client_credentials' || sent.client_id !== 'ddi' || sent.client_secret !== 'hunter2') return reply(401, {});
      tokens.valid = `token-${tokens.issued += 1}`;
      return reply(200, { token_type: 'Bearer', access_token: tokens.valid, expires_in: 3600 });
    }
    if ((opts.headers || {}).Authorization !== `Bearer ${tokens.valid}`) return reply(401, {});
    const [, type, id] = u.pathname.split('/').slice(1);
    const bundle = (list) => ({ resourceType: 'Bundle', entry: list.map((resource) => ({ resource })) });
    const exists = (reference) => {
      const [refType, refId] = String(reference).split('/');
      return (store[refType] || []).some((r) => r.id === refId);
    };
    // Like Aidbox: a record that points at a resource that is not there is refused.
    const dangling = (issue) => (issue.implicated || []).map((x) => x.reference).filter((ref) => ref && !exists(ref));
    const refuse = (refs) => reply(422, { resourceType: 'OperationOutcome', issue: [{ severity: 'fatal', code: 'invalid', diagnostics: `Referenced resource ${refs[0]} does not exist` }] });

    if (method === 'GET' && id && (type === 'MedicationRequest' || type === 'MedicationStatement')) {
      return exists(`${type}/${id}`) ? reply(200, store[type].find((r) => r.id === id)) : reply(410, {});
    }

    if (method === 'GET' && (type === 'MedicationRequest' || type === 'MedicationStatement')) {
      assert.equal(u.searchParams.get('subject'), `Patient/${PATIENT}`);
      assert.equal(u.searchParams.get('status'), 'active');
      assert.equal(u.searchParams.get('_include'), `${type}:medication`);
      const all = (store[type] || []).filter((r) => r.status === 'active');
      const page = Number(u.searchParams.get('page') || 1);
      const slice = all.slice((page - 1) * pageSize, page * pageSize);
      const out = bundle([...slice, ...(store.Medication || [])]);
      if (page * pageSize < all.length) {
        // Aidbox behind a proxy can hand out links on an internal host.
        const next = new URL(`http://aidbox-internal:8080${u.pathname}${u.search}`);
        next.searchParams.set('page', String(page + 1));
        out.link = [{ relation: 'next', url: next.toString() }];
      }
      return reply(200, out);
    }
    if (type === 'DetectedIssue' && method === 'PUT' && !id) {
      const [system, value] = u.searchParams.get('identifier').split('|');
      const body = JSON.parse(opts.body);
      if (refuseIssues) return reply(422, { resourceType: 'OperationOutcome', issue: [{ severity: 'fatal', code: 'invalid', diagnostics: refuseIssues }] });
      if (dangling(body).length) return refuse(dangling(body));
      const i = issues.findIndex((x) => x.identifier.some((y) => y.system === system && y.value === value));
      const saved = { ...body, id: i >= 0 ? issues[i].id : `di${nextId++}` };
      if (i >= 0) issues[i] = saved; else issues.push(saved);
      return reply(i >= 0 ? 200 : 201, saved);
    }
    if (type === 'DetectedIssue' && method === 'PUT') {
      const i = issues.findIndex((x) => x.id === id);
      if (dangling(JSON.parse(opts.body)).length) return refuse(dangling(JSON.parse(opts.body)));
      issues[i] = { ...JSON.parse(opts.body), id };
      return reply(200, issues[i]);
    }
    if (type === 'DetectedIssue' && method === 'GET') {
      return reply(200, bundle(issues.filter((x) => x.patient.reference === u.searchParams.get('patient'))));
    }
    return reply(400, {});
  }
  global.fetch = fetch;
  const scholzCalls = (fn) => calls.filter((c) => c.includes(`/ditwebservices/${fn}/`));
  const writes = () => calls.filter((c) => c.startsWith('PUT '));
  const signIns = () => calls.filter((c) => c.endsWith('/auth/token'));
  return { issues, calls, scholzCalls, writes, signIns, tokens };
}

test.beforeEach(() => ddi.clearCaches());

test('signs in to Aidbox with client credentials, once, and again when the token stops working', async () => {
  const store = { MedicationRequest: [request('mr1', '314076'), request('mr2', '849574')] };
  const backends = fakeBackends(store);

  await ddi.checkInteractions(config, PATIENT, NOW);
  await ddi.checkInteractions(config, PATIENT, NOW);
  assert.equal(backends.signIns().length, 1, 'the token is reused');

  backends.tokens.valid = 'revoked';
  const result = await ddi.checkInteractions(config, PATIENT, NOW);
  assert.equal(backends.signIns().length, 2, 'a 401 leads to one new sign-in');
  assert.equal(result.conflicts.length, 1);

  ddi.clearCaches();
  await assert.rejects(ddi.checkInteractions({ ...config, aidboxClientSecret: 'wrong' }, PATIENT, NOW), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /sign-in returned HTTP 401; check AIDBOX_CLIENT_ID and AIDBOX_CLIENT_SECRET/);
    assert.doesNotMatch(e.message, /wrong/);
    return true;
  });
});

test('finds the lisinopril and naproxen pair and records it as a DetectedIssue', async () => {
  const backends = fakeBackends({
    MedicationRequest: [
      { resourceType: 'MedicationRequest', id: 'mr1', status: 'active', medicationReference: { reference: 'Medication/med1' } },
    ],
    // Like Epic: codes Scholz cannot use sit next to the product code. It
    // answers the first with ErrorCode 8 and the second with ErrorCode 2.
    Medication: [{ resourceType: 'Medication', id: 'med1', code: { text: 'lisinopril', coding: [{ system: RXNORM, code: '4124' }, { system: RXNORM, code: '29046' }, { system: RXNORM, code: '314076' }] } }],
    MedicationStatement: [
      statement('ms1', { coding: [{ system: RXNORM, code: '849574' }], text: 'Aleve' }),
      statement('ms2', { text: 'Advil' }),
      statement('ms3', { coding: [{ system: RXNORM, code: '36567' }], text: 'Simvastatin' }),
      statement('ms4', { coding: [{ system: RXNORM, code: '4124' }], text: 'Ethinyl estradiol' }),
    ],
  });

  const result = await ddi.checkInteractions(config, PATIENT, NOW);

  assert.equal(result.patient, `Patient/${PATIENT}`);
  assert.deepEqual(result.medicines, [
    { rxcui: '314076', name: 'lisinopril 10 MG Oral Tablet', drugCode: 'Y23723', sources: ['MedicationRequest/mr1'] },
    { rxcui: '849574', name: 'naproxen sodium 220 MG Oral Tablet', drugCode: 'Y30001', sources: ['MedicationStatement/ms1'] },
  ]);
  assert.deepEqual(result.conflicts, [{
    interactionCode: '38010552',
    severity: 2,
    medicines: ['314076', '849574'],
    effect: 'blood pressure lowering decreased, crea. a. potass.up, risk of renal failure',
    whatToDo: 'only with careful monitoring; dose adjustment if n',
    detectedIssue: 'DetectedIssue/di1',
  }]);
  assert.deepEqual(result.notChecked, [
    { source: 'MedicationStatement/ms2', name: 'Advil', reason: 'no RxNorm code' },
    { source: 'MedicationStatement/ms3', name: 'Simvastatin', reason: 'RxNorm code not known to Scholz' },
    { source: 'MedicationStatement/ms4', name: 'Ethinyl estradiol', reason: 'RxNorm code not known to Scholz' },
  ]);

  assert.deepEqual(backends.issues, [{
    resourceType: 'DetectedIssue',
    id: 'di1',
    identifier: [{ system: 'urn:fhir-camp-2026:scholz-interaction', value: `${PATIENT}-38010552` }],
    status: 'final',
    code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'DRG', display: 'Drug Interaction Alert' }] },
    severity: 'moderate',
    patient: { reference: `Patient/${PATIENT}` },
    identifiedDateTime: '2026-11-06T10:00:00.000Z',
    implicated: [{ reference: 'MedicationRequest/mr1' }, { reference: 'MedicationStatement/ms1' }],
    detail: 'blood pressure lowering decreased, crea. a. potass.up, risk of renal failure | only with careful monitoring; dose adjustment if n',
  }]);
  // Only codes Scholz knows are sent to the check.
  assert.match(backends.scholzCalls('interactionsbyrxcuisex')[0], /\/314076,849574\?format=json$/);
});

test('a repeat check updates the record, and a pair that is gone is cancelled', async () => {
  const store = { MedicationRequest: [request('mr1', '314076')], MedicationStatement: [statement('ms1', { coding: [{ system: RXNORM, code: '849574' }] })] };
  const backends = fakeBackends(store);

  await ddi.checkInteractions(config, PATIENT, NOW);
  const again = await ddi.checkInteractions(config, PATIENT, new Date('2026-11-07T10:00:00Z'));
  assert.equal(backends.issues.length, 1, 'no duplicate');
  assert.equal(again.conflicts[0].detectedIssue, 'DetectedIssue/di1');
  assert.equal(backends.issues[0].identifiedDateTime, '2026-11-07T10:00:00.000Z');
  assert.equal(backends.scholzCalls('distinctdrugsbyrxcui').length, 2, 'lookups are cached by RxCUI');

  store.MedicationStatement[0].status = 'stopped';
  const after = await ddi.checkInteractions(config, PATIENT, NOW);
  assert.deepEqual(after.conflicts, []);
  assert.equal(backends.issues[0].status, 'cancelled');
  assert.equal(backends.scholzCalls('interactionsbyrxcuisex').length, 2, 'one medicine left, so nothing to check');
});

test('a pair is cancelled even when the patient deleted the medicine', async () => {
  const store = { MedicationRequest: [request('mr1', '314076')], MedicationStatement: [statement('ms1', { coding: [{ system: RXNORM, code: '849574' }] })] };
  const backends = fakeBackends(store);
  await ddi.checkInteractions(config, PATIENT, NOW);

  store.MedicationStatement.length = 0; // "Reset the demo" deletes what the patient added
  const after = await ddi.checkInteractions(config, PATIENT, NOW);
  assert.deepEqual(after.conflicts, []);
  assert.equal(backends.issues[0].status, 'cancelled');
  assert.deepEqual(backends.issues[0].implicated, [
    { reference: 'MedicationRequest/mr1' },
    { display: 'MedicationStatement/ms1 (deleted)' },
  ], 'Aidbox refuses a pointer to a deleted resource, so it is kept as text');
});

test('an Aidbox refusal says why', async () => {
  fakeBackends({ MedicationRequest: [request('mr1', '314076'), request('mr2', '849574')] }, { refuseIssues: 'severity: unknown code' });
  await assert.rejects(ddi.checkInteractions(config, PATIENT, NOW), {
    status: 502, message: 'Aidbox PUT /fhir/DetectedIssue returned HTTP 422: severity: unknown code',
  });
});

test('the same medicine prescribed and bought is one medicine with both sources', async () => {
  const backends = fakeBackends({
    MedicationRequest: [request('mr1', '314076'), request('mr2', '849574')],
    MedicationStatement: [statement('ms1', { coding: [{ system: RXNORM, code: '849574' }] })],
  });
  const result = await ddi.checkInteractions(config, PATIENT, NOW);
  assert.deepEqual(result.medicines.map((m) => m.sources), [['MedicationRequest/mr1'], ['MedicationRequest/mr2', 'MedicationStatement/ms1']]);
  assert.deepEqual(backends.issues[0].implicated.map((x) => x.reference), ['MedicationRequest/mr1', 'MedicationRequest/mr2', 'MedicationStatement/ms1']);
});

test('one interaction code on two pairs gives two records, most serious first', async () => {
  const backends = fakeBackends({
    MedicationRequest: [request('mr1', '314076'), request('mr2', '849574'), request('mr3', '310965'), request('mr4', '198211'), request('mr5', '197853')],
  });
  const result = await ddi.checkInteractions(config, PATIENT, NOW);
  assert.deepEqual(result.conflicts.map((c) => [c.severity, c.medicines]), [
    [3, ['198211', '197853']],
    [2, ['314076', '849574']],
    [2, ['314076', '310965']],
  ]);
  assert.deepEqual(backends.issues.map((x) => [x.identifier[0].value, x.severity]), [
    [`${PATIENT}-40010501`, 'high'],
    [`${PATIENT}-38010552-314076+849574`, 'moderate'],
    [`${PATIENT}-38010552-310965+314076`, 'moderate'],
  ]);
});

test('a Scholz error or outage is a 502 and nothing is written', async () => {
  const store = { MedicationRequest: [request('mr1', '314076'), request('mr2', '849574')] };

  let backends = fakeBackends(store);
  await assert.rejects(ddi.checkInteractions({ ...config, scholzUci: 'wrong-key' }, PATIENT, NOW), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /ErrorCode 8 \(Problem at Input Level:\*\*\* : UCI is not valid\.\.\.\)/);
    assert.doesNotMatch(e.message, /wrong-key/, 'Scholz quotes the key back; it must not reach the reply');
    return true;
  });
  assert.deepEqual(backends.writes(), []);

  backends = fakeBackends(store, { htmlForKey: true });
  await assert.rejects(ddi.checkInteractions({ ...config, scholzUci: 'wrong-key' }, PATIENT, NOW), { status: 502, message: /did not return JSON/ });

  backends = fakeBackends(store, { scholzDown: true });
  await assert.rejects(ddi.checkInteractions(config, PATIENT, NOW), (e) => {
    assert.equal(e.status, 502);
    assert.doesNotMatch(e.message, new RegExp(UCI), 'the key is masked even when the network error quotes the URL');
    assert.match(e.message, /distinctdrugsbyrxcui\/\*\*\*\/314076/);
    return true;
  });
  assert.deepEqual(backends.writes(), []);
});

test('an interaction for a drug that was not sent fails instead of being dropped', async () => {
  fakeBackends({ MedicationRequest: [request('mr1', '314076'), request('mr2', '849574')] }, {
    interactions: [{ ...aceNsaid('Y30001'), DrugCode3: 'Y99999' }],
  });
  await assert.rejects(ddi.checkInteractions(config, PATIENT, NOW), { status: 502, message: /drug code Y99999/ });
});

test('more than 30 medicines are checked in chunks that cover every pair', async () => {
  const drugs = {};
  const requests = [];
  for (let i = 1; i <= 31; i++) {
    drugs[9000 + i] = { DrugCode: `Z${i}`, DrugName: `drug ${i}` };
    requests.push(request(`mr${i}`, String(9000 + i)));
  }
  // First and last medicine: they land in different chunks.
  const interactions = [{ DrugCode1: 'Z1', DrugCode2: 'Z31', InteractionCcode: '777', EffLong: 'x', Relevance: '5', TrafficLightColor: '' }];
  const backends = fakeBackends({ MedicationRequest: requests }, { drugs, interactions, pageSize: 20 });

  const result = await ddi.checkInteractions(config, PATIENT, NOW);
  assert.equal(result.medicines.length, 31, 'both pages were read');
  assert.ok(backends.calls.every((c) => !c.includes('aidbox-internal')), 'next links are re-pointed at AIDBOX_URL');
  assert.deepEqual(result.conflicts.map((c) => [c.severity, c.medicines]), [[3, ['9001', '9031']]]);

  const checks = backends.scholzCalls('interactionsbyrxcuisex').map((c) => c.split('/').pop().split('?')[0].split(','));
  assert.equal(checks.length, 3);
  assert.ok(checks.every((list) => list.length <= 30));
  const covered = new Set(checks.flatMap((list) => list.flatMap((a) => list.map((b) => `${a}-${b}`))));
  for (let a = 9001; a <= 9031; a++) for (let b = a + 1; b <= 9031; b++) assert.ok(covered.has(`${a}-${b}`), `${a} and ${b} checked together`);
});

test('severity comes from the traffic light, or from Relevance when there is none', () => {
  const sev = (TrafficLightColor, Relevance) => ddi.severityOf({ TrafficLightColor, Relevance });
  assert.equal(sev('red', '5'), 3);
  assert.equal(sev('Yellow', '4'), 2);
  assert.equal(sev('gray', '3'), 1);
  assert.equal(sev('green', '5'), null);
  assert.equal(sev('', '5'), 3);
  assert.equal(sev('', '4'), 2);
  assert.equal(sev('', '3'), 1);
  assert.equal(sev('', '2'), null);
  assert.equal(sev(undefined, '1'), null);
});

test('full text turns $ into line breaks and $$ into paragraphs', async () => {
  fakeBackends({});
  assert.deepEqual(await ddi.interactionFullText(config, '38010552'), {
    interactionCode: '38010552',
    mechanism: 'NSAIDs reduce prostaglandins.\nLess blood flow to the kidney.',
    management: 'Check blood pressure.\n\nCheck kidney function. Avoid long courses.',
  });
  await assert.rejects(ddi.interactionFullText(config, '123'), { status: 404 });
  await assert.rejects(ddi.interactionFullText(config, '../metadata'), { status: 400 });
});

test('bad input and missing settings are reported before anything is called', async () => {
  const backends = fakeBackends({});
  await assert.rejects(ddi.checkInteractions(config, 'a/b', NOW), { status: 400 });
  await assert.rejects(ddi.checkInteractions(ddi.configFromEnv({ AIDBOX_URL: 'https://aidbox.test' }), PATIENT, NOW), {
    status: 503, message: 'Not configured: set AIDBOX_CLIENT_ID, AIDBOX_CLIENT_SECRET, SCHOLZ_UCI',
  });
  assert.deepEqual(backends.calls, []);
  assert.equal(ddi.maskSecrets(config, `key ${UCI}, secret hunter2`), 'key ***, secret ***');
});
