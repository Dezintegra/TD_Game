import { expect, test } from '@playwright/test';
import { bootGame, matchSnapshot, medianFps, number, rockDiagnostics } from './helpers.js';
import { record, runContext } from './perf-record.js';

/**
 * Замеры частоты кадров.
 *
 * Вынесены из `smoke.spec.ts` в отдельный набор, потому что это НЕ проверка
 * правильности, а измерение — и живёт оно по другим законам.
 *
 * Во-первых, измерению нужна тихая машина. Замер 22.08.2026: при пяти
 * рабочих потоках и чужих серверах на той же машине выходило 45–51 кадра
 * при пороге 55, а те же тесты в одиночку проходили. Красный результат
 * означал бы «машина занята», а не «код стал медленнее», — а такой
 * результат хуже отсутствия результата, потому что ему верят.
 *
 * Во-вторых, на runner'ах GitHub видеокарты нет вовсе: Chromium рисует
 * программно, через SwiftShader, и выдаёт около шестнадцати кадров
 * на любой сцене. Порог 55 там недостижим в принципе, поэтому в CI
 * этот набор не гоняется — `playwright.config.ts` исключает
 * `*.perf.spec.ts` из обычного прогона.
 *
 * Запускать через `pnpm e2e:perf`: обёртка сначала убеждается, что машина
 * свободна и что замер не ведёт кто-то ещё. Прогон обязателен перед
 * деплоем и предлагается по ходу обычной задачи, когда правка могла
 * задеть отрисовку.
 *
 * В-третьих, каждая сцена снимает вокруг своего окна обстановку матча
 * (`matchSnapshot` до и после). Одно число кадров описывает следствие
 * и молчит о причине: восемь кадров выходят и при просевшей отрисовке,
 * и при главном потоке, вставшем колом на догоне истории. Отличает их
 * ход мира — сервер держит тридцать тиков в секунду независимо
 * от машины, так что за шестисекундное окно тик обязан вырасти примерно
 * на сто восемьдесят. В том разборе он вырос на пятьсот с лишним.
 */

test('частота кадров держится при непрерывном движении камеры', async ({ page }) => {
  await bootGame(page);

  // Прокручиваем карту стрелкой и смотрим, что показывает счётчик кадров.
  // Счётчик считает сам игровой цикл, то есть меряем ровно то, что видит
  // игрок, а не синтетический бенчмарк.
  await page.keyboard.down('ArrowRight');

  // Три секунды на разогрев: первые секунды матча заняты запеканием
  // рельефа, и посекундное наблюдение показывает там 14, 28, 28, а дальше
  // ровные шестьдесят. Мерить разогрев незачем — его надо переждать.
  await page.waitForTimeout(3000);
  await expect
    .poll(async () => (await rockDiagnostics(page))?.initialRemaining, { timeout: 30000 })
    .toBe(0);

  // Снимок берётся ПОСЛЕ разогрева: длинные кадры запекания рельефа
  // остаются за скобками окна и в разность не попадают.
  const before = await matchSnapshot(page);
  const rocksBefore = await rockDiagnostics(page);
  const box = (await page.locator('#scene canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const fps = await medianFps(page, 6, async (index) => {
    // Меняем масштаб и направление ВНУТРИ окна; постоянное движение не должно голодать догон.
    await page.keyboard.up(index % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
    await page.keyboard.down(index % 2 === 0 ? 'ArrowLeft' : 'ArrowRight');
    await page.mouse.wheel(0, index % 2 === 0 ? -10000 : 10000);
  });
  const after = await matchSnapshot(page);
  const rocksAfter = await rockDiagnostics(page);

  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('ArrowLeft');

  const context = { ...runContext(before, after), rocksBefore, rocksAfter };
  record('камера в движении', fps, context);
  expect(rocksAfter?.terrainRebuildCount).toBe(rocksBefore?.terrainRebuildCount);
  expect(fps).toBeGreaterThanOrEqual(55);
});

test('частота кадров держится, когда на поле появились войска', async ({ page }) => {
  await bootGame(page);

  // Выводим войско на поле и даём противнику развернуться.
  for (let order = 0; order < 8; order += 1) {
    await page.keyboard.press('Shift+Digit1');
  }
  await page.waitForTimeout(8000);

  expect(await number(page, 'unit-count')).toBeGreaterThan(0);

  const before = await matchSnapshot(page);
  const fps = await medianFps(page);
  const after = await matchSnapshot(page);

  record('войска на поле', fps, runContext(before, after));
  expect(fps).toBeGreaterThanOrEqual(55);
});
