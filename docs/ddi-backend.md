# Проверка взаимодействий лекарств: backend

Сервис по запросу UI ([демо](https://aleksandr-oleinikov.github.io/fhir_camp_2026/)) сам забирает из Aidbox аптечные `ExplanationOfBenefit` пациента. Из них он собирает лекарства, которые пациент принимает сейчас, проверяет весь список в Scholz DataBank и возвращает пары, которые плохо сочетаются.

## 1. Вход

| Вызов | Что делает |
| --- | --- |
| `GET /patients/{id}/interactions?asOf=YYYY-MM-DD` | Проверка списка лекарств. Параметр `asOf` задаёт дату, на которую лекарство считается текущим; по умолчанию сегодня |
| `GET /patients/{id}/interactions/{interactionCode}` | Полный текст по одному взаимодействию, когда пользователь открывает алерт |

Переменные окружения: `AIDBOX_URL`, `AIDBOX_CLIENT_ID`, `AIDBOX_CLIENT_SECRET`, `SCHOLZ_UCI`.

## 2. Шаги

Ниже `SDB` = `https://rest.scholzdatabank.com/ditwebservices`. Ко всем вызовам Scholz добавляется `?format=json`.

1. **EOB из Aidbox.** `GET {AIDBOX_URL}/fhir/ExplanationOfBenefit?patient=Patient/{id}&_count=100`, дальше по `link` с `relation = next`. В коде оставить EOB, у которых в `type.coding` есть `http://terminology.hl7.org/CodeSystem/claim-type` с кодом `pharmacy`, а `status` не `cancelled` и не `entered-in-error`.
2. **Отпуски.** Из каждого `item` взять:
   * NDC из `productOrService.coding` с system `http://hl7.org/fhir/sid/ndc` (11 цифр);
   * дату отпуска `servicedDate`;
   * запас в днях из `supportingInfo`, где `category.coding.code = dayssupply`, поле `valueQuantity.value`.
3. **Текущие лекарства.** Отпуск текущий, если `servicedDate <= asOf < servicedDate + daysSupply`. Отпуски одного лекарства схлопываются по RxCUI (шаг 4), в ответ идёт последний.
4. **NDC → RxCUI.** `GET https://rxnav.nlm.nih.gov/REST/ndcstatus.json?ndc={ndc}`, поле `ndcStatus.rxcui`. Не использовать `rxcui.json?idtype=NDC`: для NDC, снятых с рынка, он ничего не возвращает, а в выгрузке CMS Blue Button таких 13 из 22. Если статус `UNKNOWN` или `rxcui` пустой, лекарство попадает в `notChecked`.
5. **Уровень кода.** `GET https://rxnav.nlm.nih.gov/REST/rxcui/{rxcui}/properties.json`, поле `properties.tty` должно быть `SCD` или `SBD`. RxCUI вещества Scholz не принимает.
6. **Есть ли лекарство в Scholz.** `GET {SDB}/distinctdrugsbyrxcui/{UCI}/{rxcui}`. При `ErrorCode = 1` сохранить `DrugList[0].DrugCode` (код Scholz вида `Y23723`) и `DrugName`. При `ErrorCode = 2` лекарство попадает в `notChecked`. Этот шаг обязателен: на неизвестный RxCUI проверка не отвечает ошибкой, а возвращает `ErrorCode = 2`, то есть «взаимодействий нет», и это ложный ответ.
7. **Проверка.** Если найдено 2 лекарства или больше: `GET {SDB}/interactionsbyrxcuisex/{UCI}/{rxcui1},{rxcui2},...`. В запрос идёт весь список текущих лекарств. Имя функции пишется именно так, с `s`.
8. **Статус.** HTTP всегда 200, результат определяет `ResponseStatus.ErrorCode`: `1` значит взаимодействия есть, `2` значит нет, `8` значит ошибка во входных данных или нет прав. При `8` и при сетевой ошибке сервис ничего не пишет и отвечает UI ошибкой `502`, а не пустым списком.
9. **Разбор `InteractionListEx`.**
   * Участники пары: непустые `DrugCode1..4`. Они сопоставляются с лекарствами пациента по `DrugCode` из шага 6.
   * Одна пара приходит несколькими строками (разная частота, пороги дозы). Строки группируются по `InteractionCcode` и набору `DrugCode`, из группы остаётся строка с наибольшей `severity`.
   * `severity` для UI: `TrafficLightColor` `red` → 3, `yellow` → 2, любой другой непустой цвет, кроме `green`, → 1. Цвет бывает пустым, тогда по `Relevance`: 5 → 3, 4 → 2, 3 → 1. `Relevance` 1 и 2 и цвет `green` не показываются.
10. **Запись в Aidbox.** Каждая пара из `conflicts` пишется как `DetectedIssue` (раздел 4) через conditional update: `PUT {AIDBOX_URL}/fhir/DetectedIssue?identifier=urn:fhir-camp-2026:scholz-interaction|{id}-{InteractionCcode}`. Повторная проверка обновляет запись, а не создаёт дубль. `DetectedIssue` этого пациента со статусом `final`, которых нет в новом результате, переводятся в `cancelled`.
11. **Полный текст.** `GET {SDB}/interactionfulltext/{UCI}/{InteractionCcode}` вызывается только из второго роута. Поля `InteractionFullTextList[0].Mechanism` и `.Management` приходят массивами строк; `$` в тексте означает перенос строки, `$$` новый абзац.

## 3. Таблица случаев

| Случай | Что отдаёт Scholz или RxNav | Что делает backend |
| --- | --- | --- |
| Взаимодействий нет | `ErrorCode = 2`, пустой список | `conflicts: []`, старые `DetectedIssue` переводятся в `cancelled` |
| RxCUI неизвестен Scholz | Ошибки нет: `ErrorCode = 2`, как будто взаимодействий нет | Ловится на шаге 6, лекарство в `notChecked` |
| RxCUI вещества (`tty = IN`) | `ErrorCode = 8`, «Entered RXCUI is not valid» | Ловится на шаге 5, лекарство в `notChecked` |
| NDC снят с рынка | RxNav `ndcstatus`: `OBSOLETE` с RxCUI | Берётся RxCUI из `ndcstatus` |
| NDC неизвестен RxNav | `ndcstatus`: `UNKNOWN`, RxCUI пустой | Лекарство в `notChecked`, пример: `00427080094` |
| Пустой `TrafficLightColor` | `""` | `severity` по `Relevance` |
| Нет прав по ключу | `ErrorCode = 8`, «Entered UCI doesn't have privileges» | `502`, причина в логе |
| Сеть или таймаут | Ответа нет | `502`, в Aidbox ничего не пишется |
| Больше 30 лекарств | URL длиннее 324 символов; на 394 символах Scholz отвечает HTTP 400 | Список делится на части по 15, проверяется каждая пара частей |

## 4. Ответ для UI и `DetectedIssue`

Ответ первого роута:

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

`severity` совпадает с легендой UI: 3 Serious, 2 Moderate, 1 Minor. `effect` берётся из `EffLong`. `whatToDo` берётся из `CombiStatusText`, но поле обрезано до 50 символов, поэтому полную формулировку лучше брать по коду `CombiStatus` из словаря в глоссарии руководства Scholz.

Поля `DetectedIssue`:

| Поле | Значение |
| --- | --- |
| `identifier` | system `urn:fhir-camp-2026:scholz-interaction`, value `{id}-{InteractionCcode}` |
| `status` | `final`; `cancelled`, когда пара пропала при повторной проверке |
| `code` | `http://terminology.hl7.org/CodeSystem/v3-ActCode`, код `DRG`, display `Drug Interaction Alert` |
| `severity` | 3 → `high`, 2 → `moderate`, 1 → `low` |
| `patient` | `Patient/{id}` |
| `identifiedDateTime` | время проверки |
| `implicated` | `ExplanationOfBenefit` последнего отпуска каждого лекарства из пары |
| `detail` | `EffLong` и `whatToDo` через ` \| ` |

## 5. Ключ и лимиты

* UCI (ключ клиента Scholz) передаётся прямо в пути URL. Он берётся из `SCHOLZ_UCI` и в логах заменяется на `***`. Репозиторий публичный: ключ и секреты Aidbox не коммитятся.
* Вызовы Scholz идут только по `https`.
* Лимит длины URL: 30 RxCUI (324 символа) проходят, 40 RxCUI (394 символа) дают HTTP 400.

## 6. Проверочные запросы

| RxCUI в `interactionsbyrxcuisex` | Ожидаемый результат |
| --- | --- |
| `198211,197853` (simvastatin 40 mg + ketoconazole 200 mg) | 1 пара, `red`, `Relevance` 5, `CombiStatus` 1 (contraindication) |
| `314076,849574` (lisinopril 10 mg + naproxen sodium 220 mg) | 1 пара, `yellow`, `Relevance` 4, `InteractionCcode` 38010552 |
| `856987,205532,314076` (hydrocodone/acetaminophen, Pulmozyme, lisinopril) | `ErrorCode = 2`, взаимодействий нет |
| `36567,6135` (RxCUI веществ simvastatin и ketoconazole) | `ErrorCode = 8` |

Синтетический пациент из песочницы CMS Blue Button на `asOf=2024-12-18` принимает hydrocodone/acetaminophen, Pulmozyme и lisinopril, и взаимодействий у него нет. Пара lisinopril + naproxen находится только без фильтра по датам: naproxen отпущен один раз в марте 2015 года, lisinopril с 2020 года.

## Sources

* FHIR R4, DetectedIssue: <https://hl7.org/fhir/R4/detectedissue.html>. `status`: «registered | preliminary | final | amended +», `severity`: «high | moderate | low».
* HL7 Terminology, v3 ActCode: <https://terminology.hl7.org/CodeSystem-v3-ActCode.json>. Код `DRG`: «Drug Interaction Alert».
* CARIN Blue Button 2.0.0, Pharmacy EOB: <https://hl7.org/fhir/us/carin-bb/STU2/StructureDefinition-C4BB-ExplanationOfBenefit-Pharmacy.html>. `item.productOrService` обязателен, с обязательной привязкой к набору NDC или compound (`FDANDCOrCompound`); срез `supportingInfo:dayssupply` обязателен, значение `Quantity`.
* RxNav, getNDCStatus: <https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getNDCStatus.html>. «OBSOLETE The NDC previously existed in RxNorm, but is no longer recognized as active. The history data will indicate the time periods and RxCUI(s) associated with the NDC.»
* Scholz DataBank, список функций: <https://rest.scholzdatabank.com/ditwebservices/default.htm>. «interactionsbyrxcuisex/1234567890/198211,897649», «distinctdrugsbyrxcui/1234567890/198032», «interactionfulltext/1234567890/40010501».
