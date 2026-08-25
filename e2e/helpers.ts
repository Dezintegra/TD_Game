import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Общие шаги сквозных проверок.
 *
 * Вынесены в отдельный файл, потому что путь в игру удлинился: матч
 * больше не начинается сам при загрузке страницы, сначала игрок
 * называет себя. Повторять эти три строки в каждом тесте значило бы
 * править их все при следующей правке формы.
 *
 * Playwright берёт в работу только `*.spec.ts`, поэтому этот файл
 * тестом не считается.
 */

/**
 * Представиться и дойти до списка комнат.
 *
 * У каждого теста свой контекст браузера, то есть чистые куки, поэтому
 * форма представления показывается всякий раз.
 */
export const identify = async (page: Page, name: string): Promise<void> => {
  await page.goto('/');
  await page.getByTestId('profile-name').fill(name);
  await page.getByTestId('profile-submit').click();
  await expect(page.getByTestId('profile-name-shown')).toHaveText(name);
};

/**
 * Представиться и начать матч против компьютера.
 *
 * Матч теперь идёт через сервер, как и всякий другой: клиент входит
 * в дежурную комнату компьютера и подтверждает готовность. Отсюда
 * и ожидание подольше — надо дождаться, пока служба компьютера поднимет
 * комнату, а сервер сведёт двоих и дождётся обоих подключений.
 */
export const bootGame = async (page: Page): Promise<void> => {
  await identify(page, 'Тестер');

  const start = page.getByTestId('practice-start');
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();

  await expect(page.locator('#scene canvas')).toBeVisible({ timeout: 15_000 });
  // Дожидаемся первого подтверждённого тика: до него мир стоит на нуле,
  // и проверки вроде «энергия копится» ловили бы не игру, а ожидание.
  await expect(page.getByTestId('diagnostics')).toHaveAttribute('data-sync-tick', /[1-9]/, {
    timeout: 20_000,
  });
  // Клика по полю здесь намеренно нет. Горячие клавиши слушает window,
  // поэтому фокуса на body достаточно, а клик пришлось бы целить мимо
  // панелей HUD — и тест ломался бы от любой правки вёрстки.
};

/**
 * Название комнаты, не совпадающее с чужими.
 *
 * Тесты идут параллельно и видят общий список комнат на одном сервере.
 * Общее название сделало бы проверки взаимозависимыми: тест находил бы
 * комнату соседнего теста и входил в неё.
 *
 * Длина ограничена двадцатью символами — тем же правилом, что и имя
 * игрока, поэтому суффикс короткий.
 */
export const uniqueTitle = (): string => `Комн-${Math.random().toString(36).slice(2, 7)}`;

/** Число из подписи HUD: отбрасывает единицы измерения и проценты. */
export const number = async (page: Page, testId: string): Promise<number> =>
  Number((await page.getByTestId(testId).textContent())?.replace(/[^\d.-]/g, ''));

/**
 * Диагностическая величина из разметки.
 *
 * Seed, номер тика, частота кадров и доля скал игроку не показываются:
 * они ничего ему не говорят и занимают внимание, которого в матче
 * реального времени нет. Но убрать их совсем нельзя — seed единственное,
 * чем ОТСЮДА проверяется, что у обоих участников одна и та же карта.
 * Поэтому они живут атрибутами на отдельном элементе, и читать их надо
 * так, а не по тексту на экране.
 */
export const diagnostic = async (page: Page, name: string): Promise<string> =>
  (await page.getByTestId('diagnostics').getAttribute(`data-${name}`)) ?? '';

export const diagnosticNumber = async (page: Page, name: string): Promise<number> =>
  Number(await diagnostic(page, name));

/**
 * Частота кадров как медиана нескольких секундных окон.
 *
 * Счётчик в `loop.ts` считает кадры за ПОСЛЕДНЮЮ секунду, а не за всё
 * время. Одно такое окно — не замер, а моментальный снимок: любая
 * заминка в ту самую секунду — сборка мусора, чужой процесс, догрузка
 * спрайта — обрушивает его целиком, и отличить это от просевшей
 * отрисовки нечем.
 *
 * Проверено 24.08.2026: одиночное чтение на третьей секунде давало
 * на одной и той же сборке 19 и 60 кадров подряд. Наблюдение за той же
 * сборкой посекундно показало, почему: ровные 60–61 и один провал
 * до 45 в случайном окне.
 *
 * Медиана шести окон переживает один провал и не переживает настоящую
 * просадку — а именно это от замера и требуется. Среднее здесь
 * не годится: оно провал размазывает, вместо того чтобы его отбросить.
 */
export const medianFps = async (page: Page, samples = 6): Promise<number> => {
  const seen: number[] = [];

  for (let index = 0; index < samples; index += 1) {
    // Ровно окно счётчика: читать чаще — значит читать одно и то же
    // число по нескольку раз и выдавать повтор за наблюдение.
    await page.waitForTimeout(1000);
    seen.push(await diagnosticNumber(page, 'fps'));
  }

  const sorted = [...seen].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
};

/**
 * Открыть меню матча.
 *
 * Выход и перезапуск переехали в него с постоянных панелей: они нужны раз
 * за партию, а место занимали весь матч. Esc открывает меню только тогда,
 * когда отменять нечего, поэтому перед вызовом не должно быть ни выбранной
 * постройки, ни наведённого удара, ни выделения.
 */
export const openMatchMenu = async (page: Page): Promise<void> => {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('match-menu')).toBeVisible();
};

/**
 * Состав своего войска и номер подтверждённого тика — ОДНИМ снимком.
 *
 * Читается всё разом, а не по счётчику за вызов, и дело не в скорости.
 * Между двумя чтениями из Playwright проходит настоящее время, а HUD
 * за это время успевает перерисоваться: на экране живёт ПРЕДСКАЗАННЫЙ
 * мир, и он пересобирается на каждом пришедшем кадре. Прочитав сумму
 * до пересборки, а слагаемое после, тест сравнивает два разных мгновения
 * матча — и падает на арифметике, которая на самом деле сходится.
 *
 * Внутри страницы всё чтение — один синхронный проход, и React
 * перерисоваться посреди него не может.
 */
export interface UnitTally {
  /** Суммарный счётчик своей стороны — тот, что показан как «N/200». */
  readonly total: number;
  /** По видам, в порядке значков: штурмовик, снайпер, Тесла. */
  readonly byType: readonly number[];
  /**
   * Последний подтверждённый сервером тик.
   *
   * Берётся из того же снимка намеренно: по нему видно, дошёл ли заказ
   * до сервера или на экране пока только надежда клиента.
   */
  readonly confirmedTick: number;
}

export const unitTally = async (page: Page): Promise<UnitTally> =>
  page.evaluate(() => {
    // То же отбрасывание единиц измерения, что и в `number`: значок
    // юнита рисуется рядом с цифрой, и в текст попадает не только она.
    const digits = (testId: string): number => {
      const node = document.querySelector(`[data-testid="${testId}"]`);
      return Number((node?.textContent ?? '').replace(/[^\d.-]/g, ''));
    };

    const diagnostics = document.querySelector('[data-testid="diagnostics"]');

    return {
      total: digits('unit-count'),
      byType: [digits('own-unit-0'), digits('own-unit-1'), digits('own-unit-2')],
      confirmedTick: Number(diagnostics?.getAttribute('data-tick') ?? '0'),
    };
  });
