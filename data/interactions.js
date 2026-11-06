// Mock interaction rules. A conflict shows when both medicines are on the
// patient's active list. Matching is on the first word of the medicine name,
// case-insensitive. In production this would come from a clinical
// interaction checker, and the wording must be signed off clinically.

module.exports = [
  {
    id: 'ramipril-ibuprofen',
    severity: 2,
    medicines: ['ramipril', 'ibuprofen'],
    whatCouldHappen:
      'Ibuprofen can stop ramipril lowering your blood pressure as well as it should. Taking them together can also harm your kidneys.',
    whatToDo: [
      'Keep taking ramipril.',
      'Do not take any more ibuprofen until you have spoken to a pharmacist or your doctor.',
      'Ask them which painkiller is safe for you instead.',
    ],
  },
  {
    id: 'atorvastatin-clarithromycin',
    severity: 3,
    medicines: ['atorvastatin', 'clarithromycin'],
    whatCouldHappen:
      'Clarithromycin raises the amount of atorvastatin in your blood. This can cause muscle pain and, rarely, serious muscle damage.',
    whatToDo: [
      'Call your doctor’s surgery today. They may ask you to stop atorvastatin while you finish the clarithromycin.',
      'Do not stop either medicine until you have spoken to them.',
      'If your muscles ache or feel weak, call 111.',
    ],
  },
  {
    id: 'atorvastatin-amlodipine',
    severity: 1,
    medicines: ['atorvastatin', 'amlodipine'],
    whatCouldHappen:
      'Amlodipine can slightly raise the amount of atorvastatin in your blood. At your doses this is usually not a problem.',
    whatToDo: [
      'Keep taking both medicines as normal.',
      'If you get muscle aches you cannot explain, tell your doctor.',
    ],
  },
];
