# Спільний workflow адаптацій і сценаріїв M4.2

Один імпортований workflow обслуговує всі сім форматів: TELEGRAM_POST, LINKEDIN_TEXT, LINKEDIN_COVER, INSTAGRAM_COVER, LINKEDIN_CAROUSEL, INSTAGRAM_CAROUSEL та INSTAGRAM_STORIES. У запиті передаються формат, маршрут DIRECT або ARTICLE_DERIVED та незалежний режим FACTUAL або CREATIVE. Спільні вузли пишуть, рецензують, за потреби один раз адресно виправляють і детерміновано перевіряють результат. Runtime обирає форматні інструкції, межі та форму cover/script-виходу; окремих застосунків під формат немає.

Цільовий імпортований DSL — Dify **1.17.1** з Graphon **0.7.0** і Gemini plugin langgenius/gemini/google, модель gemini-3.8-flash. Це ціль локальної перевірки, а не підтвердження поточного стану Dify Cloud. Імпорт, перевірка публікації, фактичні налаштування моделі/плагіна та живий запуск лишаються окремими діями.

## Контракт

Вхідна Workflow API змінна — editorial_json. Вона містить schemaVersion: "channel-context-v1", format, inputMode, contentMode, includeLink, brief, style, claims, context та article. Заморожені brief, фактична база, стиль і контекст збирає сервер. DIRECT має article: null; ARTICLE_DERIVED містить затверджену версію статті. Для не-Telegram форматів передається includeLink: false.

Вихід містить adaptation_json та adaptation_report. Кандидат має schemaVersion: "adaptation-v1", той самий format і content: {text, mappings}. Cover-формати додають до content поле {cover: {text, instruction}}. Carousel/story формати додають top-level script: {frames:[{id,purpose,text,visualHint,transition,mappings}]}; UUID кадрів лишаються стабільними протягом адресної правки, порядок масиву задає порядок показу, stories потребують непорожніх переходів. Caption використовує попередній контракт text/mappings, а мапінги кадру мають локальні UTF-16 offsets. Cover-текст та інструкція дизайнера є текстом для M5; зображення workflow не створює.

Усі factual сегменти проходять повторну перевірку дозволеної пари claim/evidence. Публікаційний текст має покривати кожне обов’язкове твердження. Поле ready означає лише непогоджений кандидат; схвалює його людина в ContentFlow. Якщо дозволених фактів недостатньо, щоб відповісти на brief.centralMessage, рецензент має повернути insufficient_evidence без кандидата. Це закриває повторювану live-прогалину від 2026-10-10, коли кількість занять помилково приймалася за відповідь про ефективність курсу; повторна хмарна перевірка пройшла 2026-10-12: [live receipt](../../../../../../docs/M42_LIVE_DIFY_2026-10-12.md).

Runtime bounds: Telegram text — 4096 UTF-16 units; решта текстів публікації — 10000; cover text — 200; інструкція — 2000; до 30 кадрів, 3000 UTF-16 units на кадр, 30000 на сценарій, 100 мапінгів, purpose — 200 символів, visualHint — 1000, transition — 300; максимум 20 paragraphs, 100 текстових segments, одна адресна правка, два повних рев’ю та чотири model calls. Фактичні offsets і SHA-256 обчислює код, а backend ще раз перевіряє contract, evidence та заморожену ancestry.

## Побудова й перевірка

Джерела: prompt.md, scripts/dify/adaptation_generation_runtime.py, scripts/dify/build_adaptation_generation_dsl.py. Побудований імпортований YAML — adaptation-generation-v1.yml; release.json — метадані API-релізу і не є native DSL.

Команди з кореня репозиторію у PowerShell:

- .\.venv-dify-validator\Scripts\python.exe -B scripts\dify\build_adaptation_generation_dsl.py
- .\.venv-dify-validator\Scripts\python.exe -B scripts\dify\test_adaptation_generation_runtime.py
- .\.venv-dify-validator\Scripts\python.exe -B scripts\dify\test_adaptation_generation_graph.py
- .\.venv-dify-validator\Scripts\python.exe -B scripts\dify\validate_dify_dsl.py --self-test
- .\.venv-dify-validator\Scripts\python.exe -B scripts\dify\validate_dify_dsl.py packages\backend\src\editorial\workflows\adaptation-generation\adaptation-generation-v1.yml --graphon-version 0.7.0
- node scripts\dify\verify_adaptation_release.mjs

Runtime fixtures cover all seven formats across both routes and both modes, exact cover evidence mapping, scoped cover-instruction repair and insufficient evidence. Graph fixtures execute the exported YAML on Graphon 0.7.0 with synthetic LLM replies and local Code-node execution. Static validation and synthetic graph execution do not prove import, publication, cloud plugin availability or model quality.

Current local release receipt and SHA-256 values are pinned in [release.json](release.json) and verified by `node scripts/dify/verify_adaptation_release.mjs`. The native YAML SHA-256 is `workflowDslSha256`; `release.json` remains API metadata, not an importable DSL.

Import or publish is not authorized by local implementation work. Keep DIFY_ADAPTATION_API_KEY in runtime configuration; after an owner-authorized publication, pin the actual workflow UUID and matching config digest using DIFY_ADAPTATION_WORKFLOW_ID and DIFY_ADAPTATION_CONFIG_SHA256.
