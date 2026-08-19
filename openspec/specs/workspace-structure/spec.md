# workspace-structure Specification

## Purpose

TBD - created by archiving change bootstrap-monorepo. Update Purpose after archive.

## Requirements

### Requirement: Монорепозиторий на pnpm workspaces

Репозиторий SHALL быть единым pnpm-workspace, объединяющим приложения из `apps/*` и библиотеки из `packages/*`. Каждый рабочий пакет SHALL иметь собственный `package.json` и уникальное имя в пространстве `@td/`.

#### Scenario: Установка зависимостей всего репозитория одной командой

- **WHEN** разработчик выполняет `pnpm install` в корне репозитория
- **THEN** зависимости устанавливаются для всех пакетов сразу, а внутренние пакеты `@td/*` линкуются символическими ссылками без публикации в реестр

#### Scenario: Внутренний пакет подключается по имени

- **WHEN** `apps/client` объявляет зависимость `"@td/sim": "workspace:*"`
- **THEN** импорт `import { ... } from '@td/sim'` разрешается в локальный пакет `packages/sim`, а не в пакет из npm-реестра

### Requirement: Фиксированный состав рабочих пакетов

Репозиторий SHALL содержать ровно шесть рабочих пакетов с закреплённой зоной ответственности: `apps/client`, `apps/server`, `packages/sim`, `packages/protocol`, `packages/shared`, `packages/ui`.

#### Scenario: Каждый пакет присутствует и собирается

- **WHEN** выполняется `pnpm -r build`
- **THEN** все шесть пакетов собираются успешно, и ни один не завершается ошибкой

### Requirement: Правила направления зависимостей

Граф зависимостей между пакетами SHALL быть ациклическим и односторонним. `packages/shared` не зависит ни от чего внутреннего. `packages/sim` и `packages/protocol` зависят только от `@td/shared`. `packages/ui` зависит только от `@td/shared`. `apps/client` и `apps/server` MUST NOT импортировать друг друга ни прямо, ни транзитивно.

#### Scenario: Ядро симуляции не тянет платформенный код

- **WHEN** проверяется дерево зависимостей `packages/sim`
- **THEN** среди них отсутствуют `react`, `pixi.js`, `fastify`, `ws` и любые внутренние пакеты, кроме `@td/shared`

#### Scenario: Попытка импорта клиента из сервера отклоняется

- **WHEN** в коде `apps/server` появляется импорт из `apps/client`
- **THEN** линт завершается ошибкой с указанием на нарушенное правило границ

### Requirement: Изоморфность ядра симуляции

`packages/sim` SHALL исполняться без изменений и в браузере, и в Node.js. Пакет MUST NOT обращаться к платформенным API: `window`, `document`, `process`, `fs`, а также к недетерминированным источникам `Math.random`, `Date.now` и `performance.now`.

#### Scenario: Ядро запускается в обеих средах

- **WHEN** один и тот же набор юнит-тестов `packages/sim` выполняется в окружении `node` и в окружении `jsdom`
- **THEN** оба прогона дают одинаковые результаты без падений

#### Scenario: Недетерминированный вызов не проходит проверку

- **WHEN** в исходниках `packages/sim` появляется вызов `Math.random()` или `Date.now()`
- **THEN** линт завершается ошибкой и указывает файл и строку

### Requirement: Единая конфигурация TypeScript

Репозиторий SHALL содержать корневой `tsconfig.base.json` с включённым `strict`, целевым модулем ESM и общими путями. Конфигурация каждого пакета SHALL наследоваться от базовой через `extends`.

#### Scenario: Ослабление strict в отдельном пакете не допускается

- **WHEN** пакет переопределяет `"strict": false` в своём `tsconfig.json`
- **THEN** проверка конфигураций в CI завершается ошибкой
