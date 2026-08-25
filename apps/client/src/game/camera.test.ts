import { describe, expect, it } from 'vitest';
import { CELL_SCREEN_HEIGHT_PX, MAP_BOUNDS } from './iso.js';
import {
  clampCamera,
  clampZoom,
  createCamera,
  defaultScale,
  MAX_ZOOM,
  MIN_SCALE,
  MIN_VISIBLE_ROWS,
  scaleOf,
  visibleRows,
  zoomAt,
} from './camera.js';

/**
 * Высоты, которые остаются полю на настоящих экранах. Числа не выдуманы:
 * это высота окна минус верхняя полоса, посчитанная по токенам.
 */
const FIELD_HEIGHT = {
  /** Монитор 1920 × 1080: 1080 − 108 верхней − 178 нижней. */
  monitor: 794,
  /** Телефон в портрете 375 × 812: 812 − 114 верхней. */
  portrait: 698,
  /** Телефон в ландшафте 812 × 375: 375 − 64 верхней. Худший случай. */
  landscape: 311,
} as const;

describe('дефолтный масштаб', () => {
  it('на мониторе равен единице: там уменьшать нечего', () => {
    // Обещание широкому экрану: не меняется ни одна точка. Полю и так
    // достаётся пятнадцать клеток, и увеличивать картинку до десяти
    // значило бы испортить то, что не сломано.
    expect(defaultScale(FIELD_HEIGHT.monitor)).toBe(1);
    expect(visibleRows(FIELD_HEIGHT.monitor, 1)).toBeGreaterThan(MIN_VISIBLE_ROWS);
  });

  it('в портрете равен единице: десять клеток есть и без уменьшения', () => {
    expect(defaultScale(FIELD_HEIGHT.portrait)).toBe(1);
    expect(visibleRows(FIELD_HEIGHT.portrait, 1)).toBeGreaterThanOrEqual(MIN_VISIBLE_ROWS);
  });

  it('в ландшафте уменьшает картинку ровно до десяти клеток', () => {
    // Тот самый случай, ради которого всё затевалось: было 4,3 клетки.
    const scale = defaultScale(FIELD_HEIGHT.landscape);

    expect(scale).toBeCloseTo(0.611, 3);
    expect(visibleRows(FIELD_HEIGHT.landscape, scale)).toBeCloseTo(MIN_VISIBLE_ROWS, 6);
  });

  it('упирается в предел, когда десять клеток потребовали бы мельче', () => {
    // Двести точек высоты потребовали бы 0,39. Десять нечитаемых клеток
    // хуже девяти читаемых, поэтому уменьшение останавливается — и число
    // видимых клеток честно оказывается меньше десяти.
    const scale = defaultScale(200);

    expect(scale).toBe(MIN_SCALE);
    expect(visibleRows(200, scale)).toBeLessThan(MIN_VISIBLE_ROWS);
  });

  it('растёт вместе с высотой поля, пока не упрётся в единицу', () => {
    // Выводится из высоты, а не задаётся числом на каждый размер экрана:
    // отдельное число разошлось бы с высотами полос при первой правке
    // раскладки, и разошлось бы молча.
    expect(defaultScale(400)).toBeGreaterThan(defaultScale(300));
    expect(defaultScale(2000)).toBe(1);
  });

  it('десять клеток считаются от той же высоты клетки, что видит игрок', () => {
    expect(defaultScale(MIN_VISIBLE_ROWS * CELL_SCREEN_HEIGHT_PX)).toBe(1);
  });
});

describe('приближение', () => {
  it('не даёт отдалиться дальше дефолта', () => {
    // Дефолт и есть самый широкий обзор, какой этому экрану положен.
    // За ним начинается либо пустота за краем карты, либо нечитаемая
    // мелочь.
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(-3)).toBe(1);
  });

  it('не даёт приблизиться ближе четырёхкратного', () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
  });

  it('пропускает кратность внутри диапазона как есть', () => {
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it('кратность переживает смену размера экрана', () => {
    // Главное свойство хранения приближения кратностью, а не абсолютным
    // масштабом: поворот телефона пересчитывает дефолт и оставляет игрока
    // там же, где он был, — в бою, а не на общем плане.
    const zoom = 2;

    expect(scaleOf(FIELD_HEIGHT.portrait, zoom)).toBe(defaultScale(FIELD_HEIGHT.portrait) * zoom);
    expect(scaleOf(FIELD_HEIGHT.landscape, zoom)).toBe(defaultScale(FIELD_HEIGHT.landscape) * zoom);

    // Абсолютное значение при этом разное — и в этом всё дело: сохрани
    // мы его, после поворота оно оказалось бы за границей диапазона.
    expect(scaleOf(FIELD_HEIGHT.portrait, zoom)).not.toBeCloseTo(
      scaleOf(FIELD_HEIGHT.landscape, zoom),
      3,
    );
  });

  it('подрезает кратность за границами прямо в расчёте масштаба', () => {
    expect(scaleOf(FIELD_HEIGHT.landscape, 0.1)).toBe(defaultScale(FIELD_HEIGHT.landscape));
    expect(scaleOf(FIELD_HEIGHT.landscape, 99)).toBe(
      defaultScale(FIELD_HEIGHT.landscape) * MAX_ZOOM,
    );
  });
});

describe('точка под пальцем', () => {
  /**
   * Мировая точка под экранной — та же формула, по которой сцена
   * переводит нажатие в клетку. Записана здесь отдельно намеренно:
   * проверка обязана считать своим способом, а не звать проверяемый код.
   */
  const worldUnder = (
    camera: { readonly x: number; readonly y: number },
    scale: number,
    anchor: { readonly x: number; readonly y: number },
    viewport: { readonly width: number; readonly height: number },
  ) => ({
    x: camera.x + (anchor.x - viewport.width / 2) / scale,
    y: camera.y + (anchor.y - viewport.height / 2) / scale,
  });

  const viewport = { width: 812, height: 311 } as const;

  it('не уезжает при приближении', () => {
    const camera = createCamera();
    const anchor = { x: 640, y: 90, ...viewport };
    const before = worldUnder(camera, 0.611, anchor, viewport);

    const moved = zoomAt(camera, 0.611, 1.222, anchor);
    const after = worldUnder(moved, 1.222, anchor, viewport);

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('не уезжает при отдалении', () => {
    const camera = createCamera();
    const anchor = { x: 100, y: 260, ...viewport };
    const before = worldUnder(camera, 2, anchor, viewport);

    const moved = zoomAt(camera, 2, 1, anchor);
    const after = worldUnder(moved, 1, anchor, viewport);

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('середина экрана камеру не двигает', () => {
    // Вырожденный случай, и он же объясняет, чем приближение к пальцу
    // отличается от приближения к центру: во втором случае камера
    // не двигается никогда.
    const camera = createCamera();
    const anchor = { x: viewport.width / 2, y: viewport.height / 2, ...viewport };

    expect(zoomAt(camera, 1, 3, anchor)).toEqual(camera);
  });

  it('одинаковый масштаб до и после камеру не двигает', () => {
    const camera = createCamera();
    const anchor = { x: 10, y: 20, ...viewport };

    expect(zoomAt(camera, 1.5, 1.5, anchor)).toEqual(camera);
  });
});

describe('ограничение камеры границами карты', () => {
  const far = { x: MAP_BOUNDS.maxX * 2, y: MAP_BOUNDS.maxY * 2 };

  it('при уменьшенной картинке карта доходит до края экрана', () => {
    // Окно приходит в точках экрана, а камера живёт в координатах мира.
    // Забудь деление на масштаб — камера упрётся в границу раньше, чем
    // карта дойдёт до края, и по краям останется полоса пустоты.
    const atFull = clampCamera(far, 812, 311, 1);
    const atHalf = clampCamera(far, 812, 311, 0.5);

    // При вдвое уменьшенной картинке окно охватывает вдвое больше мира,
    // значит камера обязана остановиться ДАЛЬШЕ от края карты.
    expect(atHalf.x).toBeLessThan(atFull.x);
    expect(atHalf.y).toBeLessThan(atFull.y);

    // И ровно на половину окна от края — то есть край карты совпал
    // с краем экрана, а не остановился перед ним.
    expect(atHalf.y).toBeCloseTo(MAP_BOUNDS.maxY - 311 / 0.5 / 2, 9);
  });

  it('умолчание масштаба ничего не меняет для прежних вызовов', () => {
    expect(clampCamera(far, 1920, 794)).toEqual(clampCamera(far, 1920, 794, 1));
  });

  it('карту мельче окна центрирует, а не прижимает к краю', () => {
    // Уменьшив картинку достаточно сильно, окно охватит карту целиком.
    // Тогда камере болтаться нельзя: она показывала бы пустоту то с одной
    // стороны, то с другой.
    const centred = clampCamera({ x: 0, y: 0 }, 812, 311, 0.05);

    expect(centred.x).toBeCloseTo((MAP_BOUNDS.minX + MAP_BOUNDS.maxX) / 2, 9);
    expect(centred.y).toBeCloseTo((MAP_BOUNDS.minY + MAP_BOUNDS.maxY) / 2, 9);
  });
});
