import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  bootGame,
  diagnostic,
  diagnosticNumber,
  number,
  openMatchMenu,
  unitTally,
} from './helpers.js';

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

  // Прибор картинки жив: мир на экране двигается, и промежутки между
  // его продвижениями считаются.
  //
  // Величина здесь не проверяется, и это осознанно. На runner'е нет
  // видеокарты, Chromium рисует программно и выдаёт около шестнадцати
  // кадров, поэтому показ обновляется вдвое реже тика — по делу, а не
  // по поломке. Порог здесь означал бы проверку железа, а не кода;
  // настоящая величина снимается на боевом стенде.
  await expect(page.getByTestId('diagnostics')).not.toHaveAttribute('data-display-gap-p95', '0', {
    timeout: 10_000,
  });

  // Приборы скачков подключены. Проверяется наличие, а не величина,
  // и это осознанно: порог здесь стал бы плавающим отказом. На петлевом
  // соединении команды не опаздывают, скачков быть не должно — но
  // на загруженном runner'е доставка проседает, и «ноль» превратился бы
  // в проверку расторопности железа. Величину снимают на боевом стенде.
  const diagnostics = page.getByTestId('diagnostics');
  await expect(diagnostics).toHaveAttribute('data-shifted-commands', /\d+/);
  await expect(diagnostics).toHaveAttribute('data-jump-count', /\d+/);
  await expect(diagnostics).toHaveAttribute('data-jump-max-cells', /[\d.]+/);
});

test('панели не перекрывают игровое поле', async ({ page }) => {
  await bootGame(page);

  // Окно задаётся явно, и это не придирка. Требование «тулбар умещается
  // без прокрутки» записано для 1920 x 1080, и мерить его в другом окне
  // значит мерить не ту величину: в узком окне тулбар из десяти плиток
  // намеренно едет вбок, и это задуманное поведение, а не поломка.
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Кнопка прокачки есть и на мониторе, и это не удобство, а видимость:
  // раньше прокачку разворачивала только клавиша R, и о самой
  // возможности на экране не сообщало ничто. Делает она ровно то же,
  // что клавиша.
  const upgrades = page.getByTestId('stats-toggle');
  await expect(upgrades).toBeVisible();

  const hud = page.getByTestId('hud');
  await expect(hud).toHaveAttribute('data-stats', 'open');
  await upgrades.click();
  await expect(hud).toHaveAttribute('data-stats', 'closed');
  await page.keyboard.press('KeyR');
  await expect(hud).toHaveAttribute('data-stats', 'open');

  // А кнопки меню на мониторе по-прежнему нет: там меню открывает Esc.
  await expect(page.getByTestId('menu-open')).toBeHidden();
  expect(await coveredButtons(page)).toBe(0);

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
  //
  // Срок проставлен явно — теми же двадцатью секундами, что стоят
  // у этого же ожидания в лобби и рядом в `bootGame`. Пяти секунд
  // по умолчанию здесь хватало бы и так: выше `bootGame` дожидается
  // подтверждённого тика, а тик приходит секунд на пять позже seed,
  // то есть к этой строке seed давно ненулевой. Но такая защита
  // наведённая — она держится на порядке шагов выше и на том, что
  // про эту связь кто-то помнит. Явный срок снимает зависимость
  // и убирает разнобой: одно и то же ожидание не должно выглядеть
  // в двух файлах по-разному, иначе его каждый раз перепроверяют
  // заново, чтобы убедиться, что это не пробел.
  await expect(page.getByTestId('diagnostics')).not.toHaveAttribute('data-seed', '0', {
    timeout: 20_000,
  });

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

  // Уходя, клиент отдаёт показания плавности. Проверка стоит здесь,
  // а не отдельным тестом, потому что своей партии ей не нужно —
  // а лишняя партия стоит двадцати секунд прогона.
  //
  // Прежде отчёт был привязан к исходу матча, и на боевом стенде это
  // означало «не уходит почти никогда»: выход исходом не считается,
  // сервер держит место ещё полминуты, и клиент успевает уйти
  // со страницы. Две минуты игры дали ноль принятых отчётов.
  const report = page.waitForRequest(
    (request) => request.url().includes('/api/telemetry') && request.method() === 'POST',
    { timeout: 15_000 },
  );

  await page.getByTestId('restart').click();
  await report;

  await expect(page.locator('#scene canvas')).toBeVisible({ timeout: 20_000 });

  await expect.poll(async () => diagnostic(page, 'seed'), { timeout: 20_000 }).not.toBe(seedBefore);
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

/**
 * Запас подтверждённых тиков, после которого счётчикам можно верить.
 *
 * Своя команда назначается на «подтверждённый тик плюс задержка ввода»,
 * а задержка ввода не превосходит девяти тиков — `INPUT_DELAY_MAX_TICKS`
 * в `packages/shared/src/constants.ts`. Пока подтверждение не перешагнуло
 * этот тик, показанный состав держится на командах, которые клиент ещё
 * только надеется провести: сервер их, может быть, и не принял.
 *
 * Пятнадцать вместо девяти — запас, а не круглое число: полсекунды
 * матча стоят дёшево. Но запас этот не бесконечный, и если предел
 * задержки когда-нибудь поднимут выше пятнадцати, поднять придётся
 * и здесь — иначе проверка снова начнёт верить предсказанию.
 */
const SETTLE_TICKS = 15;

test('заказ пачки с зажатым модификатором даёт десять юнитов', async ({ page }) => {
  await bootGame(page);

  // Shift, а не Ctrl: Ctrl с цифрой браузер оставляет себе — это
  // переключение вкладок, и до страницы событие не доходит. По кнопке
  // панели работают оба.
  await page.keyboard.press('Shift+Digit1');

  // Тик, с которого начинается отсчёт запаса, читается ПОСЛЕ нажатия:
  // к этому мгновению команды уже отданы, значит назначены они не позже
  // чем на «этот тик плюс задержка».
  const orderedAt = (await unitTally(page)).confirmedTick;

  // Всё утверждение целиком — одной повторяемой попыткой, и оба условия
  // внутри неё проверяются по ОДНОМУ снимку.
  //
  // Прежде здесь стояло ожидание суммарного счётчика, а следом отдельное
  // чтение счётчика по типу — и 24.08.2026 проверка упала на прогоне
  // 32783516359 с «ожидалось >= 10, получено 5», тогда как на снимке
  // экрана с того же падения стояло честное «10». Между двумя чтениями
  // прошла пересборка предсказания.
  //
  // Пачка — это десять отдельных команд, отданных подряд и назначенных
  // на один тик. Сервер опоздавшие не теряет, а переносит на ближайший
  // свободный (`clamp` в `packages/netplay/src/host.ts`), поэтому пачка
  // законно разъезжается по двум соседним тикам. Клиент же показал все
  // десять сразу — он предсказывал. Когда приходит кадр с первой
  // половиной, предсказанные команды на этом тике забываются целиком
  // (`forget` в `packages/netplay/src/guest.ts`), и счётчик на десятую
  // долю секунды честно показывает пять. На загруженном runner'е окно
  // это шире, и первое чтение попадало в пик, а второе — в провал.
  //
  // Ждать пика поэтому мало: пик рисует клиент, и он появился бы даже
  // если бы сервер заказ отверг целиком. Ждём состояния, в котором
  // предсказывать уже нечего.
  await expect(async () => {
    const tally = await unitTally(page);

    // Заказ дошёл до сервера, а не только до предсказания.
    expect(tally.confirmedTick).toBeGreaterThan(orderedAt + SETTLE_TICKS);

    expect(tally.byType[0]).toBeGreaterThanOrEqual(10);

    // Состав в верхней полосе считается ПО ТИПАМ, а не одним числом
    // на всех: заказаны только штурмовики, и вырасти должен только их
    // счётчик, а сумма обязана сойтись с ним одним.
    expect(tally.byType[1]).toBe(0);
    expect(tally.byType[2]).toBe(0);
    expect(tally.total).toBe(tally.byType[0]);
  }).toPass({ timeout: 15_000 });
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

test('заказ постройки снимает выделение', async ({ page }) => {
  await bootGame(page);

  // Камера переносится к своей базе, и середина холста оказывается на ней.
  // Способ надёжнее, чем гадать координаты клетки: база крупная, а кнопка
  // ставит её ровно в центр.
  await page.getByTestId('focus-base-select').click();

  // Без `position`: Playwright сам целит в середину холста.
  await page.locator('#scene canvas').click();
  await expect(page.getByTestId('structure-info')).toBeVisible();

  // Выбор вида постройки означает, что следующее нажатие по полю значит
  // не «выбери», а «поставь». Окно сведений в этот момент закрывает игроку
  // клетки — ровно те, в которые он прицеливается.
  await page.getByTestId('build-1-select').click();
  await expect(page.getByTestId('structure-info')).toBeHidden();
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

// Замеры частоты кадров переехали в `framerate.perf.spec.ts`: это измерение,
// а не проверка правильности, и ему нужна тихая машина. Запуск —
// `pnpm e2e:perf`.

/**
 * Телефон.
 *
 * Проверяется не «красиво ли», а то, до чего игрок дотягивается пальцем
 * и что он при этом видит. Каждое свойство здесь уже ломалось молча.
 *
 * Замерено до правки: содержимому нижней полосы нужно было 1022 точки
 * при 375, и на экране помещалось три плитки заказа из шести и ни одной
 * служебной. Полоса при этом молчала: прокрутка вбок ничем о себе
 * не сообщает, и «Тесла есть в игре» игрок узнавал случайно.
 *
 * `isMobile` и `hasTouch` обязательны, а не для красоты: без них
 * не срабатывает медиазапрос грубого указателя, цель нажатия остаётся
 * мышиной, и размеры выходят не те, что на устройстве.
 */

/** Ширина содержимого верхней полосы сверх её собственной. */
const barOverflow = async (page: Page): Promise<number> =>
  page.evaluate(() => {
    const el = document.querySelector('#hud-top');
    if (el === null) return -1;
    return el.scrollWidth - el.clientWidth;
  });

/** Переполнение нижней полосы: по ширине и по высоте. */
const bottomOverflow = async (page: Page): Promise<{ x: number; y: number }> =>
  page.evaluate(() => {
    const el = document.querySelector('#hud-bottom');
    if (el === null) return { x: -1, y: -1 };
    return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight };
  });

/**
 * Сколько кнопок тулбара нельзя нажать, потому что поверх их середины
 * лежит что-то другое.
 *
 * Проверять это глазами нельзя: кнопка видна целиком и выглядит рабочей,
 * а нажатие достаётся соседней плитке. Так и было — плитки не сжимались,
 * а группы плиток сжимались; плитки вылезали за границу своей группы,
 * и следующая группа вставала поверх них.
 */
const coveredButtons = async (page: Page): Promise<number> =>
  page.evaluate(() => {
    let covered = 0;
    for (const button of document.querySelectorAll('#hud-bottom button')) {
      const box = button.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top === null || !button.contains(top)) covered += 1;
    }
    return covered;
  });

/** Доля высоты окна, доставшаяся полю. */
const fieldShare = async (page: Page): Promise<number> => {
  const box = await page.locator('#scene canvas').boundingBox();
  if (box === null) return 0;
  return (box.height / page.viewportSize()!.height) * 100;
};

/** Размер холста сцены — им проверяется, что сцену никто не пересчитал. */
const canvasSize = async (page: Page): Promise<{ width: number; height: number }> => {
  const box = await page.locator('#scene canvas').boundingBox();
  return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
};

/** Обе сводки видны целиком, ни одна не уехала за край экрана. */
const sidesVisible = async (page: Page): Promise<void> => {
  const own = await page.getByTestId('side-own').boundingBox();
  const enemy = await page.getByTestId('match-opponent').boundingBox();
  const width = page.viewportSize()!.width;

  expect(own).not.toBeNull();
  expect(enemy).not.toBeNull();
  if (own === null || enemy === null) return;

  expect(own.x).toBeGreaterThanOrEqual(0);
  expect(enemy.x + enemy.width).toBeLessThanOrEqual(width + 1);
};

const ORDER_TILES = ['train-0', 'train-1', 'train-2', 'build-1', 'build-2', 'build-3'] as const;

/**
 * Где стоит заказ.
 *
 * Заказ теперь СТОЛБЕЦ у правого края поверх поля, а не строка в полосе,
 * поэтому мерятся обе оси: `rightGap` сторожит прижатие к краю (дуга
 * большого пальца), а `unitsTop` против `buildBottom` — порядок внутри
 * столбца. Юниты обязаны стоять НИЖЕ построек: заказ юнита это одно
 * нажатие, постановка постройки — два, и лучшее место в столбце
 * достаётся частому действию.
 *
 * «За краем экрана» проверяется и по высоте: столбец из шести плиток
 * в ландшафте укладывается в 311 точек впритык, и первая же лишняя
 * точка высоты плитки выгонит верхнюю за верхний край поля.
 */
const orderPlacement = async (
  page: Page,
): Promise<{ offScreen: number; rightGap: number; unitsTop: number; buildBottom: number }> => {
  const { width, height } = page.viewportSize()!;
  let offScreen = 0;
  let rightmost = 0;
  let unitsTop = Number.POSITIVE_INFINITY;
  let buildBottom = 0;

  for (const id of ORDER_TILES) {
    const box = await page.getByTestId(id).boundingBox();
    if (box === null) {
      offScreen += 1;
      continue;
    }
    if (box.x < 0 || box.x + box.width > width + 1) offScreen += 1;
    if (box.y < 0 || box.y + box.height > height + 1) offScreen += 1;
    rightmost = Math.max(rightmost, box.x + box.width);
    if (id.startsWith('train-')) unitsTop = Math.min(unitsTop, box.y);
    else buildBottom = Math.max(buildBottom, box.y + box.height);
  }

  return { offScreen, rightGap: width - rightmost, unitsTop, buildBottom };
};

/**
 * Сколько клеток видно по вертикали.
 *
 * Главная величина этого изменения: до него телефон в ландшафте
 * показывал 4,3 клетки — меньше дальности выстрела, — и игрок физически
 * не мог увидеть стрелка и его мишень одновременно.
 *
 * Считается высотой поля, делённой на высоту клетки при действующем
 * масштабе. Высота клетки берётся не из кода клиента, а собирается здесь
 * заново из углов проекции: проверка, зовущая проверяемую формулу,
 * сверяла бы её с самой собой.
 */
const visibleRows = async (page: Page): Promise<number> => {
  const box = await page.locator('#scene canvas').boundingBox();
  if (box === null) return 0;

  const scale = await diagnosticNumber(page, 'view-scale');
  if (!Number.isFinite(scale) || scale === 0) return 0;

  // 63 × (sin 40° + cos 40°) × sin 35° — высота ромба клетки на экране.
  const yaw = (40 * Math.PI) / 180;
  const cellHeight = 63 * (Math.sin(yaw) + Math.cos(yaw)) * Math.sin((35 * Math.PI) / 180);

  // Округление до сотых намеренно. Дефолтный масштаб подобран так, чтобы
  // клеток вышло РОВНО десять, и величина упирается в порог снизу:
  // последний бит двоичной дроби решает, будет это 10 или 9,999999.
  // Сотые доли клетки игроку не видны, а проверке дают устойчивость.
  return Number((box.height / (cellHeight * scale)).toFixed(2));
};

/** Все ветки прокачки, показанные на экране. */
const branchCount = async (page: Page): Promise<number> =>
  page.locator('[data-testid^="upgrade-"]').count();

/**
 * Открыть прокачку и убедиться, что она открылась. Кнопкой, а не `R`:
 * клавиатуры на телефоне нет, и проверять надо тот путь, который есть.
 */
const openUpgrades = async (page: Page): Promise<void> => {
  await page.getByTestId('stats-toggle').click();
  await expect(page.getByTestId('hud')).toHaveAttribute('data-stats', 'open');
};

const closeUpgrades = async (page: Page): Promise<void> => {
  const hud = page.getByTestId('hud');
  if ((await hud.getAttribute('data-stats')) === 'open') {
    await page.getByTestId('stats-toggle').click();
  }
  await expect(hud).toHaveAttribute('data-stats', 'closed');
};

test.describe('телефон в портрете', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('раскладка портрета', async ({ page }) => {
    await bootGame(page);
    await closeUpgrades(page);

    // Верхняя полоса умещается в ширину и не режет сводки.
    expect(await barOverflow(page)).toBeLessThanOrEqual(0);
    await sidesVisible(page);

    // Нижняя не прокручивается вбок ВООБЩЕ. Прокрутка здесь не спасение,
    // а лишний жест перед каждым заказом — и делается он второй рукой,
    // потому что первая держит телефон.
    expect((await bottomOverflow(page)).x).toBeLessThanOrEqual(0);
    expect(await coveredButtons(page)).toBe(0);

    // Весь заказ на экране столбцом у правого края, под большой палец.
    const order = await orderPlacement(page);
    expect(order.offScreen).toBe(0);
    expect(order.rightGap).toBeLessThanOrEqual(12);
    // Юниты НИЖЕ построек: заказ юнита — одно нажатие, постановка
    // постройки — два, и лучшее место в столбце достаётся частому
    // действию. Раньше это же требование читалось «правее»: заказ был
    // строкой в полосе.
    expect(order.unitsTop).toBeGreaterThanOrEqual(order.buildBottom);

    // Цена видна и без подписи «цена»: число остаётся.
    await expect(page.getByTestId('train-0-cost')).toBeVisible();

    // Плитки базы в полосе нет — к базе переносит прочность сверху.
    // Проверяется именно НАЖИМАЕМОСТЬ: иначе на телефоне к базе
    // не добраться вовсе, а число рядом выглядело бы обычным текстом.
    await expect(page.getByTestId('focus-base')).toBeHidden();

    const ownHealth = page.getByTestId('base-health-own');
    await expect(ownHealth).toBeVisible();
    expect(await ownHealth.evaluate((el) => el.tagName)).toBe('BUTTON');
    await ownHealth.click();
    // Нажатие переносит камеру и ничего не заказывает: прокачка осталась
    // свёрнутой, режимы не включились.
    await expect(page.getByTestId('hud')).toHaveAttribute('data-stats', 'closed');

    // А прочность соперника остаётся текстом: перенос камеры к чужой базе —
    // другое действие, и вешать его на похожее с виду число нельзя.
    expect(await page.getByTestId('base-health-enemy').evaluate((el) => el.tagName)).toBe('DIV');

    // Полосы внизу больше нет вовсе, и полю достаётся почти весь экран:
    // 812 минус 114 верхней сводки — это 86 %. Прежний порог был 70,
    // и держался он на полосе в 84 точки.
    expect(await fieldShare(page)).toBeGreaterThanOrEqual(85);

    // Главное число этого изменения. Портрет и раньше давал одиннадцать
    // клеток, но проверялось это ничем: пропади они — заметил бы игрок,
    // а не проверка.
    expect(await visibleRows(page)).toBeGreaterThanOrEqual(10);
  });

  test('панель прокачки в портрете', async ({ page }) => {
    await bootGame(page);
    await closeUpgrades(page);

    // Сцена не должна пересчитываться от открытия панели: высота полосы
    // входит в отступы её контейнера, и раньше каждое переключение
    // будило наблюдателя за размером — камера пересчитывала границы,
    // миникарта переезжала в угол. Посреди боя, ради таблицы цен.
    const before = await canvasSize(page);
    const share = await fieldShare(page);

    await openUpgrades(page);

    expect(await canvasSize(page)).toEqual(before);
    expect(await fieldShare(page)).toBeCloseTo(share, 1);

    // Панель показывает все восемь целей прокачки со всеми ветками,
    // и ничего не приходится доставать прокруткой.
    //
    // Веток тридцать одна: к прежним двадцати девяти добавились мощность
    // ядерного заряда и радиус поражения, обе у базы. Число здесь стоит
    // числом намеренно — оно ловит ровно то, ради чего проверка и живёт:
    // ветка, не поместившаяся на телефон, пропадает молча.
    await expect(page.getByTestId('focus-base')).toBeVisible();
    expect(await branchCount(page)).toBe(31);
    const overflow = await bottomOverflow(page);
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);
    expect(await coveredButtons(page)).toBe(0);

    // Верхнюю полосу панель не закрывает: игрок торгуется, и энергия —
    // то самое число, ради которого он решает, покупать или копить.
    await expect(page.getByTestId('energy')).toBeInViewport();

    // Нажатие мимо панели закрывает её. Целимся в полоску поля НАД
    // панелью: середина слоя лежит под самой панелью.
    await page.getByTestId('panel-backdrop').click({ position: { x: 100, y: 20 } });
    await expect(page.getByTestId('hud')).toHaveAttribute('data-stats', 'closed');
  });
});

test.describe('телефон в ландшафте', () => {
  test.use({ viewport: { width: 812, height: 375 }, hasTouch: true, isMobile: true });

  test('раскладка ландшафта', async ({ page }) => {
    await bootGame(page);
    await closeUpgrades(page);

    expect(await barOverflow(page)).toBeLessThanOrEqual(0);
    await sidesVisible(page);
    expect((await bottomOverflow(page)).x).toBeLessThanOrEqual(0);
    expect(await coveredButtons(page)).toBe(0);

    const order = await orderPlacement(page);
    expect(order.offScreen).toBe(0);
    expect(order.rightGap).toBeLessThanOrEqual(12);
    expect(order.unitsTop).toBeGreaterThanOrEqual(order.buildBottom);

    // 375 минус 64 верхней сводки — это 83 %. Прежний порог был 54,
    // и держался он на полосе в 64 точки, то есть на пятой части
    // всего экрана.
    expect(await fieldShare(page)).toBeGreaterThanOrEqual(82);

    // Ради этой строки всё и затевалось: было 4,3 клетки — меньше
    // дальности выстрела, — и игрок физически не мог увидеть стрелка
    // и его мишень одновременно.
    expect(await visibleRows(page)).toBeGreaterThanOrEqual(10);

    // Из матча надо уметь выйти. На телефоне Esc нажать нечем, и до этой
    // кнопки выйти было нельзя ВООБЩЕ: ни выйти, ни сдаться, ни начать
    // заново — зависший матч оставалось закрыть вкладкой.
    const menu = page.getByTestId('menu-open');
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.getByTestId('match-menu')).toBeVisible();
    await menu.click();
    await expect(page.getByTestId('match-menu')).toBeHidden();
  });

  test('панель прокачки в ландшафте', async ({ page }) => {
    await bootGame(page);
    await closeUpgrades(page);

    const before = await canvasSize(page);
    await openUpgrades(page);

    expect(await canvasSize(page)).toEqual(before);

    // Все двадцать девять веток видны и здесь: три ряда в 375 точек
    // высоты не помещаются, поэтому группы встают рядом. Прокрутка
    // не годится по той же причине, по какой не годилась в полосе —
    // она не сообщает о себе, и пятая ветка для игрока исчезает.
    expect(await branchCount(page)).toBe(31);
    const overflow = await bottomOverflow(page);
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);
    expect(await coveredButtons(page)).toBe(0);

    await expect(page.getByTestId('energy')).toBeInViewport();

    // Заказ панель не закрывает: заказывают пачками.
    await page.getByTestId('train-0-select').click();
    await expect(page.getByTestId('hud')).toHaveAttribute('data-stats', 'open');

    // А наведение — закрывает: целиться в поле, которого не видно, нельзя.
    await page.getByTestId('aim-nuke-select').click();
    await expect(page.getByTestId('hud')).toHaveAttribute('data-stats', 'closed');
  });
});
