# ContextFlow

Редакційний робочий простір на Vue 3 і NestJS. M1 завершено локально: технічна основа, реєстрація й захищені серверні сесії з особистим часом бездіяльності, ізольовані Workspace/проєкти, налаштування теми й форматів та доступ до метаданих приватних файлів. Основна БД працює в Supabase, Redis — в Upstash; локальні сервіси ізольовані для тестів. [Підсумок M1](docs/M1_CLOSEOUT.md) описує перевірки й межі локального завершення.

Потрібні Node **24.19.0**, pnpm **11.19.0** і Docker з Compose. На Windows можна використовувати `scripts/workspace.ps1`: він обирає сумісний Node24 із Codex без зміни глобального PATH.

```powershell
.\scripts\workspace.ps1 install --frozen-lockfile
.\scripts\workspace.ps1 env:init
.\scripts\workspace.ps1 deps:test:up
.\scripts\workspace.ps1 db:migrate
.\scripts\workspace.ps1 dev
```

На інших системах із Node24 виконуйте ті ж команди через `pnpm`.

- Web: [localhost:5173](http://localhost:5173)
- API / OpenAPI: [localhost:3000/api/docs](http://localhost:3000/api/docs)
- Worker readiness: [localhost:3001/health/ready](http://localhost:3001/health/ready)

[Налаштування .env](docs/ENVIRONMENT.md) пояснює поля Supabase/Upstash та перенаправлення після підтвердження пошти. `env:init` зберігає налаштовані значення й додає відсутні випадкові ключі сесій/TEST. Для ізольованих тестів зовнішні облікові записи не потрібні.

```text
pnpm check
pnpm test:integration
pnpm test:e2e
pnpm verify:connections
pnpm verify:auth
pnpm verify:projects
pnpm verify:migrations
```

Докладні команди, ізоляція тестів і міграції: [RUNBOOK](docs/RUNBOOK.md). Статус і межі перевірки: [STATUS](docs/STATUS.md), [PLAN](docs/PLAN.md).
