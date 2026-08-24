/**
 * Снимок пробной страницы `apps/client/fx-probe.html`.
 *
 * Временная оснастка изменения по облику выстрелов, взрывов и зеркала
 * поля. Нужна потому, что панель браузера в сессиях по этому проекту
 * может не отображаться, и обычный скриншот падает по таймауту, —
 * а Playwright с настоящим окном страницу снимает.
 *
 * Использование (клиент должен быть уже поднят на 5173):
 *
 *   node scripts/fx-probe-shot.mjs <путь.png> [x y ширина высота]
 *
 * Без рамки снимается весь лист. Явный `clip` обязателен: `fullPage`
 * по этой странице виснет и падает по таймауту уже после загрузки
 * шрифтов.
 */
import { chromium } from '@playwright/test';

const out = process.argv[2];
if (out === undefined) throw new Error('нужен путь для снимка');

// Какую пробную страницу снимать. По умолчанию — лист «до и после».
const target = process.env.FX_PAGE ?? 'fx-probe.html';

const browser = await chromium.launch();
// Окно заведомо выше листа: `clip` за пределами видимой области
// обрезается по ней, и нижняя панель просто не попадёт в снимок.
const page = await browser.newPage({
  viewport: { width: 1600, height: 3000 },
  deviceScaleFactor: 2,
});

page.on('console', (message) => {
  if (message.type() === 'error') console.error('консоль:', message.text());
});

await page.goto(`http://localhost:5173/${target}`, { waitUntil: 'load' });

// Строкой, а не стрелкой: выражение уезжает в браузер, и `document`
// здесь — не глобальное имя Node, о котором линту пришлось бы спорить.
await page.waitForFunction("document.title.startsWith('проба ')", null, { timeout: 60000 });
const title = await page.title();
if (!title.startsWith('проба готова')) throw new Error(`проба не собралась: ${title}`);
console.log(title);

// Размеры холста берутся у самой страницы: у разных проб они разные.
const canvas = await page.evaluate(
  "(() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : [1560, 1400]; })()",
);
const box = process.argv.slice(3).map(Number);
const clip =
  box.length === 4
    ? { x: box[0], y: box[1], width: box[2], height: box[3] }
    : { x: 0, y: 0, width: canvas[0], height: canvas[1] };

await page.screenshot({ path: out, clip });
await browser.close();
console.log('снято:', out);
