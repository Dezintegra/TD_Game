import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { diagnostic, identify, openMatchMenu, uniqueTitle } from './helpers.js';

/**
 * Мета-слой: представление, комнаты, обоюдная готовность.
 *
 * Ключевые проверки здесь идут на двух контекстах браузера — двух
 * независимых наборах кук и вкладок. Иначе главное свойство комнаты
 * не проверить вовсе: она существует ради того, чтобы двое увидели
 * друг друга, и одним браузером этого не изобразить.
 */

/** Создать комнату и дождаться, пока она откроется у создателя. */
const createRoom = async (page: Page, title: string): Promise<void> => {
  await page.getByTestId('lobby-title').fill(title);
  await page.getByTestId('lobby-create').click();
  await expect(page.getByTestId('room')).toBeVisible();
};

/** Строка списка с нужным названием — своя, а не соседнего теста. */
const rowOf = (page: Page, title: string) =>
  page.getByTestId('lobby-row').filter({ hasText: title });

/**
 * Рамки того, что от списка комнат зависеть не должно.
 *
 * Строкой, а не числами: несовпадение сразу читается в отчёте, и видно,
 * уехало ли оно вбок, вниз или изменилось в размере.
 *
 * Панель списка здесь же и по той же причине: постоянная высота панели
 * и есть способ не двигать меню, поэтому её рамка проверяется наравне
 * с кнопками.
 */
const frames = async (page: Page): Promise<Record<string, string>> => {
  const measured: Record<string, string> = {};

  for (const id of [
    'profile-bar',
    'lobby-title',
    'lobby-create',
    'practice-start',
    'lobby-panel',
  ]) {
    const box = await page.getByTestId(id).boundingBox();

    measured[id] =
      box === null
        ? 'элемента нет'
        : [box.x, box.y, box.width, box.height].map(Math.round).join(', ');
  }

  return measured;
};

test('профиль переживает перезагрузку и удаляется по требованию', async ({ page }) => {
  await identify(page, 'Аня');

  await page.reload();
  // Повторно представляться не требуется: профиль лежит в куке.
  await expect(page.getByTestId('profile-name-shown')).toHaveText('Аня');
  await expect(page.getByTestId('profile-form')).toBeHidden();

  await page.getByTestId('profile-forget').click();
  await page.getByTestId('profile-forget-confirm').click();

  // Возврат к представлению, причём поле пустое: прежнее имя
  // не подставляется, иначе «удалить» выглядело бы как «переименовать».
  await expect(page.getByTestId('profile-form')).toBeVisible();
  await expect(page.getByTestId('profile-name')).toHaveValue('');

  await page.getByTestId('profile-name').fill('Боря');
  await page.getByTestId('profile-submit').click();
  await expect(page.getByTestId('profile-name-shown')).toHaveText('Боря');
});

test('имя проверяется до создания профиля', async ({ page }) => {
  await page.goto('/');

  // Пустое поле: отклик обязан прийти в том же кадре, без обращения
  // к серверу, потому что исход зависит только от введённой строки.
  await page.getByTestId('profile-submit').click();
  await expect(page.getByText('Введите имя')).toBeVisible();
  await expect(page.getByTestId('profile-form')).toBeVisible();

  // Одна буква — уже другая причина, а не та же самая.
  await page.getByTestId('profile-name').fill('я');
  await page.getByTestId('profile-submit').click();
  await expect(page.getByText('Не короче 2 символов')).toBeVisible();

  await page.getByTestId('profile-name').fill('Аня');
  await page.getByTestId('profile-submit').click();
  await expect(page.getByTestId('profile-name-shown')).toHaveText('Аня');
});

test('созданная комната появляется у соседа без обновления страницы', async ({ browser }) => {
  const watching = await browser.newContext();
  const creating = await browser.newContext();

  try {
    const watcher = await watching.newPage();
    const creator = await creating.newPage();
    const title = uniqueTitle();

    await identify(watcher, 'Аня');
    await identify(creator, 'Боря');

    await createRoom(creator, title);

    // Ни перезагрузки, ни кнопки «обновить»: строка обязана приехать
    // сама. Список без этого — снимок, по которому игрок ломился бы
    // в занятую комнату.
    await expect(rowOf(watcher, title)).toBeVisible();
    await expect(rowOf(watcher, title).getByTestId('lobby-row-players')).toHaveText('1 / 2');
  } finally {
    await watching.close();
    await creating.close();
  }
});

test('комната появляется и закрывается, не сдвинув меню', async ({ browser }) => {
  const watching = await browser.newContext();
  const creating = await browser.newContext();

  try {
    const watcher = await watching.newPage();
    const creator = await creating.newPage();
    const title = uniqueTitle();

    await identify(watcher, 'Аня');
    await identify(creator, 'Боря');

    // Список стоит справа от меню, а не под ним: видны разом оба.
    const create = await watcher.getByTestId('lobby-create').boundingBox();
    const rooms = await watcher.getByTestId('lobby-panel').boundingBox();
    expect(rooms).not.toBeNull();
    expect(rooms?.x ?? 0).toBeGreaterThanOrEqual((create?.x ?? 0) + (create?.width ?? 0));

    const before = await frames(watcher);

    await createRoom(creator, title);
    await expect(rowOf(watcher, title)).toBeVisible();

    // Комнаты появляются без участия наблюдателя — дежурные комнаты
    // компьютера сменяются сами, соседи создают свои. Ни одно такое
    // событие не вправе увести кнопку из-под курсора.
    expect(await frames(watcher)).toEqual(before);

    await creator.getByTestId('room-leave').click();
    await expect(rowOf(watcher, title)).toHaveCount(0);

    expect(await frames(watcher)).toEqual(before);
  } finally {
    await watching.close();
    await creating.close();
  }
});

test('двое сходятся в комнате, и обоюдная готовность начинает матч', async ({ browser }) => {
  /**
   * Своё время, и вот почему тридцати секунд по умолчанию не хватало.
   *
   * Проверка ведёт ДВА браузера через всю дорогу: представление, комната,
   * вход соседа, обоюдная готовность, начало матча, общая карта, стороны,
   * два согласия на общем тике и выход из матча с подтверждением. Замер
   * 24.08.2026 на рабочей машине: 20,1 с с видеокартой и 33,8 с
   * с программной отрисовкой — то есть в режиме runner'а проверка
   * не укладывалась в срок вовсе, а на быстрой машине жила с запасом
   * в секунду.
   *
   * Арифметика при этом была невозможной: у `agreeOnCommonTick` внутри
   * стоит терпение в 45 с, а всему тесту отпускалось 30. До своего срока
   * внутреннее ожидание не доживало никогда — тест умирал раньше.
   * Соседний комментарий это и признаёт: «прошёл за 28,9 с при пороге
   * в 30 с, то есть впритык». Опрос тогда починили, бюджет поднять
   * забыли.
   *
   * Сто двадцать секунд сходятся с внутренними сроками: два согласия
   * по 45 с в худшем случае плюс два десятка секунд на остальную дорогу.
   * Это потолок, а не стоимость: здоровый прогон занимает 20–34 с.
   */
  test.setTimeout(120_000);

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();

  try {
    const anya = await firstContext.newPage();
    const borya = await secondContext.newPage();
    const title = uniqueTitle();

    await identify(anya, 'Аня');
    await identify(borya, 'Боря');

    await createRoom(anya, title);
    await rowOf(borya, title).getByTestId('lobby-join').click();

    // Оба видят полный состав.
    await expect(borya.getByTestId('room')).toBeVisible();
    await expect(anya.getByTestId('room-slot')).toHaveCount(2);
    await expect(borya.getByTestId('room-slot')).toHaveCount(2);

    // Готовность одного видна другому.
    await anya.getByTestId('room-ready').click();
    await expect(borya.getByTestId('room-slot').filter({ hasText: 'Аня' })).toHaveAttribute(
      'data-ready',
      'yes',
    );

    // Пока готов один — матч не начинается.
    await expect(anya.locator('#scene canvas')).toBeHidden();

    await borya.getByTestId('room-ready').click();

    // Матч начался у обоих.
    //
    // Сроки здесь проставлены явно, теми же числами, что в `bootGame`:
    // пять секунд по умолчанию рассчитаны на щелчок по кнопке, а не
    // на поднятие сцены и сетевой обмен. На runner'е, где два браузера
    // и сервер делят два ядра, пяти секунд не хватало — и проверка
    // падала на первом же ожидании после начала матча.
    await expect(anya.locator('#scene canvas')).toBeVisible({ timeout: 15_000 });
    await expect(borya.locator('#scene canvas')).toBeVisible({ timeout: 15_000 });

    // Карта общая: seed совпадает.
    //
    // Seed игроку не показывается — ему он ни о чём не говорит, — но живёт
    // атрибутом в разметке: это единственное, чем ОТСЮДА можно убедиться,
    // что двоим досталась одна и та же карта, а не две похожие.
    // Ждём, а не читаем разом: seed попадает в разметку с первым снимком
    // карты, а тот приходит на кадр-другой позже, чем появляется холст.
    await expect(anya.getByTestId('diagnostics')).not.toHaveAttribute('data-seed', '0', {
      timeout: 20_000,
    });

    const seedOfAnya = await diagnostic(anya, 'seed');
    expect(Number(seedOfAnya)).toBeGreaterThan(0);
    await expect(borya.getByTestId('diagnostics')).toHaveAttribute('data-seed', seedOfAnya, {
      timeout: 20_000,
    });

    // Стороны разные, и каждый видит имя соперника, а не своё.
    await expect(anya.getByTestId('match-opponent')).toHaveAttribute('data-side', '0');
    await expect(borya.getByTestId('match-opponent')).toHaveAttribute('data-side', '1');
    await expect(anya.getByTestId('match-opponent')).toContainText('Боря');
    await expect(borya.getByTestId('match-opponent')).toContainText('Аня');

    // Сторона доехала до самой симуляции, а не осталась в меню.
    // Атрибут берётся из снимка матча, который заполняет игровой цикл,
    // поэтому проверка отличает «сервер назначил сторону 1»
    // от «игрок действительно играет стороной 1».
    await expect(anya.getByTestId('hud')).toHaveAttribute('data-local-player', '0', {
      timeout: 20_000,
    });
    await expect(borya.getByTestId('hud')).toHaveAttribute('data-local-player', '1', {
      timeout: 20_000,
    });

    // Матч общий: миры сходятся тик в тик.
    //
    // Проверяется контрольной суммой подтверждённого мира, а не картинкой.
    // Картинка сказала бы лишь «оба что-то рисуют»; сумма говорит, что
    // это один и тот же мир, посчитанный независимо с двух сторон
    // из одного потока команд. Ради этого всё и затевалось.
    // Двадцать секунд, как в `bootGame`, и это не запас на всякий случай:
    // замер показал, что от начала матча до первого подтверждённого тика
    // проходит около шести секунд, и цифра одинакова с видеокартой
    // и без неё — она сетевая, а не отрисовочная.
    await expect(anya.getByTestId('diagnostics')).toHaveAttribute('data-sync-tick', /[1-9]/, {
      timeout: 20_000,
    });

    /** Снимок подтверждённого мира: тик и сумма читаются ОДНИМ обращением. */
    const syncSnapshot = (page: Page) =>
      page.getByTestId('diagnostics').evaluate((el) => ({
        tick: el.getAttribute('data-sync-tick') ?? '',
        checksum: el.getAttribute('data-sync-checksum') ?? '',
      }));

    /**
     * Дождаться тика, который видели ОБЕ стороны, и сравнить суммы на нём.
     *
     * Читать тик и сумму порознь нельзя, и это не педантизм: мир не стоит.
     * Между чтением тика у Ани и чтением её суммы проходит несколько тиков,
     * и сумма оказывается уже от другого мгновения; а Боря может нужный тик
     * проскочить между опросами — тогда совпадения не случится никогда.
     *
     * На runner'е GitHub так и вышло: клиент рисует там четыре кадра
     * в секунду, тик уезжал 600 → 630 → 660 → 690 → 720, сумма менялась
     * вместе с ним, и проверка ждала снимок, которого уже нет. На быстрой
     * машине то же самое проскакивало по случайности.
     *
     * Возвращает тик, на котором стороны сошлись, — чтобы следующая проверка
     * могла потребовать совпадения ПОЗЖЕ этого места, а не зачесть прежнее.
     */
    const agreeOnCommonTick = async (after: number): Promise<number> => {
      const seen = new Map<string, { who: string; checksum: string }>();
      let agreedAt = 0;

      await expect
        .poll(
          async () => {
            // Обе стороны читаются ОДНОВРЕМЕННО, а не по очереди.
            //
            // По очереди не годится: опрос идёт раз в секунду, подтверждённый
            // тик тоже меняется примерно раз в секунду, и каждая сторона
            // даёт свою разрежённую выборку тиков. Две такие выборки могут
            // не пересечься вовсе — что и вышло на runner'е, где клиент
            // рисует четыре кадра в секунду: проверка честно ждала общий
            // тик все тридцать секунд и не дождалась.
            const [ofAnya, ofBorya] = await Promise.all([syncSnapshot(anya), syncSnapshot(borya)]);

            const usable = (it: { tick: string; checksum: string }) =>
              it.checksum !== '' && Number(it.tick) > after;

            // Быстрый путь: обе стороны показывают один тик прямо сейчас.
            if (usable(ofAnya) && usable(ofBorya) && ofAnya.tick === ofBorya.tick) {
              agreedAt = Number(ofAnya.tick);
              return ofAnya.checksum === ofBorya.checksum
                ? 'совпало'
                : `расхождение на тике ${ofAnya.tick}`;
            }

            const sampled = [
              { who: 'Аня', ...ofAnya },
              { who: 'Боря', ...ofBorya },
            ].filter(usable);

            // Медленный путь: одна сторона могла показать тик, который другая
            // проходила в промежутке между опросами. Память о виденном это
            // ловит — записи не стираются, и совпадение засчитывается позже.
            for (const { who, tick, checksum } of sampled) {
              const known = seen.get(tick);
              if (known === undefined) {
                seen.set(tick, { who, checksum });
                continue;
              }

              // Своя же запись свидетельством не является: сравниваем стороны.
              if (known.who === who) continue;
              if (known.checksum !== checksum) return `расхождение на тике ${tick}`;

              agreedAt = Number(tick);
              return 'совпало';
            }

            // В сообщении стоят оба тика: если проверка всё же не дождётся,
            // из отчёта будет видно, стороны разъехались или одна отстала, —
            // а не только то, что «не совпало».
            return `ждём общий тик (Аня ${ofAnya.tick}, Боря ${ofBorya.tick})`;
          },
          {
            timeout: 45_000,
            // Ровный частый опрос вместо растущих пауз по умолчанию.
            //
            // Подтверждённый тик держится около секунды, и при опросе раз
            // в секунду каждая сторона даёт свою разрежённую выборку —
            // выборки могут не пересечься подолгу. Проверено 24.08.2026:
            // при опросе раз в 250 мс тест прошёл за 28.9 с при пороге
            // в 30 с, то есть впритык. Десять выборок на тик оставляют запас.
            intervals: [100],
            message: 'подтверждённые миры Ани и Бори должны совпасть на общем тике',
          },
        )
        .toBe('совпало');

      return agreedAt;
    };

    const agreedAt = await agreeOnCommonTick(0);

    // Действия одного доходят до мира другого. Аня двигает генерала —
    // и оба мира остаются одинаковыми, хотя команду отдавала только она.
    await anya.locator('#scene canvas').click({ position: { x: 10, y: 10 } });
    await anya.keyboard.down('w');
    await anya.waitForTimeout(600);
    await anya.keyboard.up('w');

    // Совпасть должны на тике ПОЗЖЕ прежнего: иначе проверку зачло бы
    // прошлое согласие, снятое ещё до того, как Аня тронула генерала,
    // и команда могла бы не доехать вовсе.
    await agreeOnCommonTick(agreedAt);

    // С живым соперником перезапуск на новой карте недоступен.
    //
    // Меню открывается явно: без этого проверка прошла бы и в том случае,
    // если бы перезапуск просто лежал в закрытом меню, — то есть перестала
    // бы что-либо доказывать.
    await openMatchMenu(anya);
    await expect(anya.getByTestId('restart')).toHaveCount(0);
    await expect(anya.getByTestId('match-leave')).toBeVisible();

    // Комната ушла из списка открытых: войти в неё уже нельзя.
    const onlooker = await firstContext.newPage();
    await onlooker.goto('/');
    await expect(rowOf(onlooker, title)).toHaveCount(0);

    // Выход из идущего матча спрашивает подтверждение: он засчитывается
    // поражением, и уйти по ошибке нельзя.
    await anya.getByTestId('match-leave').click();
    await expect(anya.getByTestId('leave-warning')).toBeVisible();
    await anya.getByTestId('leave-confirm').click();

    await expect(anya.getByTestId('menu')).toBeVisible();
    await expect(anya.locator('#scene canvas')).toHaveCount(0);

    // Соперник узнаёт, что матч кончился, а не ждёт вечно.
    await expect(borya.getByTestId('result-overlay')).toBeVisible({ timeout: 15_000 });
    await expect(borya.getByTestId('result-reason')).toContainText('вышел из матча');
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test('готовность недоступна в одиночестве и сбрасывается уходом соперника', async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();

  try {
    const anya = await firstContext.newPage();
    const borya = await secondContext.newPage();
    const title = uniqueTitle();

    await identify(anya, 'Аня');
    await identify(borya, 'Боря');

    await createRoom(anya, title);
    // Согласие дают на конкретного соперника, а его ещё нет.
    await expect(anya.getByTestId('room-ready')).toBeDisabled();
    await expect(anya.getByTestId('room-hint')).toContainText('Ждём соперника');

    await rowOf(borya, title).getByTestId('lobby-join').click();
    await expect(anya.getByTestId('room-ready')).toBeEnabled();

    await anya.getByTestId('room-ready').click();
    await expect(anya.getByTestId('room-ready')).toHaveAttribute('data-ready', 'yes');

    // Уход соперника снимает готовность оставшегося: иначе следующий
    // вошедший запустил бы матч первым нажатием.
    await borya.getByTestId('room-leave').click();
    await expect(anya.getByTestId('room-slot')).toHaveCount(1);
    await expect(anya.getByTestId('room-ready')).toHaveAttribute('data-ready', 'no');
    await expect(anya.locator('#scene canvas')).toHaveCount(0);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test('компьютер держит комнату и играет как обычный участник', async ({ page }) => {
  await identify(page, 'Аня');

  // Комната компьютера — в общем списке, наравне с человеческими,
  // и помечена как компьютерная: имени мало, «Компьютер» вполне может
  // оказаться прозвищем человека.
  const computerRow = page.getByTestId('lobby-row').filter({ hasText: 'Компьютер' });
  await expect(computerRow.first()).toBeVisible({ timeout: 15_000 });
  await expect(computerRow.first()).toHaveAttribute('data-computer', 'true');

  // Одно нажатие: войти в дежурную комнату и подтвердить готовность.
  await page.getByTestId('practice-start').click();

  await expect(page.locator('#scene canvas')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('match-opponent')).toHaveAttribute('data-computer', 'true');

  // Мир идёт: сервер считает тики и рассылает кадры.
  await expect(page.getByTestId('diagnostics')).toHaveAttribute('data-sync-tick', /[1-9]/, {
    timeout: 15_000,
  });

  // Компьютер действительно играет: его команды доходят до общего мира,
  // а значит контрольная сумма меняется от тика к тику.
  const first = await diagnostic(page, 'sync-checksum');
  await expect
    .poll(async () => diagnostic(page, 'sync-checksum'), { timeout: 15_000 })
    .not.toBe(first);

  // Против компьютера перезапуск на новой карте осмыслен и доступен —
  // но живёт он в меню матча, а не постоянной кнопкой на экране.
  await openMatchMenu(page);
  await expect(page.getByTestId('restart')).toBeVisible();
});

test('заполненная комната показана занятой, а не исчезает', async ({ browser }) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);

  try {
    const [anya, borya, vova] = await Promise.all(contexts.map((context) => context.newPage()));
    if (anya === undefined || borya === undefined || vova === undefined) {
      throw new Error('Не открылись три вкладки');
    }

    const title = uniqueTitle();

    await identify(anya, 'Аня');
    await identify(borya, 'Боря');
    await identify(vova, 'Вова');

    await createRoom(anya, title);
    await rowOf(borya, title).getByTestId('lobby-join').click();
    await expect(borya.getByTestId('room')).toBeVisible();

    // Третий видит комнату и видит, что мест нет. Скрывать её было бы
    // хуже: игрок гадал бы, куда она делась.
    const row = rowOf(vova, title);
    await expect(row.getByTestId('lobby-row-players')).toHaveText('2 / 2');
    await expect(row.getByTestId('lobby-join')).toBeDisabled();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
