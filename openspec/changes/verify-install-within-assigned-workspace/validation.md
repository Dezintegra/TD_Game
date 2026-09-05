# Живая проверка 06.09.2026

Проверка завершилась успешно на отправленной ревизии
`c807c79d70e42716e1eece420b64329a4d23f78c`. Перед запуском и во время
пробы `git -C . rev-list --count '@{u}..HEAD'` вернул `0`.

Команда из назначенного дерева:

```powershell
node .matchlog/0232-install-check.mjs
```

Локальный файл импортирует `checkInstallSnapshot` из
`../supervisor/lib/install-snapshot-check.mjs`, вызывает её без аргументов,
печатает JSON и присваивает `process.exitCode = result.ok ? 0 : 1`.
Штатный эквивалент после доставки разрешений:

```powershell
node supervisor/bin/check-install-snapshot.mjs --run
```

## Среда и границы

- Windows, Node `v24.3.0`, pnpm `10.12.4`, Git `2.45.1.windows.1`.
- `codex --version` из PATH: `codex-cli 0.146.0`; команда также напечатала
  `WARNING: proceeding, even though we could not create PATH aliases: Could not find home directory`.
  Это версия доступного CLI, а не независимо установленная версия хоста сессии.
- Контекст текущей сессии: managed permissions, filesystem `workspace-write`,
  approval `never`, сеть включена. Запись ограничена назначенным деревом и
  перечисленными в контексте служебными Git/perf-путями. Имя CLI-профиля
  текущий контекст не сообщает; `td-pipeline` относится к операторской
  диагностике из журнала задачи и не выдаётся здесь за измеренный параметр.
- Родительский cwd и его realpath:
  `C:/src/dezintegra/TD_Game/.claude/worktrees/0232-obespechit-sozdanie-lokalnogo-kesha-pnpm`.
- Новая копия, проверенная через realpath:
  `C:/src/dezintegra/TD_Game/.claude/worktrees/0232-obespechit-sozdanie-lokalnogo-kesha-pnpm/.matchlog/install-check-6AslIu/snapshot`.
- Архив и полный JSON: `.matchlog/install-check-6AslIu/source.tar` и
  `.matchlog/install-check-6AslIu/result.json`. Копия и прежние фикстуры сохранены.

Cwd инструмента не переносился в копию, новая sandbox не запускалась.
ACL и writable roots не менялись. Git получает точное `safe.directory`
на каждый вызов; глобальная конфигурация не записывается. В копии
`core.excludesFile` направлен на отсутствующий файл соседнего каталога,
hooks направлены на пустой собственный каталог, fsmonitor отключён.
`.gitignore` извлечён из указанного SHA без правок.

## Наблюдаемые результаты

| Условие | Результат |
| --- | --- |
| Начальная чистота копии | `initialStatus: ""` |
| Store и node_modules до установки | отсутствовали, `cacheAbsent: true` |
| Настоящая установка | `install --frozen-lockfile --store-dir .pnpm-store`, exit 0 |
| Пакеты | 346, downloaded 346, added 346; postinstall трёх esbuild завершились |
| Время из вывода pnpm | `Done in 48.1s using pnpm v10.12.4` |
| stderr установки | пуст |
| Полный статус после установки | `installedStatus: ""` |
| Источник ignore каталога и файла кеша | `.gitignore:2:.pnpm-store/` в обоих случаях |
| Изменённый отслеживаемый исходник | ` M apps/arena/src/arena.match.test.ts` |
| После восстановления исходных байтов | `restoredSourceStatus: ""` |
| Независимый посторонний файл | `?? install-check-untracked.txt` |
| После удаления только контрольного файла | `finalStatus: ""` |
| Общий результат | `ok: true`, `stage: complete`, код скрипта 0 |

Найден непустой обычный файл пакета:
`.pnpm-store/v10/files/00/0205aca1b6099c59396eb8c496ea85b702526bccd8b66721076178baaf1c0b9757420feb52746a3df0022c7858244870f6a3b2391cf5485872861f19ba1f98`.
Store создан самим pnpm, предварительных маркеров не было.

## Отказы и исправление

Первая попытка на `9f017ec` остановилась до создания копии, на prerequisites:
`git: 128`, `fatal: detected dubious ownership in repository at 'C:/src/dezintegra/TD_Game/.claude/worktrees/0232-obespechit-sozdanie-lokalnogo-kesha-pnpm'`.
Git указал владельца `INSIDE/Dmitry.Ivanov` и текущего пользователя
`NB3391/CodexSandboxOnline`. Передававшийся точный путь safe.directory
с обратными косыми не сработал. В `c807c79` тот же путь нормализован
прямыми косыми, добавлена проверка формы в тестах. Промежуточный запуск
правильно отверг незакоммиченное исправление как `Dirty snapshot`.
После коммита и отправки выполнена новая полная успешная проба выше.

Git при внешних командах статуса/коммита предупреждал
`unable to access 'C:\Users\dmitry.ivanov/.config/git/ignore': Permission denied`;
команды завершались с кодом 0. Отказов согласования команд не было.
Доступ к личному ignore не расширялся, рекомендованная Git глобальная
запись safe.directory не выполнялась.

Операторский журнал локализует прежний EPERM в повторной подготовке
Windows sandbox при смене её cwd (`SetNamedSecurityInfoW failed: 5`).
Эта проба подтверждает поддерживаемый способ с исходной границей на новой
копии; она не доказывает конкретный внутренний дефект ACL Codex и не
закрывает отдельную приёмку 0226.

## Автоматические проверки

22 теста трёх новых файлов прошли; после нормализации Windows-пути
повторно прошли 10 библиотечных тестов. ESLint и Prettier изменённых
файлов прошли. `openspec validate verify-install-within-assigned-workspace --strict`
прошёл. Полный test:pipeline, игровые наборы, сборка, замеры и арена
не запускались согласно плану. PR #167 открыт черновиком после первого
коммита; CI запущен, его завершение оставлено следующему этапу.
