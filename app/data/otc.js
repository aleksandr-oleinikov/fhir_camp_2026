// Over-the-counter medicines offered on the "Add a medicine" screen.
// `ingredients` are the active ingredients, lower case, used to check for
// conflicts in data/interactions.js. `form` picks the icon shown beside it.
// Wording and mapping need clinical review.

module.exports = [
  { id: 'advil', name: 'Advil', contains: 'ibuprofen', ingredients: ['ibuprofen'], form: 'tablet' },
  { id: 'aleve', name: 'Aleve', contains: 'naproxen', ingredients: ['naproxen'], form: 'tablet' },
  { id: 'aspirin', name: 'Aspirin', contains: 'aspirin', ingredients: ['aspirin'], form: 'tablet' },
  { id: 'benadryl', name: 'Benadryl', contains: 'diphenhydramine', ingredients: ['diphenhydramine'], form: 'tablet' },
  { id: 'claritin-d', name: 'Claritin-D', contains: 'loratadine and pseudoephedrine', ingredients: ['loratadine', 'pseudoephedrine'], form: 'tablet' },
  { id: 'paracetamol', name: 'Paracetamol', contains: 'paracetamol', ingredients: ['paracetamol'], form: 'tablet' },
  { id: 'pepcid-ac', name: 'Pepcid AC', contains: 'famotidine', ingredients: ['famotidine'], form: 'tablet' },
  { id: 'potassium', name: 'Potassium', contains: 'potassium', ingredients: ['potassium'], form: 'tablet' },
  { id: 'robitussin', name: 'Robitussin', contains: 'dextromethorphan and guaifenesin', ingredients: ['dextromethorphan', 'guaifenesin'], form: 'liquid' },
  { id: 'sudafed', name: 'Sudafed', contains: 'pseudoephedrine', ingredients: ['pseudoephedrine'], form: 'tablet' },
  { id: 'tagamet', name: 'Tagamet', contains: 'cimetidine', ingredients: ['cimetidine'], form: 'tablet' },
  { id: 'tylenol', name: 'Tylenol', contains: 'paracetamol (called acetaminophen in the US)', ingredients: ['paracetamol'], form: 'tablet' },
  { id: 'zyrtec', name: 'Zyrtec', contains: 'cetirizine', ingredients: ['cetirizine'], form: 'tablet' },
];
