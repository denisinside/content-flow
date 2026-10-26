# Пропозиція редакторського брифу

Окремий native Dify Workflow для одного непогодженого редакторського варіанта брифу. Цільова версія — Dify **1.17.1**, що pin-ить Graphon **0.7.0** у [`api/pyproject.toml`](https://github.com/langgenius/dify/blob/1.17.1/api/pyproject.toml); DSL — **0.7.0**. Граф: перевірити запит → один виклик Gemini → перевірити та прив’язати результат. Модель не зберігає і не схвалює бриф.

## Контракт

Workflow приймає `brief_request_json`, JSON із такими полями:

```json
{
  "schemaVersion": "brief-proposal-input-v1",
  "requestId": "UUID",
  "topic": "Тема проєкту, до 500 символів",
  "contentMode": "FACTUAL",
  "currentBrief": {
    "topic": "",
    "audience": "",
    "centralMessage": "",
    "category": "",
    "tone": "",
    "targetLength": 600,
    "cta": "",
    "exclusions": [],
    "notes": ""
  },
  "style": {"tone": "", "brandbook": ""},
  "sources": [{
    "snapshotId": "UUID вибраного snapshot",
    "sha256": "64 lowercase hex characters",
    "label": "Назва джерела",
    "excerpt": "Вибраний уривок",
    "sampled": true
  }],
  "requestHash": "64 lowercase hex characters"
}
```

`requestHash` — SHA-256 від усіх полів запиту, крім самого `requestHash`, у UTF-8 JSON з рекурсивно відсортованими ключами, без пробілів після роздільників і з `ensure_ascii=false`. Тому до хешу входять точні source IDs, snapshot hashes, labels, excerpts та `sampled`. Передані джерела не обрізаються: дозволено до 20 snapshot-ів, label до 200 UTF-16 одиниць і до 60,000 сукупних UTF-8 байтів уривків; межа всього запиту — 120,000 байтів. `style.tone` обмежено 10,000, а `style.brandbook` — 50,000 UTF-16 одиницями; загальний ліміт запиту також застосовується.

Порожній список джерел дозволений для `CREATIVE`. Для `FACTUAL` готова пропозиція без вибраного джерела відхиляється; модель має повернути `needs_human` із `brief: null` і поясненням. Результат містить `schemaVersion`, той самий `requestId` і `requestHash`, контрольовані `releaseId`/`configDigest`, `status`, `brief` та короткий список редакторських припущень. `brief` у ready-результаті має ті ж дев’ять полів, що й збережений бриф. Сервер формує `topic`, `targetLength`, `exclusions` і `notes` з точних вхідних значень; модель пропонує `audience`, `centralMessage`, `category`, `tone` і `cta`. Це не підтверджує фактичну точність формулювань; їх переглядає людина перед застосуванням.

Код перевіряє UTF-8 межі, точну форму JSON, дублікати ключів, UUID, SHA-256, режими, поля брифу, унікальність snapshot-ів, загальний бюджет уривків, хеш запиту й усі межі відповіді. Відповідь моделі обмежена 64,000 байтами, а повний output — 128,000 байтами. Модель не бачить внутрішні source IDs і hashes; усі валідовані уривки разом із label передаються в одному prompt. Їхній текст залишається недовіреним вмістом. Automatic retry вимкнено.

## Збірка та локальна перевірка

YAML створюється тільки детермінованим builder-ом; ручні зміни експорту буде перезаписано.

```powershell
.\.venv-dify-validator\Scripts\python.exe -B scripts\dify\build_brief_proposal_dsl.py
.\.venv-dify-validator\Scripts\python.exe -B scripts\dify\validate_dify_dsl.py --self-test
.\.venv-dify-validator\Scripts\python.exe -B scripts\dify\validate_dify_dsl.py packages\backend\src\editorial\workflows\brief-proposal\brief-proposal-v1.yml --graphon-version 0.7.0
.\.venv-dify-validator\Scripts\python.exe -B scripts\dify\test_brief_proposal_graph.py
```

Graph test виконує експортований граф на pinned Graphon 0.7.0 з синтетичними відповідями моделі. Воно перевіряє Jinja selector, один model call, ін'єкцію в недовіреному уривку, source retention, owner field binding, request/result bounds, помилкові hashes/IDs, malformed output і гілку `needs_human`. Це не перевіряє доступ до Gemini, сумісність плагіна у вашому workspace, якість відповіді моделі чи можливість імпорту/публікації у remote Dify.

## Підключення до Dify

Артефакт [`brief-proposal-v1.yml`](brief-proposal-v1.yml) — native Dify app export, а [`release.json`](release.json) — локальний маніфест ContentFlow, не Dify DSL. Імпортуйте YAML як окремий Workflow, налаштуйте Google Gemini provider у Dify та зробіть `publish-check` перед публікацією. Після перевіреного publish серверу потрібні `DIFY_API_BASE_URL`, `DIFY_BRIEF_PROPOSAL_API_KEY`, `DIFY_BRIEF_PROPOSAL_PUBLISHED_WORKFLOW_ID` і значення з `DIFY_BRIEF_PROPOSAL_CONFIG_SHA256` у release manifest. Змінні API key залишаються тільки у server runtime; секретів у YAML немає.

Успішні локальні перевірки не свідчать про remote import, publish або живий прогін. Поки власник окремо не налаштує й не опублікує цей app, інші етапи проєкту ним не користуються.

### Версійні джерела

- [Dify 1.17.1 API dependency pins](https://github.com/langgenius/dify/blob/1.17.1/api/pyproject.toml) визначає Graphon 0.7.0.
- [Graphon 0.7.0 LLM node entities](https://github.com/langgenius/graphon/blob/v0.7.0/src/graphon/nodes/llm/entities.py) визначає поля Jinja prompt selector і structured output у LLM node.
- [Google Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output) описує JSON Schema subset; його native `null` type дає змогу повертати `brief: null` для `needs_human`.
