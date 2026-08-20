import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Приём записи матча из браузера — только в режиме разработки.
 *
 * Живёт в `configureServer`, то есть в собранное приложение не попадает
 * физически, а не по условию. В промышленной сборке этого обработчика
 * не существует.
 *
 * ## Почему именно так, а не иначе
 *
 * Рассматривались четыре способа доставки. `console.log` обрезается
 * и трёх тысяч строк не переживёт. Скачивание файлом кладёт его в папку
 * загрузок браузера, найти которую надёжно на Windows — отдельная возня.
 * Через игровой сервер — плохо по существу: он намеренно диагностический
 * и на матч не влияет, а вдобавок это отдельный процесс, который может
 * быть не запущен. `localStorage` всё равно упирается в «как достать
 * файл».
 *
 * Обработчик в сервере разработки кладёт файл ровно туда, где его удобно
 * читать, и не требует ничего, кроме уже запущенного `pnpm dev`.
 *
 * ## Он пишет в файловую систему по запросу из браузера
 *
 * И относиться к нему надо соответственно, даже если он живёт полчаса
 * в день на машине разработчика. Отсюда три ограничения:
 *
 * - имя файла составляет обработчик, а не запрос. Из тела берётся только
 *   идентификатор матча, и тот процеживается до букв, цифр и дефиса;
 * - предел на размер тела: браузер шлёт десятки килобайт, и всё, что
 *   заметно больше, — не наша запись;
 * - каталог фиксирован.
 */

/** Предел размера одной отправки. Обычная порция — десятки килобайт. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Куда складываются записи. Тот же каталог, что читает арена. */
const LOG_DIR = '.matchlog';

const ENDPOINT = '/__matchlog';

/**
 * Имя матча — только буквы, цифры и дефис.
 *
 * Не «экранируем опасные символы», а «оставляем безопасные»: перечислить
 * то, что разрешено, надёжнее, чем угадать всё, что запрещено. Переходы
 * по каталогам, двоеточия дисков и нулевые байты отсеиваются этим сами
 * собой.
 */
export const safeName = (raw: unknown): string => {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = text.replace(/[^A-Za-z0-9-]/gu, '').slice(0, 64);

  return cleaned.length > 0 ? cleaned : 'match';
};

export const matchLogPlugin = (): Plugin => ({
  name: 'td-matchlog',
  apply: 'serve',

  configureServer(server) {
    const dir = resolve(server.config.root, '..', '..', LOG_DIR);

    server.middlewares.use(ENDPOINT, (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;

      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          response.statusCode = 413;
          response.end();
          request.destroy();
          return;
        }

        chunks.push(chunk);
      });

      request.on('end', () => {
        if (response.writableEnded) return;

        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            matchId?: unknown;
            lines?: unknown;
          };

          const lines = Array.isArray(body.lines) ? body.lines.filter((l) => typeof l === 'string') : [];
          if (lines.length === 0) {
            response.statusCode = 400;
            response.end();
            return;
          }

          mkdirSync(dir, { recursive: true });
          // Имя составляется здесь и только здесь. Путь из тела запроса
          // не используется ни при каких условиях.
          appendFileSync(join(dir, `human-${safeName(body.matchId)}.jsonl`), `${lines.join('\n')}\n`);

          response.statusCode = 204;
          response.end();
        } catch {
          response.statusCode = 400;
          response.end();
        }
      });
    });
  },
});
