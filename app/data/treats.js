// One word for what each medicine is mainly used for, shown as a tag on the
// medicines list. Keyed by active ingredient (lower case, UK names), as in
// data/interactions.js. Demo only: not clinically reviewed.

const byIngredient = {
  // Pain and inflammation
  paracetamol: 'Pain',
  ibuprofen: 'Pain',
  naproxen: 'Pain',
  aspirin: 'Pain',
  hydrocodone: 'Pain',
  // Blood pressure
  ramipril: 'Hypertension',
  lisinopril: 'Hypertension',
  amlodipine: 'Hypertension',
  // Cholesterol
  atorvastatin: 'Cholesterol',
  // Infections
  clarithromycin: 'Infection',
  amoxicillin: 'Infection',
  'clavulanic acid': 'Infection',
  // Stomach acid
  omeprazole: 'Heartburn',
  famotidine: 'Heartburn',
  cimetidine: 'Heartburn',
  // Allergies, colds and coughs
  diphenhydramine: 'Allergy',
  loratadine: 'Allergy',
  cetirizine: 'Allergy',
  pseudoephedrine: 'Congestion',
  dextromethorphan: 'Cough',
  guaifenesin: 'Cough',
  // Lungs (cystic fibrosis)
  'dornase alfa': 'Breathing',
  // Hormones
  drospirenone: 'Contraception',
  'ethinyl estradiol': 'Contraception',
  // Supplements
  potassium: 'Supplement',
  vitamin: 'Supplement',
};

// Used when no ingredient is known, from the "What do you take it for?" answer.
const byReason = [
  [/pain|ache|arthritis|migraine/i, 'Pain'],
  [/blood pressure|hypertension/i, 'Hypertension'],
  [/cholesterol/i, 'Cholesterol'],
  [/infection|antibiotic/i, 'Infection'],
  [/stomach|heartburn|indigestion|reflux/i, 'Heartburn'],
  [/hay ?fever|allerg|itch/i, 'Allergy'],
  [/cough/i, 'Cough'],
  [/cold|congest|blocked nose/i, 'Congestion'],
  [/sleep|insomnia/i, 'Sleep'],
  [/anxiety|depress|mood/i, 'Mood'],
  [/diabet|blood sugar/i, 'Diabetes'],
  [/asthma|breath|lung/i, 'Breathing'],
  [/vitamin|supplement|tired/i, 'Supplement'],
];

module.exports = { byIngredient, byReason };
