## Why

После восстановления SSH в Windows unelevated sandbox два этапа упали на git push: MSYS sh.exe не смог создать signal pipe. Проверка gh api user этого не обнаружила, потому что Git использовал отдельный shell credential helper.

## What Changes

- Передавать GitHub HTTP-авторизацию непосредственно Git через окружение, без shell helper.
- Сохранить точное доверие Git к основному и назначенному деревьям, без глобальных записей.
- Добавить в стартовую пробу git push --dry-run до захвата задач.

## Capabilities

### New Capabilities

- `codex-native-git-auth`: авторизация Git без дочерней оболочки и проверка отправки при старте.

### Modified Capabilities

Нет.

## Impact

Адаптер, окружение Codex, супервизор, проверка готовности и документация. На отзывчивость игры и игровой трафик влияния нет; на старте добавляется HTTPS-проверка Git.

## Non-goals

Не изменять SSH-ключи, сервер, политики sandbox, Claude или права GitHub-токена. Не публиковать ветку во время стартовой пробы.
