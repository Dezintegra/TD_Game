## 1. Линия «до»

- [x] 1.1 Снять полный прогон с поимённым замером и **записать таблицу
      в `README.md` изменения**: команда `pnpm exec vitest run
      --reporter=json --outputFile=<путь>`, затем сумма по файлам.
      Отметка о выполнении без таблицы в README не считается сделанной
      задачей: галочке у замера верить нельзя, проверяется наличие чисел.
      Указать в README загрузку машины (число процессов node), иначе
      цифры нельзя будет сравнить с линией «после».

## 2. Переименование (отдельный коммит, без правок содержимого)

- [ ] 2.1 Перенести шесть файлов `packages/ai` через `git mv`:
      `siege`, `profile`, `profile.golden`, `islands`, `opponent`,
      `observer` — из `*.test.ts` в `*.match.test.ts`.
- [ ] 2.2 Перенести `packages/sim/src/determinism.golden.test.ts`,
      `packages/netplay/src/match.test.ts`,
      `packages/bot/src/participant.test.ts`.
- [ ] 2.3 Перенести `apps/arena/src/arena.test.ts`,
      `apps/arena/src/replay.test.ts`,
      `apps/server/src/recording.test.ts`,
      `apps/server/src/matches.test.ts`.
- [ ] 2.4 Проверить: `git status` показывает ровно тринадцать
      переименований (`R`), ни одного `M`. Содержимое файлов
      не менялось — `git diff --cached -M --stat` не показывает
      ни одной изменённой строки.

## 3. Конфигурации пакетов

- [ ] 3.1 В шести `vitest.config.ts` (`ai`, `sim`, `netplay`, `bot`,
      `server`, `arena`) добавить `exclude` с `defaultExclude`
      и `src/**/*.match.test.ts`, с комментарием о причине.
      Проверка: `pnpm --filter @td/ai test` не запускает ни одного
      матчевого файла и укладывается в секунды.
- [ ] 3.2 Завести шесть `vitest.match.config.ts` рядом с ними:
      `include: ['src/**/*.match.test.ts']`, имя проекта с суффиксом
      `:match`, то же окружение. Проверка: `pnpm --filter @td/arena
      test:match` запускает ровно два файла.
- [ ] 3.3 Добавить команду `test:match` в шесть `package.json` пакетов.
- [ ] 3.4 В `packages/sim/package.json` обе команды прогоняют два
      окружения: `vitest run && vitest run --environment jsdom`.
      Проверка: вывод `pnpm --filter @td/sim test` содержит два
      прогона, второй в jsdom.

## 4. Turborepo и корневые команды

- [ ] 4.1 В `turbo.json` добавить задачу `test:match`
      (`dependsOn: ["^build"]`), а во входные файлы обеих задач —
      `vitest.config.ts` и `vitest.match.config.ts`.
- [ ] 4.2 В корневом `package.json`: `test` → `turbo run test`,
      новые `test:match` → `turbo run test:match`,
      `test:all` → `pnpm test && pnpm test:match`,
      `verify:all` → как `verify`, но с `test:all`.
- [ ] 4.3 Из корневого `vitest.workspace.ts` убрать двойное описание
      `sim` (переехало в команды пакета) и добавить комментарий
      о новой роли файла: он больше не точка входа `pnpm test`.
- [ ] 4.4 Проверка кеша: `pnpm test` дважды подряд — второй прогон
      целиком из кеша. Затем тронуть файл в `apps/client`
      и убедиться, что `@td/sim#test` и `@td/ai#test` взяты из кеша,
      а `@td/client#test` пересчитан.
- [ ] 4.5 Проверка инвалидации: тронуть `packages/sim/vitest.config.ts`
      и убедиться, что `@td/sim#test` пересчитан, а не отдан из кеша.
      Без задачи 4.1 эта проверка провалится — она её и стережёт.

## 5. CI и документация

- [ ] 5.1 В `.github/workflows/ci.yml` заменить `pnpm test`
      на `pnpm test:all`. Задача `e2e` не трогается.
- [ ] 5.2 В `CLAUDE.md`, раздел «Перед завершением задачи», описать оба
      набора и правило: матчевый гоняется по явной просьбе, а также
      когда правка задевает `packages/sim`, `packages/ai` или баланс.

## 6. Приёмка

- [ ] 6.1 Сверить состав: число тестов в `pnpm test:all` совпадает
      с линией «до» из задачи 1.1. Ни одна проверка не потерялась
      и ни одна не задвоилась.
- [ ] 6.2 Снять линию «после» на **свободной машине** (проверить, что
      соседних процессов node нет) и записать обе цифры рядом
      в `README.md` изменения. Без записанных чисел задача не закрыта.
- [ ] 6.3 Прогнать `pnpm verify:all` целиком. Падения в чужих файлах
      воркри и в файлах соседних сессий разобрать отдельно и назвать
      в отчёте, а не молча засчитать своей поломкой.
