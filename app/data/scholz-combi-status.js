// Full "what to do" wording for each Scholz CombiStatus code.
//
// Scholz sends CombiStatusText cut at 50 characters. The full wording is in
// the glossary of the Scholz DataBank manual, which is not in this repo, and
// the web service has no call that returns it. A code missing here falls back
// to the cut text (lib/ddi.js), so add the others from the manual.

module.exports = {
  // From the example response in docs/ddi-backend.md, section 4. Scholz sends
  // "only with careful monitoring; dose adjustment if n".
  4: 'only with careful monitoring; dose adjustment if needed',
};
