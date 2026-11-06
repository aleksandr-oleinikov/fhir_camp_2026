# Drug interaction checks: backend

When the UI ([demo](https://aleksandr-oleinikov.github.io/fhir_camp_2026/)) asks, the service reads the patient's pharmacy `ExplanationOfBenefit` resources from Aidbox itself. It builds the list of medicines the patient takes now, checks the whole list in Scholz DataBank and returns the pairs that may not mix well.

## 1. Input

| Call | What it does |
| --- | --- |
| `GET /patients/{id}/interactions?asOf=YYYY-MM-DD` | Checks the medicine list. `asOf` is the date on which a medicine counts as current; defaults to today |
| `GET /patients/{id}/interactions/{interactionCode}` | Full text for one interaction, when the user opens the alert |

Environment variables: `AIDBOX_URL`, `AIDBOX_CLIENT_ID`, `AIDBOX_CLIENT_SECRET`, `SCHOLZ_UCI`.

## 2. Steps

Below, `SDB` = `https://rest.scholzdatabank.com/ditwebservices`. Every Scholz call gets `?format=json`.

1. **EOBs from Aidbox.** `GET {AIDBOX_URL}/fhir/ExplanationOfBenefit?patient=Patient/{id}&_count=100`, then follow `link` with `relation = next`. In code, keep EOBs whose `type.coding` has `http://terminology.hl7.org/CodeSystem/claim-type` with code `pharmacy` and whose `status` is neither `cancelled` nor `entered-in-error`.
2. **Fills.** From each `item` take:
   * the NDC from `productOrService.coding` with system `http://hl7.org/fhir/sid/ndc` (11 digits);
   * the fill date, `servicedDate`;
   * the days supply from the `supportingInfo` entry with `category.coding.code = dayssupply`, field `valueQuantity.value`.
3. **Current medicines.** A fill is current if `servicedDate <= asOf < servicedDate + daysSupply`. Fills of the same medicine collapse by RxCUI (step 4); the latest one goes into the response.
4. **NDC to RxCUI.** `GET https://rxnav.nlm.nih.gov/REST/ndcstatus.json?ndc={ndc}`, field `ndcStatus.rxcui`. Do not use `rxcui.json?idtype=NDC`: it returns nothing for NDCs that are off the market, and in the CMS Blue Button export 13 of 22 NDCs are. If the status is `UNKNOWN` or `rxcui` is empty, the medicine goes into `notChecked`.
5. **Code level.** `GET https://rxnav.nlm.nih.gov/REST/rxcui/{rxcui}/properties.json`; `properties.tty` must be `SCD` or `SBD`. Scholz does not accept ingredient RxCUIs.
6. **Is the medicine in Scholz.** `GET {SDB}/distinctdrugsbyrxcui/{UCI}/{rxcui}`. On `ErrorCode = 1`, keep `DrugList[0].DrugCode` (a Scholz code such as `Y23723`) and `DrugName`. On `ErrorCode = 2`, the medicine goes into `notChecked`. This step is required: for an unknown RxCUI the interaction check returns no error but `ErrorCode = 2`, meaning "no interactions", which is a false answer.
7. **Check.** If 2 or more medicines were found: `GET {SDB}/interactionsbyrxcuisex/{UCI}/{rxcui1},{rxcui2},...`. The request carries the whole list of current medicines. The function name is spelled exactly like this, with the `s`.
8. **Status.** HTTP is always 200; `ResponseStatus.ErrorCode` decides the result: `1` means interactions found, `2` means none, `8` means bad input or no access. On `8` and on a network error the service writes nothing and returns `502` to the UI, not an empty list.
9. **Parsing `InteractionListEx`.**
   * The pair's members are the non-empty `DrugCode1..4`. They are matched to the patient's medicines by the `DrugCode` from step 6.
   * One pair can come back as several rows (different frequency, dose thresholds). Rows are grouped by `InteractionCcode` and the set of `DrugCode`s; the row with the highest `severity` stays.
   * `severity` for the UI: `TrafficLightColor` `red` → 3, `yellow` → 2, any other non-empty color except `green` → 1. The color can be empty; then use `Relevance`: 5 → 3, 4 → 2, 3 → 1. `Relevance` 1 and 2 and the color `green` are not shown.
10. **Writing to Aidbox.** Each pair in `conflicts` is written as a `DetectedIssue` (section 4) with a conditional update: `PUT {AIDBOX_URL}/fhir/DetectedIssue?identifier=urn:fhir-camp-2026:scholz-interaction|{id}-{InteractionCcode}`. A repeat check updates the record instead of creating a duplicate. This patient's `DetectedIssue`s with status `final` that are missing from the new result are set to `cancelled`.
11. **Full text.** `GET {SDB}/interactionfulltext/{UCI}/{InteractionCcode}` is called only from the second route. `InteractionFullTextList[0].Mechanism` and `.Management` come as arrays of strings; `$` in the text is a line break, `$$` a new paragraph.

## 3. Cases

| Case | What Scholz or RxNav returns | What the backend does |
| --- | --- | --- |
| No interactions | `ErrorCode = 2`, empty list | `conflicts: []`; older `DetectedIssue`s are set to `cancelled` |
| RxCUI unknown to Scholz | No error: `ErrorCode = 2`, as if there were no interactions | Caught at step 6, medicine in `notChecked` |
| Ingredient RxCUI (`tty = IN`) | `ErrorCode = 8`, "Entered RXCUI is not valid" | Caught at step 5, medicine in `notChecked` |
| NDC off the market | RxNav `ndcstatus`: `OBSOLETE` with an RxCUI | Use the RxCUI from `ndcstatus` |
| NDC unknown to RxNav | `ndcstatus`: `UNKNOWN`, empty RxCUI | Medicine in `notChecked`; example: `00427080094` |
| Empty `TrafficLightColor` | `""` | `severity` from `Relevance` |
| Key has no access | `ErrorCode = 8`, "Entered UCI doesn't have privileges" | `502`, reason in the log |
| Network error or timeout | No response | `502`, nothing written to Aidbox |
| More than 30 medicines | URL longer than 324 characters; at 394 characters Scholz returns HTTP 400 | Split the list into chunks of 15 and check every pair of chunks |

## 4. Response for the UI and `DetectedIssue`

Response of the first route:

```json
{
  "patient": "Patient/{id}",
  "asOf": "2024-12-18",
  "medicines": [
    { "rxcui": "314076", "name": "lisinopril 10 MG Oral Tablet", "lastFill": "2024-11-18", "daysSupply": 90, "eob": "ExplanationOfBenefit/{eobId}" }
  ],
  "conflicts": [
    {
      "interactionCode": "38010552",
      "severity": 2,
      "medicines": ["314076", "849574"],
      "effect": "blood pressure lowering decreased, crea. a. potass.up, risk of renal failure",
      "whatToDo": "only with careful monitoring; dose adjustment if needed",
      "detectedIssue": "DetectedIssue/{diId}"
    }
  ],
  "notChecked": [{ "ndc": "00427080094", "reason": "NDC unknown to RxNorm" }]
}
```

`severity` matches the UI legend: 3 Serious, 2 Moderate, 1 Minor. `effect` comes from `EffLong`. `whatToDo` comes from `CombiStatusText`, but that field is cut at 50 characters, so take the full wording by the `CombiStatus` code from the dictionary in the Scholz manual's glossary.

`DetectedIssue` fields:

| Field | Value |
| --- | --- |
| `identifier` | system `urn:fhir-camp-2026:scholz-interaction`, value `{id}-{InteractionCcode}` |
| `status` | `final`; `cancelled` when the pair is gone on a repeat check |
| `code` | `http://terminology.hl7.org/CodeSystem/v3-ActCode`, code `DRG`, display `Drug Interaction Alert` |
| `severity` | 3 → `high`, 2 → `moderate`, 1 → `low` |
| `patient` | `Patient/{id}` |
| `identifiedDateTime` | time of the check |
| `implicated` | the `ExplanationOfBenefit` of the latest fill of each medicine in the pair |
| `detail` | `EffLong` and `whatToDo` joined with ` \| ` |

## 5. Key and limits

* The UCI (Scholz customer key) goes straight into the URL path. It is read from `SCHOLZ_UCI` and replaced with `***` in logs. This repository is public: never commit the key or Aidbox secrets.
* Scholz calls go over `https` only.
* URL length: 30 RxCUIs (324 characters) pass, 40 RxCUIs (394 characters) return HTTP 400.

## 6. Test requests

| RxCUIs sent to `interactionsbyrxcuisex` | Expected result |
| --- | --- |
| `198211,197853` (simvastatin 40 mg + ketoconazole 200 mg) | 1 pair, `red`, `Relevance` 5, `CombiStatus` 1 (contraindication) |
| `314076,849574` (lisinopril 10 mg + naproxen sodium 220 mg) | 1 pair, `yellow`, `Relevance` 4, `InteractionCcode` 38010552 |
| `856987,205532,314076` (hydrocodone/acetaminophen, Pulmozyme, lisinopril) | `ErrorCode = 2`, no interactions |
| `36567,6135` (ingredient RxCUIs for simvastatin and ketoconazole) | `ErrorCode = 8` |

The synthetic patient from the CMS Blue Button sandbox takes hydrocodone/acetaminophen, Pulmozyme and lisinopril on `asOf=2024-12-18` and has no interactions. The lisinopril + naproxen pair shows up only without the date filter: naproxen was filled once in March 2015, lisinopril from 2020 on.

## Sources

* FHIR R4, DetectedIssue: <https://hl7.org/fhir/R4/detectedissue.html>. `status`: "registered | preliminary | final | amended +"; `severity`: "high | moderate | low".
* HL7 Terminology, v3 ActCode: <https://terminology.hl7.org/CodeSystem-v3-ActCode.json>. Code `DRG`: "Drug Interaction Alert".
* CARIN Blue Button 2.0.0, Pharmacy EOB: <https://hl7.org/fhir/us/carin-bb/STU2/StructureDefinition-C4BB-ExplanationOfBenefit-Pharmacy.html>. `item.productOrService` is required, with a required binding to the NDC-or-compound value set (`FDANDCOrCompound`); the `supportingInfo:dayssupply` slice is required, with a `Quantity` value.
* RxNav, getNDCStatus: <https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getNDCStatus.html>. "OBSOLETE The NDC previously existed in RxNorm, but is no longer recognized as active. The history data will indicate the time periods and RxCUI(s) associated with the NDC."
* Scholz DataBank, function list: <https://rest.scholzdatabank.com/ditwebservices/default.htm>. "interactionsbyrxcuisex/1234567890/198211,897649", "distinctdrugsbyrxcui/1234567890/198032", "interactionfulltext/1234567890/40010501".
