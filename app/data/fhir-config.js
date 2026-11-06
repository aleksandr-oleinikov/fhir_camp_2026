// FHIR server for the demo. The token is committed on purpose: the server and
// token exist only for this demo and hold synthetic data. Anyone with this
// repo, or the published demo, can read and write the store. Do not reuse
// this pattern with a real server.

module.exports = {
  baseUrl: 'https://fhir.medblocks.com/fhir/MyZCS3scyw4QDcq3BMJwY34i2KTn3P05',
  token:
    'eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJzaWRoYXJ0aEBtZWRibG9ja3MuY29tIiwidGVuYW50X2lkIjoiTXlaQ1Mzc2N5dzRRRGNxM0JNSndZMzRpMktUbjNQMDUiLCJyb2xlIjoiVEVOQU5UX1VTRVIiLCJpYXQiOjE3OTM5NjQ4MzksImV4cCI6MTg1NzAzNjgzOX0.fBb_D7B1OFDp6IKOMU7Vt0JKXAfkKTECGvh8lgIoMjqP20iWjN-89YMbCFXkZq_dAfp0Uxo75FQYQumrgfuXSg',

  // Buttons on the "Connect to payer" screen, in reading order (two columns,
  // as in the wireframe). Only those with a patient id lead anywhere.
  // logo: a file in public/, shown instead of the name. logoBg: tile colour
  // matching the logo's own background. logoFill: image spans the tile's width.
  payers: [
    { id: 'aetna', name: 'Aetna', logo: 'img/payers/aetna.webp' },
    { id: 'e-prescription', name: 'National E-prescription', logo: 'img/payers/e-prescription.webp' },
    { id: 'health-first', name: 'Health First', logo: 'img/payers/health-first.webp' },
    { id: 'nhs', name: 'NHS', logo: 'img/payers/nhs.webp', logoBg: '#005eb6' },
    { id: 'cigna', name: 'Cigna', logo: 'img/payers/cigna.webp', logoBg: '#0033ff' },
    { id: 'medicare', name: 'Blue Button CMS', detail: 'Medicare data', patientId: '-10000010254618', logo: 'img/payers/medicare.webp', logoBg: 'linear-gradient(90deg, #0b8fc2, #4d4fce)', logoFill: true },
    { id: 'epic', name: 'Epic', patientId: 'erXuFYUfucBZaryVksYEcMg3', logo: 'img/payers/epic.webp' },
  ],

  // FHIR has no phone numbers for prescribers, so call buttons use this.
  practice: { name: "your doctor's surgery", phone: '0113 496 0000' },
};
