import { describe, expect, it } from 'vitest';
import { BASE_SOLIDS } from './base-model.js';
import type { BaseSolid } from './base-model.js';
import { buildFaces, depthOf, orderSolids, standsOn } from './base-render.js';
import type { BaseColors } from './base-render.js';
import { VIEW_DIRECTION_3D } from './iso.js';
import { FACE_LIGHT, faceLight } from './prism.js';

/**
 * Проверяется здесь не картинка, а два её условия.
 *
 * ПЕРВОЕ — порядок. Буфера глубины нет, перекрытие задаёт порядок
 * треугольников, и молча сломать его можно, подвинув одно тело.
 *
 * ВТОРОЕ — единый источник света. Формула освещения переписана
 * в шейдер, и разъедься она с `prism.ts` хоть на процент, база
 * и стоящая рядом башня оказались бы освещены разными источниками.
 */

const COLORS: BaseColors = {
  concrete: 0x6b6f72,
  metal: 0x8b9299,
  accent: 0x00ff29,
  sky: 0x5c7ea8,
};

/** Цвета сторон из `tokens.css`. Здесь нужны числами: CSS в тестах нет. */
const SIDES = [0x00ff29, 0xd264ff] as const;

const labelOf = (solid: BaseSolid): string => solid.label;

describe('порядок тел', () => {
  const ordered = orderSolids(BASE_SOLIDS).map(labelOf);
  const positionOf = (solid: BaseSolid): number => ordered.indexOf(solid.label);

  it('ни одно тело не врезано в другое', () => {
    // Врезанные тела пересекаются и по земле, и по высоте. Порядок
    // между ними ничем не обоснован, а на экране это выйдет стеной,
    // проросшей сквозь соседнюю.
    const between = (from: number, to: number, otherFrom: number, otherTo: number): number =>
      Math.min(to, otherTo) - Math.max(from, otherFrom);

    for (let i = 0; i < BASE_SOLIDS.length; i += 1) {
      for (let j = i + 1; j < BASE_SOLIDS.length; j += 1) {
        const a = BASE_SOLIDS[i] as BaseSolid;
        const b = BASE_SOLIDS[j] as BaseSolid;
        const deep =
          Math.min(
            between(a.x, a.x + a.width, b.x, b.x + b.width),
            between(a.y, a.y + a.depth, b.y, b.y + b.depth),
            between(a.base, a.base + a.height, b.base, b.base + b.height),
          ) > 0.05;

        expect(deep, `${a.label} врезано в ${b.label}`).toBe(false);
      }
    }
  });

  it('стоящее на теле рисуется после него', () => {
    // Главное свойство порядка. Ошибка здесь означает крышу, съехавшую
    // под собственные стены.
    let checked = 0;

    for (const upper of BASE_SOLIDS) {
      for (const lower of BASE_SOLIDS) {
        if (upper === lower || !standsOn(upper, lower)) continue;

        checked += 1;
        expect(positionOf(lower), `${lower.label} раньше ${upper.label}`).toBeLessThan(
          positionOf(upper),
        );
      }
    }

    expect(checked).toBeGreaterThan(10);
  });

  it('на одном уровне дальнее рисуется раньше ближнего', () => {
    for (const a of BASE_SOLIDS) {
      for (const b of BASE_SOLIDS) {
        if (a === b || a.base !== b.base || depthOf(a) >= depthOf(b)) continue;

        expect(positionOf(a), `${a.label} раньше ${b.label}`).toBeLessThan(positionOf(b));
      }
    }
  });

  it('подиум идёт раньше всего, что на нём стоит', () => {
    // Ловушка приёма: подиум охватывает площадку целиком, и по одной
    // лишь удалённости он оказывается ближе стоящего на нём корпуса —
    // то есть закрыл бы его собой.
    expect(ordered[0]).toBe('подиум');
  });

  it('никого не теряет и не задваивает', () => {
    expect(ordered).toHaveLength(BASE_SOLIDS.length);
    expect(new Set(ordered).size).toBe(BASE_SOLIDS.length);
  });
});

describe('грани', () => {
  const faces = buildFaces(COLORS);

  it('обращённых от зрителя среди них нет', () => {
    // Из шести граней куба зритель видит три. Остальные не строятся
    // вовсе — это прямое следствие того, что камера не поворачивается.
    for (const face of faces) {
      const towards =
        face.normal.x * VIEW_DIRECTION_3D.x +
        face.normal.y * VIEW_DIRECTION_3D.y +
        face.normal.z * VIEW_DIRECTION_3D.z;

      expect(towards).toBeGreaterThan(0);
    }
  });

  it('верхняя грань тела идёт после его боковых', () => {
    // У них общее ребро, и при сглаживании вдоль него получаются
    // полупрозрачные пиксели: нарисуй верхнюю раньше, они смешаются
    // с фоном и по ребру пойдёт тёмная нитка.
    let sinceHorizontal = 0;
    let checked = 0;

    for (const face of faces) {
      if (face.style[2] > 0.5) continue;

      if (face.normal.z > 0.999) {
        // Горизонтальная грань закрывает группу: до неё должны были
        // пройти боковые того же тела.
        if (sinceHorizontal > 0) checked += 1;
        sinceHorizontal = 0;
      } else {
        sinceHorizontal += 1;
      }
    }

    expect(checked).toBeGreaterThan(5);
  });

  it('наклейки не освещаются', () => {
    // Окно светится само, и потемнеть вместе со стеной оно не может.
    const decals = faces.filter((face) => face.style[2] > 0.5);

    expect(decals.length).toBeGreaterThan(10);
    for (const decal of decals) {
      expect(decal.style[0]).toBe(0);
      expect(decal.style[1]).toBe(0);
    }
  });

  it('у металла нет швов опалубки', () => {
    // Швы — примета бетона. На стальной ферме или чаше они читались бы
    // ошибкой отрисовки.
    for (const face of faces) {
      if (face.style[2] > 0.5) continue;
      if (face.style[0] >= 1) continue;

      expect(face.style[1]).toBe(0);
    }
  });

  it('чаша антенны обращена в разные стороны в разных точках', () => {
    // Вогнутость читается только этим: ближняя часть чаши обращена
    // к источнику, дальняя от него. У заливки одним цветом такого
    // различия быть не может.
    const dish = faces.filter((face) => face.style[0] > 0 && face.style[0] < 1);
    const lights = dish.map((face) => faceLight(face.normal.x, face.normal.y, face.normal.z));

    expect(dish.length).toBeGreaterThan(50);
    expect(Math.max(...lights) - Math.min(...lights)).toBeGreaterThan(0.2);
  });
});

describe('свет тот же, что у остального поля', () => {
  it('горизонтальная поверхность освещена как верхняя грань призмы', () => {
    expect(faceLight(0, 0, 1)).toBe(FACE_LIGHT.top);
  });

  it('отвесные грани дают прежние значения', () => {
    // Числа те же, которыми освещены башни и техника: нормаль «на восток»
    // даёт 0,72, «на юг» — 0,48. Разъедься они, поле распалось бы
    // на объекты, освещённые разными источниками.
    expect(faceLight(1, 0)).toBeCloseTo(0.72, 10);
    expect(faceLight(0, 1)).toBeCloseTo(0.48, 10);
  });
});

describe('материал остаётся приглушённым', () => {
  const hsv = (color: number): { saturation: number; value: number } => {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);

    return { saturation: high === 0 ? 0 : (high - low) / high, value: high };
  };

  it('ни один освещённый оттенок не спорит с цветом стороны', () => {
    // Берём самый светлый случай: полный свет плюс свет неба сверху.
    // На поверхности так не совпадёт никогда, значит проверка строже
    // действительности.
    const sky = hsv(COLORS.sky);

    for (const face of buildFaces(COLORS)) {
      // Светящиеся детали не в счёт: цвет стороны на них и должен быть
      // полным — принадлежность читается именно по ним.
      if (face.style[2] > 0.5) continue;

      const tint = hsv(face.tint);
      const brightest = Math.min(1, tint.value + sky.value * 0.18);

      for (const side of SIDES) {
        expect(brightest).toBeLessThan(hsv(side).value - 0.2);
      }
    }
  });
});
