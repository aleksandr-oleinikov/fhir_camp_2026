// Medicines on the FHIR server's Medicare pharmacy claims. Claims carry only
// an NDC product code, so names and active ingredients are kept here. Looked
// up in RxNav (NLM) on 6 November 2026; NDC 00427080094 is unknown to RxNav
// and left out. Ingredient names use UK spelling (paracetamol, not
// acetaminophen) so they match data/interactions.js.

const drugs = {
  lisinopril: { name: 'Lisinopril', strength: '10mg tablets', unit: 'tablets', ingredients: ['lisinopril'], rxcui: '314076' },
  pulmozyme: { name: 'Pulmozyme', strength: 'Dornase alfa 1mg/mL, breathed in through a nebuliser', unit: 'mL', ingredients: ['dornase alfa'], rxcui: '205532' },
  'hydrocodone-paracetamol': { name: 'Hydrocodone and paracetamol', strength: '5mg/300mg tablets', unit: 'tablets', ingredients: ['hydrocodone', 'paracetamol'], rxcui: '856987' },
  'co-amoxiclav': { name: 'Co-amoxiclav', strength: '250mg/125mg tablets', unit: 'tablets', ingredients: ['amoxicillin', 'clavulanic acid'], rxcui: '562251' },
  naproxen: { name: 'Naproxen', strength: '220mg tablets', unit: 'tablets', ingredients: ['naproxen'], rxcui: '849574' },
};

const ndc = {
  54458099710: 'lisinopril', 71335142601: 'lisinopril', 58016096302: 'lisinopril', 58016096369: 'lisinopril',
  53978100009: 'lisinopril', // sold as Zestril
  55154010000: 'pulmozyme', 11014070601: 'pulmozyme', 11014070610: 'pulmozyme', 50242010039: 'pulmozyme', 50242010040: 'pulmozyme',
  13107021199: 'hydrocodone-paracetamol', 13107021105: 'hydrocodone-paracetamol', 10702019250: 'hydrocodone-paracetamol',
  10702019210: 'hydrocodone-paracetamol', 10914055050: 'hydrocodone-paracetamol', 10914055001: 'hydrocodone-paracetamol',
  76519108103: 'hydrocodone-paracetamol', 27808011402: 'hydrocodone-paracetamol',
  53978010903: 'co-amoxiclav',
  68115025030: 'naproxen',
};

module.exports = { drugs, ndc };
