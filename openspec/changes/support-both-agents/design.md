# Решение

Сохранить существующий адаптер Claude и ввести явный provider=claude|codex. Выбор CLI перекрывает файл конфигурации. Старые записи сессий принадлежат Claude; продолжение другого провайдера начинает новую сессию с прежней задачей и журналом. Идентификатор Codex сохраняется при thread.started, до завершения процесса.

Codex запускается через exec с JSONL, stdin и workspace-write, без запросов подтверждения. Правила этапа читаются из того же файла supervisor/skills и передаются в назначении. Разрешения Claude не объявляются разрешениями Codex: его изоляция задаётся отдельно; предпроверка покрытия Claude для него не применяется. Сбой инструмента сам по себе не отменяет результат, но отсутствие завершения turn.completed не считается успехом.

У Codex нет total_cost_usd. Для подписки используем бюджет объёма работы в токенах; долларовая оценка не вычисляется.

Windows запускает npm-обёртку Codex через Node, без склейки аргументов оболочкой. Модель Codex задаётся отдельно от stageModel Claude, без выдуманного умолчания. Проверка доступности использует выбранного провайдера.

AGENTS.md кратко направляет к общим правилам CLAUDE.md и уточняет различия инструментов. Codex-навыки используют OpenSpec CLI и доступные средства чтения/редактирования, без инструментов Claude. Существующие навыки Claude сохраняются.

Проверки: локальные узкие тесты адаптера, конфигурации, супервизора и пускателя; полный CI в pull request. Живой конвейер и доска в проверках не запускаются.

Пользователь выбрал подписку ChatGPT: codexMaxTaskTokens=25000000, отдельно от денежного maxTaskCostUsd Claude (25).

## Token budget (ChatGPT subscription)
Codex uses a default 25,000,000 input + output token task budget. Cached input is included once. Calibration from 30 recent Claude result logs gives approximately 24,840,988 tokens per former $25 threshold; this is a workload heuristic, not pricing or subscription quota. Persist session maxima separately from stage reports in local codex-usage.json, including unsuccessful runs with reported usage. Resume, stage changes and forgotten sessions must not reset or double-charge the ledger. Check at stage boundaries and send over-budget tasks to decompose; decompose and crosscut recovery remain exempt. The ledger belongs to the supervisor root and must accompany it when moving machines. Missing usage is unknown, not zero; timeouts remain necessary because CLI usage arrives only at turn completion.
