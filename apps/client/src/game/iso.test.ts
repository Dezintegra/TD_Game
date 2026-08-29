import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAP_CELL_COUNT, PROJECTION_YAW_DEG } from '@td/shared';
import {
  CELL_SCREEN_AREA_PX,
  CELL_SCREEN_HEIGHT_PX,
  MAP_BOUNDS,
  screenToWorld,
  visibleCellCount,
  visibleMapPercent,
  VIEW_DIRECTION,
  VIEW_DIRECTION_3D,
  worldToScreen,
} from './iso.js';

describe('проекция поля', () => {
  it('прямое и обратное преобразование согласованы', () => {
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [17, 42],
      [95, 95],
    ]) {
      const screen = worldToScreen(x ?? 0, y ?? 0);
      const back = screenToWorld(screen.x, screen.y);

      expect(back.x).toBeCloseTo(x ?? 0, 9);
      expect(back.y).toBeCloseTo(y ?? 0, 9);
    }
  });

  it('оси мира расходятся в разные стороны по горизонтали', () => {
    // Ключевое свойство: движение по одной мировой оси уводит вправо,
    // по другой — влево, и обе уводят вниз.
    expect(worldToScreen(1, 0).x).toBeGreaterThan(0);
    expect(worldToScreen(0, 1).x).toBeLessThan(0);
    expect(worldToScreen(1, 0).y).toBeGreaterThan(0);
    expect(worldToScreen(0, 1).y).toBeGreaterThan(0);
  });

  it('поворот не равен 45 градусам, поэтому оси несимметричны', () => {
    // Это и есть причина отказа от честной изометрии. При 45 градусах
    // обе оси ложились бы на экран зеркально, все рёбра выстраивались бы
    // в одни и те же диагонали, и силуэты соседних объектов сливались бы.
    expect(PROJECTION_YAW_DEG).not.toBe(45);

    const alongX = worldToScreen(1, 0);
    const alongY = worldToScreen(0, 1);

    expect(Math.abs(alongX.x)).not.toBeCloseTo(Math.abs(alongY.x), 1);
    expect(alongX.y).not.toBeCloseTo(alongY.y, 1);
  });

  it('высота клетки на экране равна расстоянию между её верхом и низом', () => {
    // Величина считается независимо от самой проекции — прямым замером
    // ромба клетки: верхняя вершина в начале координат, нижняя — в углу,
    // до которого дошли по обеим осям сразу.
    const bottom = worldToScreen(1, 1);

    expect(CELL_SCREEN_HEIGHT_PX).toBeCloseTo(bottom.y - worldToScreen(0, 0).y, 9);

    // И то же число из углов проекции, чтобы правка масштаба или наклона
    // не прошла мимо: 63 × (sin 40° + cos 40°) × sin 35°.
    expect(CELL_SCREEN_HEIGHT_PX).toBeCloseTo(50.91, 2);
  });

  it('начало координат совпадает с северным углом карты', () => {
    expect(worldToScreen(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('проекция линейна: прямая в мире остаётся прямой на экране', () => {
    // На этом свойстве держится отрисовка сетки длинными линиями.
    const a = worldToScreen(0, 5);
    const b = worldToScreen(10, 5);
    const middle = worldToScreen(5, 5);

    expect(middle.x).toBeCloseTo((a.x + b.x) / 2, 9);
    expect(middle.y).toBeCloseTo((a.y + b.y) / 2, 9);
  });
});

describe('видимая доля карты', () => {
  it('при окне 1920 × 1080 видно от 25 до 75 процентов карты', () => {
    // Диапазон растёт с каждым уменьшением карты: масштаб клетки остаётся
    // прежним, а клеток становится меньше. При 96 клетках по стороне было
    // около десяти процентов, при 48 — сорок, при 38 — шестьдесят три.
    //
    // Верхняя граница важна не меньше нижней, но сторожит она не «сколько
    // процентов», а «карта целиком на экран не помещается»: помещайся она
    // вся, перемещение взгляда перестало бы быть частью игры. Семьдесят
    // пять — это ещё заметно меньше ста, то есть требование в силе.
    const percent = visibleMapPercent(1920, 1080);

    expect(percent).toBeGreaterThanOrEqual(25);
    expect(percent).toBeLessThanOrEqual(75);
  });

  it('площадь клетки не зависит от угла поворота, только от наклона', () => {
    // Определитель матрицы проекции равен масштаб² × sin(наклон).
    // Поворот перераспределяет клетку между осями, но не меняет её площадь.
    expect(CELL_SCREEN_AREA_PX).toBeGreaterThan(0);
    expect(visibleCellCount(1920, 1080)).toBeCloseTo((1920 * 1080) / CELL_SCREEN_AREA_PX, 9);
  });

  it('число видимых клеток меньше размера карты', () => {
    expect(visibleCellCount(1920, 1080)).toBeLessThan(MAP_CELL_COUNT);
  });

  it('полосы интерфейса не съедают поле ниже четверти карты', () => {
    // Полос теперь нет: интерфейс разложен по углам поверх поля,
    // и высоты у него нулевые. Проверка от этого не устарела, а стала
    // сторожевой — она упадёт в тот день, когда кто-нибудь вернёт полосе
    // высоту, не заметив, во что это обходится полю.
    //
    // Высоты читаются из самих токенов, а не переписываются сюда числами.
    // Скопированное число разошлось бы с настоящим при первой же правке
    // вёрстки, и проверка продолжила бы показывать зелёный.
    const tokens = readFileSync(
      fileURLToPath(new URL('../../../../packages/ui/src/tokens.css', import.meta.url)),
      'utf8',
    );

    const heightOf = (name: string): number => {
      const found = new RegExp(`${name}:\\s*(\\d+)px`).exec(tokens);
      if (found?.[1] === undefined) throw new Error(`В токенах не найдена высота ${name}`);
      return Number(found[1]);
    };

    // Берётся РАЗВЁРНУТАЯ нижняя полоса — худший случай. Свёрнутая
    // отнимает у поля меньше, и проверять её отдельно незачем: если
    // проходит худший, проходит и он.
    const chrome = heightOf('--td-hud-top') + heightOf('--td-hud-bottom-open');

    // Предел из спецификации isometric-view. Он не выведен из вкуса:
    // при окне 1080 полное поле даёт около 40 процентов карты, и доля
    // падает пропорционально отнятой высоте. 397 точек — та высота,
    // на которой доля садится ровно на нижнюю границу в 25 процентов.
    expect(chrome).toBeLessThanOrEqual(340);
    expect(visibleMapPercent(1920, 1080 - chrome)).toBeGreaterThanOrEqual(25);
  });

  it('вдвое большее окно показывает вдвое больше клеток', () => {
    expect(visibleCellCount(1920, 2160)).toBeCloseTo(visibleCellCount(1920, 1080) * 2, 9);
  });
});

describe('габариты карты', () => {
  it('охватывают все четыре угла карты', () => {
    // При повороте, отличном от 45 градусов, карта проецируется в косой
    // параллелограмм, поэтому границы нельзя вывести из размера клетки.
    expect(MAP_BOUNDS.minX).toBeLessThan(0);
    expect(MAP_BOUNDS.maxX).toBeGreaterThan(0);
    expect(MAP_BOUNDS.minY).toBe(0);
    expect(MAP_BOUNDS.maxY).toBeGreaterThan(0);
  });

  it('несимметричны по горизонтали из-за поворота', () => {
    expect(Math.abs(MAP_BOUNDS.minX)).not.toBeCloseTo(MAP_BOUNDS.maxX, 1);
  });
});

describe('направление взгляда', () => {
  it('объёмный вектор единичный', () => {
    const { x, y, z } = VIEW_DIRECTION_3D;

    expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 12);
  });

  it('горизонтальная часть сонаправлена плоскому взгляду', () => {
    // Отсюда следует, что для отвесных граней новый тест видимости
    // совпадает со старым: векторы отличаются только длиной, а знак
    // скалярного произведения от длины не зависит.
    const cross = VIEW_DIRECTION.x * VIEW_DIRECTION_3D.y - VIEW_DIRECTION.y * VIEW_DIRECTION_3D.x;
    const dot = VIEW_DIRECTION.x * VIEW_DIRECTION_3D.x + VIEW_DIRECTION.y * VIEW_DIRECTION_3D.y;

    expect(cross).toBeCloseTo(0, 12);
    expect(dot).toBeGreaterThan(0);
  });

  it('смотрит сверху вниз, а не снизу вверх', () => {
    // Положительная третья составляющая означает «к зрителю»: камера
    // над полем, и поднятая точка приближается к ней.
    expect(VIEW_DIRECTION_3D.z).toBeGreaterThan(0);
  });
});
