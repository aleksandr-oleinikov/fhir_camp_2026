// What the pages use when the local server has its settings: the patient's
// record in Aidbox, and the drug interaction check in lib/ddi.js (Aidbox and
// Scholz DataBank). The shape is defaultServices in lib/core.js.
//
// Server only. It signs in to Aidbox with the client secret, so it must never
// be required from lib/core.js or client/, which are bundled into the static
// demo.

const ddi = require('./ddi');
const fhir = require('./fhir');
const { practice } = require('../data/fhir-config');

function aidboxServices(config) {
  const aidbox = ddi.aidboxClient(config);

  // The two calls lib/fhir.js makes, pointed at Aidbox's FHIR API.
  const client = {
    call: (method, path, body) => aidbox.call(method, `fhir/${path}`, body),
    // Every page, in a fixed order. Paging without one can repeat rows.
    async search(type, params) {
      const found = await aidbox.searchAll(`fhir/${type}?${new URLSearchParams({ ...params, _sort: '_id', _count: '100' })}`);
      return [...new Map(found.map((r) => [`${r.resourceType}/${r.id}`, r])).values()];
    },
  };
  const record = { client, practice };

  return {
    loadRecord: (patientId, today) => fhir.loadRecord(record, patientId, today),
    addMedicine: (patientId, input) => fhir.addMedicine(record, patientId, input),
    removeDemoAdditions: (patientId) => fhir.removeDemoAdditions(record, patientId),
    checkInteractions: (patientId) => ddi.checkInteractions(config, patientId),
    interactionFullText: (interactionCode) => ddi.interactionFullText(config, interactionCode),
  };
}

// The services for these settings, or null when any setting is missing.
function fromEnv(env = process.env) {
  const config = ddi.configFromEnv(env);
  return Object.values(config).every(Boolean) ? aidboxServices(config) : null;
}

module.exports = { aidboxServices, fromEnv };
