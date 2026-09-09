# Контракт процесса review-ci

Проверено 09.09.2026 в назначенном дереве: Node v24.3.0, PowerShell
7.6.5, gh 2.98.0. Последнее изменение bin: 94f668957c1860052694b03986b7ded6447c77dc.
В тесте gh заменён на границе execFileSync; настоящий bin, разбор аргументов,
command-runner и алгоритм подтверждения выполняются дочерним Node.

`npx vitest run --root supervisor lib/review-ci.test.mjs lib/review-ci-process.test.mjs`:
114 тестов выполнены, оба файла прошли без пропусков. Прямой процесс выдаёт
один JSON, пустой stderr, signal=null: success/0, failure/1, UNKNOWN/pending/2,
ошибка транспорта/pending/2, новый head/pending/2, conflict/3, подтверждённое
противоречие/success/0. Неверные аргументы дают 64 без обращения к gh.

Для того же UNKNOWN вызов через `pwsh -NoProfile -NonInteractive -Command`
даёт тот же JSON pending, но status=1; прямой Node даёт status=2. Потери
кода в bin нет: наблюдаемая единица относится к завершению оболочки.
Тест не меняет рабочий CLI и не добавляет флаг принятия сохранённого допуска.

Источники истории в основном дереве, прочитаны без изменения:

- `.pipeline/logs/0310-sohranyat-run-params-pri-zapisi-i-chteni-review.log`,
  строки 50–51: pwsh -Command, PR 238, SHA
  2d8156836a91d66758156c05e3548a965f9b2116, pending UNKNOWN, exit_code=1.
- `.pipeline/logs/0309-otlichat-ispolnyaemye-perf-komandy-bench-review.log`,
  строки 49–50: pwsh -Command, PR 239, SHA
  88440d88f86bb55922804e6a74589bcaabba71cf, pending UNKNOWN, exit_code=1.

Исторические логи не содержат прямого кода Node или версий тогдашних
Node/PowerShell/gh. Поэтому нормализация воспроизведена на нынешней оболочке,
а не доказана задним числом для старого процесса. Единицу оболочки нельзя
записывать как exitCode=1 CLI при pending. Потребителю нужен достоверный код
дочернего процесса; необъяснённая пара остаётся ошибкой вызова.
