import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Токены проверяются чтением самого файла, а не через браузер.
 *
 * Причина простая: величины отсюда читают трое — вёрстка, рендерер
 * игрового поля и раскладка HUD, — и разъехаться им нельзя. Браузерная
 * проверка сказала бы, что в ЭТОЙ машине сейчас всё в порядке; чтение
 * файла говорит, что значения на месте всегда.
 */

/**
 * Путь берётся от рабочего каталога, а не от `import.meta.url`.
 *
 * Причина не в стиле: этот пакет проверяется в окружении jsdom, и там
 * `import.meta.url` не файловый — `fileURLToPath` на нём падает. А запускать
 * прогон можно и из пакета, и из корня монорепозитория, поэтому путей два.
 */
const TOKEN_PATHS = ['src/tokens.css', 'packages/ui/src/tokens.css'];

const tokenFile = TOKEN_PATHS.find((path) => existsSync(path));
if (tokenFile === undefined) throw new Error('Не найден tokens.css');

const tokens = readFileSync(tokenFile, 'utf8');

/** Значение переменной в блоке, начинающемся с заданного селектора. */
const valueIn = (selector: string, name: string): string => {
  const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's').exec(tokens);
  if (block?.[1] === undefined) throw new Error(`Не найден блок ${selector}`);

  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(block[1]);
  if (found?.[1] === undefined) throw new Error(`В ${selector} нет ${name}`);

  return found[1].trim();
};

const pixels = (value: string): number => {
  const found = /^(\d+)px$/.exec(value);
  if (found?.[1] === undefined) throw new Error(`Не размер в точках: ${value}`);
  return Number(found[1]);
};

describe('цель нажатия', () => {
  it('задана и на точном указателе, и на грубом', () => {
    expect(() => valueIn(':root', '--td-hit-target')).not.toThrow();
    expect(() =>
      valueIn('@media \\(pointer: coarse\\)\\s*\\{\\s*:root', '--td-hit-target'),
    ).not.toThrow();
  });

  it('на пальце не меньше сорока четырёх точек', () => {
    // Общепринятая норма. Мельче палец не попадает, а промах по стрелке
    // прокачки не молчалив: соседняя строка — другая ветка, и деньги
    // уходят не туда, куда игрок целился.
    const coarse = pixels(
      valueIn('@media \\(pointer: coarse\\)\\s*\\{\\s*:root', '--td-hit-target'),
    );

    expect(coarse).toBeGreaterThanOrEqual(44);
  });

  it('на мыши меньше, чем на пальце', () => {
    // Единый крупный размер выгнал бы тулбар за край экрана ноутбука —
    // ровно то, против чего раскладка и делалась.
    const fine = pixels(valueIn(':root', '--td-hit-target'));
    const coarse = pixels(
      valueIn('@media \\(pointer: coarse\\)\\s*\\{\\s*:root', '--td-hit-target'),
    );

    expect(fine).toBeLessThan(coarse);
  });
});

describe('поле ввода на пальце', () => {
  it('не мельче шестнадцати точек', () => {
    // Это не про читаемость, а про поведение браузера. Safari на iOS
    // ПРИБЛИЖАЕТ страницу, когда фокус попадает в поле с кеглем меньше
    // шестнадцати, и обратно её не отпускает: игрок вводит имя комнаты,
    // а дальше вся игра идёт увеличенной и сдвинутой.
    //
    // Поймать это иначе нечем: в headless-браузере такого поведения нет,
    // и сквозная проверка промолчит.
    const coarse = pixels(
      valueIn('@media \\(pointer: coarse\\)\\s*\\{\\s*:root', '--td-input-size'),
    );

    expect(coarse).toBeGreaterThanOrEqual(16);
  });
});

describe('высоты полос интерфейса', () => {
  it('полос нет: контейнер сцены получает окно целиком', () => {
    // Ноль здесь — не «пока не заполнено», а само правило раскладки.
    // Интерфейс разложен по углам ПОВЕРХ поля, и отнимать у поля высоту
    // ему нечем. Прежде полосы стояли 340 точек из 1080 на мониторе,
    // то есть треть экрана уходила на рамки.
    //
    // Переменные при этом обязаны остаться: их читает контейнер сцены,
    // живущий вне дерева React, и читает регулярным выражением —
    // а значит числом в точках, не через calc().
    expect(pixels(valueIn(':root', '--td-hud-top'))).toBe(0);
    expect(pixels(valueIn(':root', '--td-hud-bottom-open'))).toBe(0);
    expect(pixels(valueIn(':root', '--td-hud-bottom-closed'))).toBe(0);
  });

  it('открытая прокачка не меняет высоту, отнятую у поля', () => {
    // Прежде открытие прокачки растило нижнюю полосу со 76 до 178,
    // то есть меняло размер контейнера сцены — а значит будило камеру
    // и миникарту посреди боя, ради показа таблицы цен. Теперь прокачка
    // лежит окном поверх поля, и сцена о ней не узнаёт вовсе.
    const open = pixels(valueIn(':root', '--td-hud-bottom-open'));
    const closed = pixels(valueIn(':root', '--td-hud-bottom-closed'));

    expect(open).toBe(closed);
  });
});
