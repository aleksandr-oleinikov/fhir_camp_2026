# What the FHIR server holds

Surveyed 6 November 2026 against `https://fhir.medblocks.com/fhir/MyZCS3scyw4QDcq3BMJwY34i2KTn3P05`. Covers plan steps 1 and 2.

## The two patients

| | Epic patient | Medicare patient |
| --- | --- | --- |
| FHIR id | `erXuFYUfucBZaryVksYEcMg3` | `-10000010254618` |
| Name | Camila Maria Lopez, female, born 12 September 1987 | "Chi716 Greenfelder433", male, born 16 August 1999 |
| Shape | Epic R4 clinical record | CMS Blue Button 2.0 / CARIN Blue Button claims |
| Medicines from | `MedicationRequest` and `Medication` | `ExplanationOfBenefit` pharmacy claims (type PDE) |
| Diagnoses from | `Condition` | `ExplanationOfBenefit.diagnosis` |

**Both look synthetic** (question 9). Camila Lopez is the documented test patient in Epic's public sandbox. The Medicare patient has a negative beneficiary id, which Blue Button uses for synthetic beneficiaries, and a Synthea-style name with digits in it. Russ Gray to confirm before anything goes into the public demo.

## Resource counts

| Resource | Epic | Medicare |
| --- | --- | --- |
| MedicationRequest | 1 | 0 |
| Medication | 1 | 0 |
| MedicationStatement, MedicationDispense, MedicationAdministration | 0 | 0 |
| ExplanationOfBenefit | 0 | 155 (51 pharmacy, 83 outpatient, 10 carrier, 9 DME, 1 inpatient, 1 skilled nursing) |
| Condition | 13 | 0 |
| AllergyIntolerance | 1 ("Not on File") | 0 |
| Observation | 271 (mostly blood pressure, pulse, weight; one HbA1c) | 0 |
| Encounter, Procedure, Immunization, DiagnosticReport, ServiceRequest, CarePlan, DocumentReference | 5, 1, 1, 4, 3, 1, 10 | 0 |
| Coverage | 0 | 4 |
| Appointment | 0 | 0 |
| Practitioner, Organization, Location | 10, 3, 5 shared; no phone numbers on any of them | |

## Medicines

### Epic: one medicine

| Medicine | For | Instructions | Repeats |
| --- | --- | --- | --- |
| Drospirenone-ethinyl estradiol 3 mg / 0.02 mg tablet (a contraceptive pill) | Polycystic ovaries | Take 1 tablet by mouth 1 (one) time each day | 12 repeats of 28 tablets, written 28 May 2019, course ran to 27 May 2020, but status is still `active` |

### Medicare: five medicines, from 51 pharmacy claims

Claims carry only the NDC product code, mostly without a name. Names below come from looking each NDC up in RxNav (NLM). One NDC, `00427080094`, is not known to RxNav.

| Medicine (RxNorm) | Fills | First → last fill | Supply per fill |
| --- | --- | --- | --- |
| Lisinopril 10 mg tablet (some as Zestril) | 5 | 26 Oct 2020 → 18 Nov 2024 | 90 days |
| Dornase alfa 1 mg/mL inhalation solution (Pulmozyme) | 9 | 3 Oct 2016 → 18 Nov 2024 | 90 days |
| Hydrocodone 5 mg / paracetamol 300 mg tablet | 34 | 20 Sep 2017 → 18 Dec 2024 | 10 days, 40 tablets |
| Amoxicillin / clavulanate 250 mg / 125 mg tablet | 1 | 27 May 2016 | 7 days |
| Naproxen sodium 220 mg tablet | 1 | 25 Mar 2015 | 63 days |

Fills come in yearly bursts around October and November. The last supply ran out in early 2025, so nothing is current as of today (6 November 2026) unless we shift the dates.

## Diagnoses

**Epic `Condition`.** One problem-list item: polycystic ovaries, since 2005. Visit diagnoses from 2023: ischaemic chest pain (3 times), stomach ache, and pain aggravated by daily activities. Six more are nursing care-plan problems ("Safety Adult – Fall", "Discharge Planning") and are not diagnoses; filter on `category = problem-list-item | encounter-diagnosis`.

**Medicare claim diagnoses (ICD-10-CM).** These are the clinically meaningful ones, by number of claims they appear on:

- Type 2 diabetes (104), hypertriglyceridaemia (104), anaemia (104), chronic sinusitis (104)
- Pseudomonas infection (102), cystic fibrosis (97 + 57)
- Diabetes due to an underlying condition (50), metabolic syndrome (40), essential hypertension (34)
- Low back pain / lumbago (33), male infertility (42), herpes gingivostomatitis (7), acute sinusitis (1)

The rest are noise for this app and must be filtered out before display:
- external-cause codes (falls, vehicle accidents, insect bites: ICD-10 chapters V to Y)
- social-circumstance Z codes
- 85 diagnoses with no code system
- **maltreatment and assault codes (T74, Y04, Y07)**: sensitive, never show these on a medicines screen

There is also "neonatal hypertension" on an adult, an artefact of the synthetic data.

## Mapping onto the screen fields

| Screen field | Epic | Medicare | Gap |
| --- | --- | --- | --- |
| `medication` | `medicationReference.display` or `Medication.code.text` | NDC → RxNorm name via lookup | Medicare needs the lookup done at build time, or names stored with the snapshot |
| `strength` | Inside the name ("3-0.02 MG per tablet") | Inside the RxNorm name | Not a separate field; split it from the name or show the whole name |
| `ingredients` (for conflicts) | Not populated (`ingredient.itemCodeableConcept` only repeats the name); RxNorm codes are present | From RxNorm (RxNav `related?tty=IN`) | Needs an RxNorm → ingredient lookup for both |
| `reason` | `reasonCode.text` | None: claim diagnoses are not linked to a drug | Medicare medicines have no "For …" line |
| `requester` | `requester.display` is just "Physician" | Prescriber on claim, not checked | Neither gives a usable name |
| `requesterPhone` | None | None | **No phone numbers anywhere.** The conflict screen's call buttons need a fallback, for example "Call your surgery" with the practice number from config |
| `dosageInstruction` | `dosageInstruction[0].patientInstruction` | None; only quantity and days' supply | Medicare could show "40 tablets for 10 days" |
| `repeat.nextDue` | Can be worked out from `authoredOn` + 28 days × repeats; no dispense history | Last fill date + days' supply | Both point to dates years in the past |
| status `active` | `status` | No status; infer from last fill + supply | Epic says active but the course ended in 2020 |

## What this means for the demo

1. **On its own, the real data shows no conflicts.** Camila has one medicine. The Medicare patient's medicines never overlap in a way our rules cover (naproxen in 2015, lisinopril from 2020).
2. **The Medicare patient is a good base for the wireframe story.** Lisinopril works like ramipril, so if the patient adds Advil or Aleve through "Add a medicine", that should give a moderate warning once we add lisinopril rules, matched on ingredient. Hydrocodone/paracetamol plus Tylenol is a paracetamol double-dose, which is a strong warning to show.
3. **Dates need shifting.** The latest fills are from late 2024. Either shift every date so the latest fill lands just before `TODAY`, or show past medicines as "Not taken recently".
4. **Fall back for missing data:** no phone numbers, no prescriber names, no reason on Medicare medicines.
5. **Paging bug:** the server's `next` links return 401. Fetch with a `_count` large enough to get everything in one page (271 is the biggest set).
