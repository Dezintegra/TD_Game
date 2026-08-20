import { expect, test } from '@playwright/test';
import { bootGame, number } from './helpers.js';

/**
 * Сквозные проверки.
 *
 * Здесь проверяется не геймплей в деталях — для этого есть модульные
 * тесты ядра, — а то, что вертикаль собрана: клиент поднимается, PixiJS
 * рисует, симуляция крутится, ввод доходит до мира, а интерфейс
 * показывает его состояние.
 *
 * Матч, в котором это проверяется, — тренировочный: он начинается
 * одним нажатием и не требует второго человека. Комнаты и матч
 * из комнаты проверяются отдельно, в `lobby.spec.ts`.
 */

test('клиент поднимается, рисует поле и общается с сервером', async ({ page }) => {
  await bootGame(page);

  const canvas = page.locator('#scene canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box?.width).toBeGreaterThan(0);
  expect(box?.height).toBeGreaterThan(0);

  // HUD виден поверх поля. Проверка не формальная: сцена добавляется
  // в DOM после монтирования HUD, и при неверном порядке слоёв canvas
  // целиком закрывает интерфейс, оставаясь при этом «найденным» в DOM.
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByText('Соединение')).toBeInViewport();

  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');

  // Сервер отвечает на ping: счётчик ответов растёт.
  // Пинг уходит раз в секунду, поэтому даём запас в 5 секунд.
  await expect(page.getByTestId('pong-count')).not.toHaveText('0', { timeout: 5000 });
});

test('страница загружается без ошибок в консоли', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // Проходим весь путь, а не только загрузку: представление и список
  // комнат — такая же часть приложения, как и матч, и ошибка в них
  // должна ловиться здесь же.
  await bootGame(page);

  expect(errors).toEqual([]);
});

test('карта показывается и матч начинается заново по кнопке', async ({ page }) => {
  await bootGame(page);

  const seedBefore = await page.getByTestId('seed').textContent();
  expect(Number(seedBefore)).toBeGreaterThan(0);

  // Видимая доля карты — требование дизайна, а не украшение. Верхняя
  // граница важнее нижней: карта целиком на экран помещаться не должна,
  // иначе перемещение взгляда перестаёт быть частью игры.
  const visible = await number(page, 'visible-percent');
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThan(60);

  await page.getByTestId('restart').click();
  await expect(page.getByTestId('seed')).not.toHaveText(seedBefore ?? '');
});

test('матч идёт: энергия копится, панели матча на месте', async ({ page }) => {
  await bootGame(page);

  await expect(page.getByTestId('match-bar')).toBeVisible();
  await expect(page.getByTestId('production-panel')).toBeVisible();
  await expect(page.getByTestId('build-panel')).toBeVisible();

  const before = await number(page, 'energy');
  await page.waitForTimeout(3000);
  const after = await number(page, 'energy');

  // Доход начисляется каждый тик независимо от действий игрока.
  expect(after).toBeGreaterThan(before);
  await expect(page.getByTestId('target')).toHaveText('Командный центр');
});

test('заказ юнита с клавиатуры доходит до симуляции', async ({ page }) => {
  await bootGame(page);

  await page.keyboard.press('Digit1');

  // Отката у производства нет: юнит выходит на ближайшем тике. Запас
  // по времени оставлен на подъём сцены и первый кадр, а не на очередь.
  await expect(page.getByTestId('unit-count')).not.toHaveText('0', { timeout: 8000 });
});

test('заказ пачки с зажатым модификатором даёт десять юнитов', async ({ page }) => {
  await bootGame(page);

  // Shift, а не Ctrl: Ctrl с цифрой браузер оставляет себе — это
  // переключение вкладок, и до страницы событие не доходит. По кнопке
  // панели работают оба.
  await page.keyboard.press('Shift+Digit1');

  await expect
    .poll(async () => number(page, 'unit-count'), { timeout: 8000 })
    .toBeGreaterThanOrEqual(10);
});

test('режим строительства включается и выключается', async ({ page }) => {
  await bootGame(page);

  const wallTile = page.getByTestId('build-1');
  await wallTile.click();
  // Активный режим подсвечивается акцентной рамкой.
  await expect(wallTile).toHaveCSS('border-color', 'rgb(0, 255, 41)');

  await page.keyboard.press('Escape');
  await expect(wallTile).not.toHaveCSS('border-color', 'rgb(0, 255, 41)');
});

test('панель прокачки разворачивается и показывает ветки', async ({ page }) => {
  await bootGame(page);

  await page.getByTestId('upgrade-toggle').click();

  // Ветки строятся из таблицы баланса, поэтому достаточно проверить,
  // что список непустой и первая ветка кликабельна.
  await expect(page.getByTestId('upgrade-0')).toBeVisible();
  await expect(page.getByText('Добыча энергии')).toBeVisible();
});

test('частота кадров держится при непрерывном движении камеры', async ({ page }) => {
  await bootGame(page);

  // Прокручиваем карту стрелкой и смотрим, что показывает счётчик кадров.
  // Счётчик считает сам игровой цикл, то есть меряем ровно то, что видит
  // игрок, а не синтетический бенчмарк.
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(3000);

  const fps = await number(page, 'fps');

  await page.keyboard.up('ArrowRight');

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
  expect(await number(page, 'fps')).toBeGreaterThanOrEqual(55);
});
