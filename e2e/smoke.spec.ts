import { expect, test } from '@playwright/test';
import { bootGame, diagnostic, diagnosticNumber, number, openMatchMenu } from './helpers.js';

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

  // Связь показывается строкой текста вверху экрана, а не панелью в углу.
  await expect(page.getByTestId('connection-status')).toBeInViewport();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');

  // Сервер отвечает на ping: счётчик ответов растёт.
  // Пинг уходит раз в секунду, поэтому даём запас в 5 секунд.
  await expect(page.getByTestId('diagnostics')).not.toHaveAttribute('data-pong-count', '0', {
    timeout: 5000,
  });
});

test('панели не перекрывают игровое поле', async ({ page }) => {
  await bootGame(page);

  // Окно задаётся явно, и это не придирка. Требование «тулбар умещается
  // без прокрутки» записано для 1920 x 1080, и мерить его в другом окне
  // значит мерить не ту величину: в узком окне тулбар из десяти плиток
  // намеренно едет вбок, и это задуманное поведение, а не поломка.
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Главное свойство раскладки, и проверять его глазами нельзя: панель,
  // наехавшая на поле, закрывает собой клетки, на которых идёт бой,
  // и заметно это становится только в бою.
  const canvas = await page.locator('#scene canvas').boundingBox();
  const top = await page.locator('#hud-top').boundingBox();
  const bottom = await page.locator('#hud-bottom').boundingBox();

  expect(canvas).not.toBeNull();
  expect(top).not.toBeNull();
  expect(bottom).not.toBeNull();

  if (canvas === null || top === null || bottom === null) return;

  // Поле начинается не выше нижнего края верхней полосы...
  expect(canvas.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
  // ...и кончается не ниже верхнего края тулбара.
  expect(canvas.y + canvas.height).toBeLessThanOrEqual(bottom.y + 1);
  // И при этом поле осталось основной частью экрана, а не полоской
  // между двумя панелями.
  expect(canvas.height).toBeGreaterThan(top.height + bottom.height);

  // Полосы обрезают содержимое по своей высоте — иначе они наехали бы
  // на поле. Обрезка эта молчаливая: не влезшая строка просто исчезает,
  // и заметить это можно только глазами и только если знать, что искать.
  // Поэтому переполнение проверяется здесь.
  const overflow = await page.evaluate(() =>
    ['#hud-top', '#hud-bottom'].map((selector) => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      return {
        selector,
        высота: el.scrollHeight > el.clientHeight,
        ширина: el.scrollWidth > el.clientWidth,
      };
    }),
  );

  expect(overflow).toEqual([
    { selector: '#hud-top', высота: false, ширина: false },
    { selector: '#hud-bottom', высота: false, ширина: false },
  ]);

  // Смена высоты полосы БЕЗ изменения окна доходит до сцены.
  //
  // Это единственный путь, который обработчик у окна не покрывает: окно
  // не менялось, события resize не будет. Ради него и заведён наблюдатель
  // за контейнером, и без проверки он однажды тихо перестанет работать —
  // а поле останется прежнего размера под полосой другого.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--td-hud-bottom', '300px');
  });

  await expect
    .poll(async () => (await page.locator('#scene canvas').boundingBox())?.height ?? 0, {
      timeout: 5000,
    })
    .toBeLessThan(canvas.height);

  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--td-hud-bottom');
  });

  await expect
    .poll(async () => (await page.locator('#scene canvas').boundingBox())?.height ?? 0, {
      timeout: 5000,
    })
    .toBe(canvas.height);
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

  // Ждём, а не читаем разом: seed попадает в разметку с первым снимком
  // карты, а тот приходит на кадр-другой позже, чем появляется холст.
  await expect(page.getByTestId('diagnostics')).not.toHaveAttribute('data-seed', '0');

  const seedBefore = await diagnostic(page, 'seed');
  expect(Number(seedBefore)).toBeGreaterThan(0);

  // Видимая доля карты — требование дизайна, а не украшение, и записано
  // оно для стандартного окна 1920 × 1080. Прогон идёт в окне поменьше,
  // поэтому окно задаётся явно: иначе проверялась бы не та величина,
  // о которой требование, и границы пришлось бы ослабить до бессмыслицы.
  //
  // Заодно проверяется, что смена размера доходит до сцены: доля считается
  // по площади ПОЛЯ, а поле пересчитывается наблюдателем за контейнером,
  // и застрявшая на прежних размерах камера видна здесь же.
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Обе границы важны. Карта целиком на экран помещаться не должна, иначе
  // перемещение взгляда перестаёт быть частью игры; но и щель между
  // панелями полем не считается.
  await expect
    .poll(async () => diagnosticNumber(page, 'visible-percent'), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(25);

  expect(await diagnosticNumber(page, 'visible-percent')).toBeLessThan(55);

  // «Новый матч» переехал в меню матча: раз за партию он не стоит
  // постоянной кнопки на экране.
  //
  // Против компьютера это новый матч на сервере, а не смена карты
  // в своём браузере: клиент выходит из комнаты и входит в следующую
  // дежурную. Поэтому и ждать приходится дольше.
  await openMatchMenu(page);
  await page.getByTestId('restart').click();
  await expect(page.locator('#scene canvas')).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(async () => diagnostic(page, 'seed'), { timeout: 20_000 })
    .not.toBe(seedBefore);
});

test('матч идёт: энергия копится, обе стороны видны', async ({ page }) => {
  await bootGame(page);

  await expect(page.getByTestId('match-bar')).toBeVisible();
  await expect(page.getByTestId('production-panel')).toBeVisible();
  await expect(page.getByTestId('build-panel')).toBeVisible();

  // Обе стороны на месте, и своя помечена именем, которым игрок
  // представился.
  await expect(page.getByTestId('side-own')).toContainText('Тестер');
  await expect(page.getByTestId('match-opponent')).toBeVisible();
  await expect(page.getByTestId('side-computer')).toBeVisible();

  // Прочность базы видна по обеим сторонам, не глядя на сами базы.
  // Это условие победы, и до сих пор его на экране не было вовсе.
  await expect(page.getByTestId('base-health-own')).toBeVisible();
  await expect(page.getByTestId('base-health-enemy')).toBeVisible();

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

  // Заодно проверяется, что состав в верхней полосе считается ПО ТИПАМ,
  // а не одним числом на всех: заказаны только штурмовики, и вырасти
  // должен только их счётчик.
  expect(await number(page, 'own-unit-0')).toBeGreaterThanOrEqual(10);
  expect(await number(page, 'own-unit-1')).toBe(0);
  expect(await number(page, 'own-unit-2')).toBe(0);
});

test('режим строительства включается, а Esc сначала гасит его и лишь потом открывает меню', async ({
  page,
}) => {
  await bootGame(page);

  const wallTile = page.getByTestId('build-1');

  // Клавишей, а не мышью: `Q` включает режим, цифра выбирает вид.
  // Заказ юнита при этом остаётся одним нажатием — цифры принадлежат
  // юнитам, пока режим не включён.
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('Digit1');

  // Активный вид подсвечивается акцентной рамкой.
  await expect(wallTile).toHaveCSS('border-color', 'rgb(0, 255, 41)');

  // Отмена режима — действие частое и совершается не глядя. Меню,
  // перехватывающее Esc всегда, отняло бы у игрока привычный способ
  // передумать, поэтому порядок именно такой и проверяется явно.
  await page.keyboard.press('Escape');
  await expect(wallTile).not.toHaveCSS('border-color', 'rgb(0, 255, 41)');
  await expect(page.getByTestId('match-menu')).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('match-menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('match-menu')).toBeHidden();
});

test('прокачка живёт в тулбаре и поднимает саму характеристику', async ({ page }) => {
  await bootGame(page);

  // Ветка 0 — атака штурмовика. Показывается ДЕЙСТВУЮЩЕЕ значение,
  // и главное свойство изменения в том, что после покупки растёт именно
  // оно, а не номер уровня.
  const value = page.getByTestId('stat-value-0');
  await expect(value).toBeVisible();

  const before = await number(page, 'stat-value-0');
  expect(before).toBeGreaterThan(0);

  await page.getByTestId('upgrade-0').click();

  await expect
    .poll(async () => number(page, 'stat-value-0'), { timeout: 8000 })
    .toBeGreaterThan(before);

  // Добыча энергии переехала на плитку базы: группы без объекта на поле
  // больше нет. Подпись короткая — в столбец под плиткой полное название
  // не помещается, полное живёт в подсказке при наведении.
  await expect(page.getByTestId('focus-base')).toContainText('добыча');
  await expect(page.getByTestId('focus-base')).toContainText('База');
});

test('плитки генерала и базы переносят камеру, а не заказывают', async ({ page }) => {
  await bootGame(page);

  // Плитка, нажатие по которой не делает ничего, была бы ловушкой:
  // игрок нажмёт и решит, что интерфейс сломался. Поэтому у своих
  // объектов нажатие переносит камеру.
  //
  // Сам перенос из разметки не наблюдается — камера живёт в сцене
  // и в DOM не выводится, — но проверить, что нажатие НЕ заказывает
  // и НЕ тратит, можно и нужно: это и есть отличие своих объектов
  // от заказываемых.
  const unitsBefore = await number(page, 'unit-count');
  const energyBefore = await number(page, 'energy');

  await page.getByTestId('focus-base-select').click();
  await page.getByTestId('focus-general-select').click();

  expect(await number(page, 'unit-count')).toBe(unitsBefore);
  // Энергия копится сама, поэтому проверяется, что она не УПАЛА:
  // заказ или покупка отняли бы её.
  expect(await number(page, 'energy')).toBeGreaterThanOrEqual(energyBefore);

  // И ни одного отказа: нажатие было законным.
  await expect(page.getByTestId('notices')).toHaveCount(0);
});

test('цель атаки назначается кнопкой-режимом', async ({ page }) => {
  await bootGame(page);

  // Кнопка существует ради касания: цель ставит правая кнопка мыши,
  // а у пальца кнопок нет вовсе. Проверяется здесь мышью — грамматика
  // у обоих одна, а сенсорный ввод покрыт юнит-тестами управления.
  const tile = page.getByTestId('aim-target');
  await expect(tile).toBeVisible();

  // Режим подсвечивается той же акцентной рамкой, что и стройка с ударом.
  await page.getByTestId('aim-target-select').click();
  await expect(tile).toHaveCSS('border-color', 'rgb(0, 255, 41)');

  // Esc снимает режим наравне с прочими — и меню при этом не открывает.
  await page.keyboard.press('Escape');
  await expect(tile).not.toHaveCSS('border-color', 'rgb(0, 255, 41)');
  await expect(page.getByTestId('match-menu')).toBeHidden();
});

test('R сворачивает характеристики, оставляя плитки, и поле растёт', async ({ page }) => {
  await bootGame(page);

  await expect(page.getByTestId('stat-value-0')).toBeVisible();
  const fieldBefore = (await page.locator('#scene canvas').boundingBox())?.height ?? 0;

  await page.keyboard.press('KeyR');

  // Столбцы ушли, плитки остались: сворачивают подробности, а не действия.
  await expect(page.getByTestId('stat-value-0')).toBeHidden();
  await expect(page.getByTestId('train-0')).toBeVisible();
  await expect(page.getByTestId('build-1')).toBeVisible();

  // Полоса стала ниже, значит поле выросло — и сцена об этом узнала.
  await expect
    .poll(async () => (await page.locator('#scene canvas').boundingBox())?.height ?? 0, {
      timeout: 5000,
    })
    .toBeGreaterThan(fieldBefore);

  await page.keyboard.press('KeyR');
  await expect(page.getByTestId('stat-value-0')).toBeVisible();
});

test('частота кадров держится при непрерывном движении камеры', async ({ page }) => {
  await bootGame(page);

  // Прокручиваем карту стрелкой и смотрим, что показывает счётчик кадров.
  // Счётчик считает сам игровой цикл, то есть меряем ровно то, что видит
  // игрок, а не синтетический бенчмарк.
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(3000);

  const fps = await diagnosticNumber(page, 'fps');

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
  expect(await diagnosticNumber(page, 'fps')).toBeGreaterThanOrEqual(55);
});

