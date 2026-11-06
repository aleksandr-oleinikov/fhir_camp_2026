// Over-the-counter medicines offered on the "Add a medicine" screen.
// `ingredients` are the active ingredients, lower case, used to check for
// conflicts in data/interactions.js. Wording and mapping need clinical review.
//
// `rxcui` and `rxnorm` are the RxNorm code and name saved with the medicine,
// so the drug interaction check (lib/ddi.js) can use it. RxNorm codes are for
// one strength and form, and the list does not ask for either, so each entry
// uses a common adult over-the-counter strength. Looked up in RxNav (NLM) on
// 6 November 2026. The choice of strength needs clinical review too.

module.exports = [
  { id: 'advil', name: 'Advil', contains: 'ibuprofen', ingredients: ['ibuprofen'], rxcui: '310965', rxnorm: 'ibuprofen 200 MG Oral Tablet' },
  { id: 'aleve', name: 'Aleve', contains: 'naproxen', ingredients: ['naproxen'], rxcui: '849574', rxnorm: 'naproxen sodium 220 MG Oral Tablet' },
  { id: 'aspirin', name: 'Aspirin', contains: 'aspirin', ingredients: ['aspirin'], rxcui: '212033', rxnorm: 'aspirin 325 MG Oral Tablet' },
  { id: 'benadryl', name: 'Benadryl', contains: 'diphenhydramine', ingredients: ['diphenhydramine'], rxcui: '1049630', rxnorm: 'diphenhydramine hydrochloride 25 MG Oral Tablet' },
  { id: 'claritin-d', name: 'Claritin-D', contains: 'loratadine and pseudoephedrine', ingredients: ['loratadine', 'pseudoephedrine'], rxcui: '1242399', rxnorm: '12 HR loratadine 5 MG / pseudoephedrine sulfate 120 MG Extended Release Oral Tablet' },
  { id: 'paracetamol', name: 'Paracetamol', contains: 'paracetamol', ingredients: ['paracetamol'], rxcui: '198440', rxnorm: 'acetaminophen 500 MG Oral Tablet' },
  { id: 'pepcid-ac', name: 'Pepcid AC', contains: 'famotidine', ingredients: ['famotidine'], rxcui: '199047', rxnorm: 'famotidine 10 MG Oral Tablet' },
  { id: 'potassium', name: 'Potassium', contains: 'potassium', ingredients: ['potassium'], rxcui: '240060', rxnorm: 'potassium gluconate 2.5 MEQ Oral Tablet' },
  { id: 'robitussin', name: 'Robitussin', contains: 'dextromethorphan and guaifenesin', ingredients: ['dextromethorphan', 'guaifenesin'], rxcui: '996520', rxnorm: 'dextromethorphan hydrobromide 2 MG/ML / guaifenesin 20 MG/ML Oral Solution' },
  { id: 'sudafed', name: 'Sudafed', contains: 'pseudoephedrine', ingredients: ['pseudoephedrine'], rxcui: '1049160', rxnorm: 'pseudoephedrine hydrochloride 30 MG Oral Tablet' },
  { id: 'tagamet', name: 'Tagamet', contains: 'cimetidine', ingredients: ['cimetidine'], rxcui: '197505', rxnorm: 'cimetidine 200 MG Oral Tablet' },
  { id: 'tylenol', name: 'Tylenol', contains: 'paracetamol (called acetaminophen in the US)', ingredients: ['paracetamol'], rxcui: '313782', rxnorm: 'acetaminophen 325 MG Oral Tablet' },
  { id: 'zyrtec', name: 'Zyrtec', contains: 'cetirizine', ingredients: ['cetirizine'], rxcui: '1014678', rxnorm: 'cetirizine hydrochloride 10 MG Oral Tablet' },
];
