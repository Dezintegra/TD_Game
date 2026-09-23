# Узкие тесты shared, sim и ai без dist

После обновления базы установите зависимости своего дерева:

```powershell
pnpm install --frozen-lockfile --prefer-offline
```

В revise это нужно также при отсутствующем node_modules и неизменном lockfile.
Установка не создаёт dist, а прямой Vitest из корня может подхватить workspace.
Поддерживаемый запуск использует точные алиасы shared/sim на исходники рядом
с оснасткой, отдельный корень, новый процесс и один worker без Turbo-кеша.
Mutation descriptor, setup и reporter в него не входят.

Запускайте из корня назначенного дерева с конкретными существующими файлами
shared/sim/ai. Для sim поддерживаются node и jsdom, для shared/ai — node.
Пустой список, glob, каталог, дубликат, неизвестный ключ и посторонний файл
отвергаются. Из матчевых файлов разрешены только два golden ниже.

```powershell
node scripts/test-source.mjs --environment node packages/shared/src/rules.test.ts packages/shared/src/balance.test.ts packages/sim/src/crowd.test.ts packages/sim/src/step.test.ts
node scripts/test-source.mjs --environment jsdom packages/sim/src/crowd.test.ts packages/sim/src/step.test.ts
node scripts/test-source.mjs --environment node packages/sim/src/determinism.golden.match.test.ts
node scripts/test-source.mjs --environment jsdom packages/sim/src/determinism.golden.match.test.ts
node scripts/test-source.mjs --environment node packages/ai/src/profile.golden.match.test.ts
```

`result.json` и штатный JSON Vitest сохраняются в уникальном
`.matchlog/source-test-*`. Успех требует совпадения выбранных и исполненных
файлов, хотя бы одного выполненного теста в каждом и отсутствия ошибок.
Проверяйте repoRoot, environment, executed и passed/failed/skipped;
одного exit code или числа collected недостаточно. Ошибки загрузки,
отсутствующий отчёт и только пропущенные тесты означают неуспех.

Для scripts используйте `npx vitest run --root scripts <файл.test.mjs>`;
правки supervisor требуют `pnpm test:pipeline`. Для адресной диагностики
supervisor допустим `npx vitest run --root supervisor <файл.test.mjs>`.
У остальных пакетов нужны свой явный корень и их предусмотренная подготовка.
Полные `pnpm verify`, `pnpm test:match`, `pnpm verify:all` локально запрещены.

## Приёмка маршрута на свежей установке

Из чистого дерева с отправленным HEAD, совпадающим с upstream:

```powershell
node scripts/testing/check-source-tests.mjs --fresh
```

`checkInstallSnapshot` создаёт собственную Git-копию в
`.matchlog/install-check-*/snapshot` и устанавливает её зависимости с локальным
store. Матрица содержит ровно пять вызовов: crowd/step в node/jsdom,
golden sim в node/jsdom и golden ai в node. До и после проверяется отсутствие
dist shared/sim/ai. Только в контрольной копии временно меняется shared index,
затем sim index: ожидаемые маркеры TD_SOURCE_CONTROL_SHARED и
TD_SOURCE_CONTROL_SIM должны дать провал; восстановление байтов возвращает
успех. Итог с SHA, версиями, путями и счётчиками —
`.matchlog/source-check-*/result.json`. Копии остаются для диагностики.

В CI на свежем checkout после штатной установки применяется:

```powershell
node scripts/testing/check-source-tests.mjs --installed
```

Этот режим поддерживает detached HEAD без upstream. Матрица идёт в checkout,
а отрицательные контроли — в собственной установленной копии архива его SHA.
Checkout не изменяется. Job использует существующий changes: доказанный
служебный diff пропускается, неизвестный или ошибочный результат включает её.
Матрица не входит в быстрый test:scripts. Существующий dist не удаляется:
приёмка откажется, чтобы сборка не скрыла неисправную загрузку исходников.

## До доставки разрешений запущенной сессии

Изменение stage-settings.json в ветке не обновляет уже запущенную сессию.
Если точный CLI ещё не доставлен, создайте свой несуществующий ранее файл
`.matchlog/0337-source-tests.mjs` с таким содержимым:

```javascript
import { sourceMain } from '../scripts/testing/source-runner.mjs';
sourceMain();
```

Вызов использует тот же runner и те же аргументы:

```powershell
node .matchlog/0337-source-tests.mjs --environment node packages/sim/src/crowd.test.ts packages/sim/src/step.test.ts
```

Для приёмки создайте `.matchlog/0337-check-source-tests.mjs`:

```javascript
import { checkSourceMain } from '../scripts/testing/check-source-tests.mjs';
checkSourceMain(['--fresh']);
```

```powershell
node .matchlog/0337-check-source-tests.mjs
```

Это переходники импорта, без своей конфигурации, алиасов и подмены cwd.
Не перезаписывайте неизвестные файлы. При отказе среды сообщите точное действие
и причину; не меняйте ACL, sandbox или чужие настройки для обхода.

## Передача 0013: increase-unit-spacing, PR 265

Пробу выполняет назначенная сессия исходного implement после доставки ремонта
и допуска супервизора по существующему механизму инцидентов. Исполнитель 0337
не меняет дерево, карточку, ветку или PR 0013. В назначении пробы должен быть
реальный incidentId; номер ремонта не заменяет его.

1. Сверить свою ветку и PR 265, прочитать журнал и сохранённые design/tasks,
   обновить базу и установить зависимости. Сохранить increase-unit-spacing,
   PR 265, игровые требования и существующие отметки.
2. В design заменить раздел неудачной временной подготовки поддерживаемым
   маршрутом. В tasks заменить команды во всех трёх пунктах и разделе
   «Правила коммитов и передачи». Прежнюю причину оставить как историю;
   временную `.matchlog/0013-*.mjs` больше не использовать. Чужие файлы не удалять.
3. Для пункта 1.1 использовать первые пять команд этой памятки: shared rules,
   balance, sim crowd/step, оба окружения sim и оба отдельных golden.
   Для пункта 2.1 использовать следующие две команды:

   ```powershell
   node scripts/test-source.mjs --environment node packages/sim/src/step.test.ts packages/sim/src/navigation.test.ts
   node scripts/test-source.mjs --environment jsdom packages/sim/src/step.test.ts packages/sim/src/navigation.test.ts
   ```

   Для пункта 3.1:

   ```powershell
   node scripts/test-source.mjs --environment node packages/sim/src/crowd.test.ts packages/sim/src/step.test.ts
   node scripts/test-source.mjs --environment jsdom packages/sim/src/crowd.test.ts packages/sim/src/step.test.ts
   ```

4. Служебная подготовка не закрывает игровые пункты. Радиус реализует 0013.
   Изменение правил и необходимые новые значения обоих golden входят в один
   коммит: сверять совокупные правила свежей базы, включая 0035, если она влита.
   Чужие суммы не копировать; неизменившийся эталон сохранить и подтвердить
   его проверку в PR. Assertions, состав сценариев, окна и критерии не ослаблять.
5. В отчёте пробы вернуть `incidentVerification: {incidentId, passed, evidence}`
   с фактическим ID, SHA, командами, путями результатов, исполненными файлами
   и ненулевыми счётчиками. Отличать ошибку загрузки от изменения golden из-за
   правил. При неуспехе дать новый диагноз с фактами. Вливание #272, зелёный CI
   или обычный done сами по себе инцидент не закрывают.

Прогоны арены 0331/0332 остаются у 0013 и повторно не заказываются.
