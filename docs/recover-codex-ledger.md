# Восстановление legacy Codex ledger

Команда работает только с явными путями и сначала только показывает план:

```powershell
node supervisor/bin/recover-codex-ledger.mjs --root C:\src\dezintegra\TD_Game --sessions-root C:\Users\<you>\.codex\sessions
```

Для записи нужен отдельный явный ключ:

```powershell
node supervisor/bin/recover-codex-ledger.mjs --root C:\src\dezintegra\TD_Game --sessions-root C:\Users\<you>\.codex\sessions --apply
```

`--apply` откажется при живом либо неоднозначном `supervisor.lock`. Перед
атомарной заменой он сверяет исходное содержимое ledger, сохраняет резервную
копию рядом с `codex-usage.json` и никогда не пишет её при dry-run.

Команда принимает единственный JSONL, подтверждённый `session_meta.id`,
`thread_id`/`session_id` и `cwd` рабочего дерева задачи. Приоритет имеют
накопительные `token_usage_record.thread_token_usage`; старый `token_count`
допустим лишь как непрерывный монотонный след без records. Повреждение,
неоднозначность, неполный turn, повторный конфликтующий `response_id`, сброс
счётчика или меньшая доказанная сумма остаются в `unresolved`.

В v2 меняются только доказанные session snapshot и неуменьшающийся
`knownTokens`; снимается только `legacy-unknown`. Никакие записи и остальные
причины неполноты команда не удаляет.
