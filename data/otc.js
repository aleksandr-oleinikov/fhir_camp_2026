// Over-the-counter medicines offered on the "Add a medicine" screen.
// `ingredients` are the active ingredients, lower case, used to check for
// conflicts in data/interactions.js. Wording and mapping need clinical review.

module.exports = [
  { id: 'advil', name: 'Advil', contains: 'ibuprofen', ingredients: ['ibuprofen'] },
  { id: 'aleve', name: 'Aleve', contains: 'naproxen', ingredients: ['naproxen'] },
  { id: 'aspirin', name: 'Aspirin', contains: 'aspirin', ingredients: ['aspirin'] },
  { id: 'benadryl', name: 'Benadryl', contains: 'diphenhydramine', ingredients: ['diphenhydramine'] },
  { id: 'claritin-d', name: 'Claritin-D', contains: 'loratadine and pseudoephedrine', ingredients: ['loratadine', 'pseudoephedrine'] },
  { id: 'paracetamol', name: 'Paracetamol', contains: 'paracetamol', ingredients: ['paracetamol'] },
  { id: 'pepcid-ac', name: 'Pepcid AC', contains: 'famotidine', ingredients: ['famotidine'] },
  { id: 'potassium', name: 'Potassium', contains: 'potassium', ingredients: ['potassium'] },
  { id: 'robitussin', name: 'Robitussin', contains: 'dextromethorphan and guaifenesin', ingredients: ['dextromethorphan', 'guaifenesin'] },
  { id: 'sudafed', name: 'Sudafed', contains: 'pseudoephedrine', ingredients: ['pseudoephedrine'] },
  { id: 'tagamet', name: 'Tagamet', contains: 'cimetidine', ingredients: ['cimetidine'] },
  { id: 'tylenol', name: 'Tylenol', contains: 'paracetamol (called acetaminophen in the US)', ingredients: ['paracetamol'] },
  { id: 'zyrtec', name: 'Zyrtec', contains: 'cetirizine', ingredients: ['cetirizine'] },
];
