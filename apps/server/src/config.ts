import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_PORT = Number(process.env['PORT'] ?? 3001);
export const SERVER_HOST = process.env['HOST'] ?? '127.0.0.1';

/**
 * Корень репозитория — каталог с `pnpm-workspace.yaml`.
 *
 * Ищется вверх от места запуска, а не берётся из `process.cwd()`: сервер
 * поднимают и из корня, и из своего каталога через turbo, а записи в обоих
 * случаях должны ложиться туда, где их ищет арена.
 */
const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }

  return process.cwd();
};

/**
 * Значения, которыми настройку выключают.
 *
 * Перечислены все привычные написания, а не одно: тот, кто пишет
 * `MATCHLOG=false`, имеет в виду ровно то же, что и тот, кто пишет
 * `MATCHLOG=0`, и получить вместо этого включённую запись он не ожидает.
 */
const OFF_VALUES = new Set(['0', 'false', 'off', 'no', '']);

/**
 * Пишутся ли матчи.
 *
 * По умолчанию — да, и умолчание это перевёрнутое: сперва запись включали
 * флагом. Перевернуто по опыту. Запись, которую надо помнить включить,
 * выключена всегда: за первый вечер игры не сохранилось ни одного матча,
 * причём флаг был выставлен — его отбросил turbo, не объявленный
 * в `turbo.json` (см. `passThroughEnv` задачи `dev`).
 *
 * Цена ошибки несимметрична. Лишний файл на местном диске удаляется одной
 * командой; матч, который не записался, не восстановить ничем — он был
 * один раз.
 *
 * Что защищало прежнее умолчание, никуда не делось и делается теперь явно:
 * каталог местный и вне системы контроля версий, наружу ничего не уходит,
 * автоматические проверки отказываются от записи параметром `buildServer`,
 * а сервер, доступный кому-либо кроме разработчика, поднимают
 * с `MATCHLOG=0` — до тех пор, пока не решён вопрос о согласии игрока
 * на запись его партий.
 */
const matchlogValue = process.env['MATCHLOG'];

export const MATCHLOG_ENABLED =
  matchlogValue === undefined || !OFF_VALUES.has(matchlogValue.trim().toLowerCase());

/** Куда складывать записи. Тот же каталог, из которого читает арена. */
export const MATCHLOG_DIR = resolve(process.env['MATCHLOG_DIR'] ?? join(repoRoot(), '.matchlog'));
