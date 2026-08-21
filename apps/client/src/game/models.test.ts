import { beforeEach, describe, expect, it } from 'vitest';
import { DIRECTION_SOUTH, UNIT_TYPES, UnitType } from '@td/shared';
import {
  GENERAL_ALTITUDE,
  SIDE_ENEMY,
  SIDE_SELF,
  UNIT_ALTITUDE,
  generalReflection,
  generalSilhouette,
  hoverBob,
  resetModelCache,
  unitReflection,
  unitSilhouette,
  weaponTier,
} from './models.js';
import type { Silhouette } from './models.js';

/**
 * Модели проверяются не картинкой, а свойствами геометрии.
 *
 * Снимок экрана сказал бы «похоже на машину», но перестал бы что-либо
 * доказывать при первой же смене палитры. Проверяемые свойства другие:
 * модель состоит из нескольких тел, типы различаются составом, прокачка
 * меняет оружие, а повторный запрос не строит геометрию заново.
 */

const COLORS = {
  self: 0x00ff29,
  enemy: 0xd264ff,
  hullDark: 0x23271f,
  ground: 0x191919,
};

/** Габариты силуэта на экране относительно основания модели. */
const bounds = (silhouette: Silhouette) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const run of silhouette.fills) {
    for (const polygon of run.polygons) {
      for (const point of polygon) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }
  }

  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
};

const polygonCount = (silhouette: Silhouette): number =>
  silhouette.fills.reduce((total, run) => total + run.polygons.length, 0);

/**
 * Румб, на котором ход машины ложится почти вдоль экранной горизонтали.
 *
 * Нужен, чтобы мерить длину машины со стволом. Экранная `x` для этого
 * подходит идеально: она не зависит от высоты вовсе — высота уходит
 * только в `y`, — а при ходе на северо-восток поперечный размер машины
 * даёт в неё вклад примерно вдесятеро меньший, чем продольный. Поэтому
 * правый край силуэта на этом румбе и есть «докуда достаёт ствол».
 *
 * На других румбах мерка врёт: широкий корпус даёт по горизонтали больше,
 * чем длинный ствол, и удлинение ствола в габарит просто не попадает.
 */
const ALONG_SCREEN = 8;

const assault = (attack = 0, fire = 0, facing = DIRECTION_SOUTH): Silhouette =>
  unitSilhouette(COLORS, SIDE_SELF, UnitType.Assault, facing, attack, fire);

const assaultMirror = (attack = 0, fire = 0, facing = DIRECTION_SOUTH): Silhouette =>
  unitReflection(COLORS, SIDE_SELF, UnitType.Assault, facing, attack, fire);

/** Насколько цвет далёк от цвета поверхности. Сумма по трём каналам. */
const awayFromGround = (color: number): number => {
  let distance = 0;

  for (const shift of [16, 8, 0]) {
    distance += Math.abs(((color >> shift) & 0xff) - ((COLORS.ground >> shift) & 0xff));
  }

  return distance;
};

/** Набор цветов, которыми залита модель. */
const palette = (unitType: UnitType, side: number): Set<number> =>
  new Set(
    unitSilhouette(COLORS, side, unitType, DIRECTION_SOUTH, 0, 0).fills.map((run) => run.color),
  );

beforeEach(() => {
  resetModelCache();
});

describe('состав модели', () => {
  it('юнит собран из нескольких тел, а не из одной коробки', () => {
    // Одна призма даёт три грани. Модель обязана давать заметно больше:
    // корпус, колёса, башня, ствол.
    for (const unitType of UNIT_TYPES) {
      const silhouette = unitSilhouette(COLORS, SIDE_SELF, unitType, DIRECTION_SOUTH, 0, 0);

      expect(polygonCount(silhouette)).toBeGreaterThan(12);
    }
  });

  it('типы различаются составом, а не только размером', () => {
    const shapes = UNIT_TYPES.map((unitType) => {
      const silhouette = unitSilhouette(COLORS, SIDE_SELF, unitType, DIRECTION_SOUTH, 0, 0);
      const box = bounds(silhouette);

      // Отношение габаритов не зависит от общего масштаба: если бы типы
      // отличались только размером, оно совпало бы у всех троих.
      return { parts: polygonCount(silhouette), ratio: box.width / box.height };
    });

    expect(new Set(shapes.map((shape) => shape.parts)).size).toBeGreaterThan(1);
    expect(new Set(shapes.map((shape) => shape.ratio.toFixed(3))).size).toBe(shapes.length);
  });

  it('цвет означает сторону, а не тип', () => {
    // Цвет занят принадлежностью стороне, и нагружать его ещё и типом
    // нельзя. Полного совпадения наборов при этом не требуется: скошенная
    // грань освещена иначе, чем прямая, и оттенков у неё свои. Требуется
    // другое — общая основа у типов и полное расхождение у сторон.
    const mine = UNIT_TYPES.map((unitType) => palette(unitType, SIDE_SELF));
    const theirs = UNIT_TYPES.map((unitType) => palette(unitType, SIDE_ENEMY));

    const shared = [...(mine[0] ?? [])].filter(
      (color) => mine[1]?.has(color) === true && mine[2]?.has(color) === true,
    );
    expect(shared.length).toBeGreaterThan(2);

    for (const ours of mine) {
      for (const foreign of theirs) {
        expect([...ours].filter((color) => foreign.has(color))).toHaveLength(0);
      }
    }
  });
});

describe('ступени оружия', () => {
  it('пороги: первая покупка видна, верхняя ступень остаётся событием', () => {
    expect(weaponTier(0)).toBe(0);
    expect(weaponTier(1)).toBe(1);
    expect(weaponTier(4)).toBe(1);
    expect(weaponTier(5)).toBe(2);
    expect(weaponTier(99)).toBe(2);
  });

  it('прокачка атаки удлиняет ствол', () => {
    const plain = bounds(assault(0, 0, ALONG_SCREEN)).maxX;
    const upgraded = bounds(assault(1, 0, ALONG_SCREEN)).maxX;
    const top = bounds(assault(2, 0, ALONG_SCREEN)).maxX;

    expect(upgraded).toBeGreaterThan(plain);
    expect(top).toBeGreaterThan(upgraded);
    // Не на волосок: разницу должно быть видно на объекте в сорок пикселей.
    expect(top).toBeGreaterThan(plain * 1.05);
  });

  it('ствол задаёт передний край машины', () => {
    // Если бы срез ствола не выходил за корпус, длина оружия в габарит
    // не попадала бы вовсе — и предыдущий тест проходил бы впустую.
    // Проверяем это отдельно: у всех трёх типов ствол виден спереди.
    for (const unitType of UNIT_TYPES) {
      const plain = bounds(unitSilhouette(COLORS, SIDE_SELF, unitType, ALONG_SCREEN, 0, 0)).maxX;
      const long = bounds(unitSilhouette(COLORS, SIDE_SELF, unitType, ALONG_SCREEN, 2, 0)).maxX;

      expect(long).toBeGreaterThan(plain);
    }
  });

  it('прокачка скорострельности добавляет стволы', () => {
    const single = polygonCount(assault(0, 0));
    const twin = polygonCount(assault(0, 1));
    const triple = polygonCount(assault(0, 2));

    expect(twin).toBeGreaterThan(single);
    expect(triple).toBeGreaterThan(twin);
  });

  it('оси прокачки независимы', () => {
    // Скорострельность добавляет стволы, но не удлиняет их. Точного
    // совпадения тут не будет: спаренные стволы разъезжаются вбок,
    // а поперечный размер даёт в горизонталь пусть небольшой, но вклад.
    // Отсюда допуск в процент — на порядок меньше, чем прирост от атаки.
    const single = bounds(assault(0, 0, ALONG_SCREEN)).maxX;
    const triple = bounds(assault(0, 2, ALONG_SCREEN)).maxX;
    expect(Math.abs(triple - single)).toBeLessThan(single * 0.01);
    // Атака удлиняет стволы, но не добавляет их. Верхняя ступень —
    // исключение: она приносит с собой дульный тормоз, деталь отдельную.
    expect(polygonCount(assault(1, 0))).toBe(polygonCount(assault(0, 0)));
  });

  it('прокачка чужого типа модель не трогает', () => {
    const before = polygonCount(unitSilhouette(COLORS, SIDE_SELF, UnitType.Sniper, 3, 0, 0));
    // Ступени штурмовика в запрос снайпера не входят вовсе — тип и ступени
    // задаются вместе, поэтому подмешаться чужой прокачке неоткуда.
    const after = polygonCount(unitSilhouette(COLORS, SIDE_SELF, UnitType.Sniper, 3, 0, 0));

    expect(after).toBe(before);
  });
});

describe('поворот', () => {
  it('силуэт зависит от румба', () => {
    const south = bounds(assault(0, 0, 3));
    const east = bounds(assault(0, 0, 1));

    expect(south.width).not.toBeCloseTo(east.width, 3);
  });

  it('на всех восьми румбах модель остаётся собранной', () => {
    for (let facing = 1; facing <= 8; facing += 1) {
      const silhouette = assault(0, 0, facing);

      expect(polygonCount(silhouette)).toBeGreaterThan(12);
      expect(silhouette.height).toBeGreaterThan(0);
    }
  });

  it('противоположные румбы различимы', () => {
    // Машина, идущая на зрителя, и машина, идущая от него, не должны
    // выглядеть одинаково: иначе разворот не читается вовсе. Мерка —
    // передний край: у одной он справа, у другой слева.
    const towards = bounds(assault(0, 0, ALONG_SCREEN));
    const away = bounds(assault(0, 0, 4));

    expect(towards.maxX).not.toBeCloseTo(away.maxX, 3);
  });
});

describe('кеш силуэтов', () => {
  it('повторный запрос возвращает ту же запись', () => {
    // Именно это делает модель дешёвой на кадре: геометрия строится один
    // раз на комбинацию, а на кадре остаётся сложение координат.
    expect(assault(1, 2, 5)).toBe(assault(1, 2, 5));
    expect(generalSilhouette(COLORS, SIDE_SELF, 4)).toBe(generalSilhouette(COLORS, SIDE_SELF, 4));
  });

  it('разные комбинации дают разные записи', () => {
    expect(assault(0, 0)).not.toBe(assault(1, 0));
    expect(assault(0, 0)).not.toBe(assault(0, 1));
    expect(assault(0, 0, 1)).not.toBe(assault(0, 0, 2));
  });

  it('смена палитры перестраивает кеш', () => {
    const before = assault();
    const other = unitSilhouette(
      { ...COLORS, self: 0x123456 },
      SIDE_SELF,
      UnitType.Assault,
      DIRECTION_SOUTH,
      0,
      0,
    );

    expect(other).not.toBe(before);
  });

  it('подряд идущих заливок одного цвета не остаётся', () => {
    // Склейка обязана съедать все соседние заливки одного цвета. Дальше
    // соседней заглядывать нельзя — перестановка граней ломает перекрытие
    // деталей, — поэтому больше от неё требовать и нечего.
    const colors = assault().fills.map((run) => run.color);

    for (let index = 1; index < colors.length; index += 1) {
      expect(colors[index]).not.toBe(colors[index - 1]);
    }
  });
});

describe('парение над полем', () => {
  it('соседние номера качаются не в такт', () => {
    // Строй, качающийся в такт, читается ошибкой синхронизации,
    // а не парением: живые вещи не дышат в ногу.
    expect(hoverBob(1, 0)).not.toBeCloseTo(hoverBob(2, 0), 3);
    expect(hoverBob(2, 0)).not.toBeCloseTo(hoverBob(3, 0), 3);
  });

  it('высота меняется от тика к тику', () => {
    expect(hoverBob(7, 0)).not.toBeCloseTo(hoverBob(7, 18), 3);
  });

  it('в нижней точке машина всё ещё не касается земли', () => {
    // Иначе это уже не парение, а прыжки: отражение то отрывается,
    // то слипается с колёсами.
    for (let tick = 0; tick < 200; tick += 1) {
      expect(UNIT_ALTITUDE + hoverBob(7, tick)).toBeGreaterThan(0);
    }
  });

  it('генерал идёт выше парящего юнита с запасом', () => {
    let highest = 0;
    for (let tick = 0; tick < 200; tick += 1) {
      highest = Math.max(highest, UNIT_ALTITUDE + hoverBob(7, tick));
    }

    // Втрое — это уже не «чуть выше», а другой ярус. Ровно на этом
    // и держится опознавание генерала.
    expect(GENERAL_ALTITUDE).toBeGreaterThan(highest * 3);
  });
});

describe('отражение в поверхности', () => {
  it('лежит под машиной, а не рядом с ней', () => {
    const model = bounds(assault());
    const mirror = bounds(assaultMirror());

    // Опрокидывается только высота. Опрокинь мы экранную `y` целиком —
    // отражение уехало бы вбок: в этой проекции `y` несёт и высоту,
    // и положение на плоскости.
    expect(mirror.minY).toBeGreaterThan(model.minY);
    expect(mirror.maxY).toBeGreaterThan(model.maxY);
    expect(mirror.minX).toBeCloseTo(model.minX, 6);
    expect(mirror.maxX).toBeCloseTo(model.maxX, 6);
  });

  it('сплюснуто по высоте', () => {
    // Зеркало мы видим под острым углом, и отражение в полную длину
    // читалось бы второй машиной, стоящей вниз головой.
    expect(bounds(assaultMirror()).height).toBeLessThan(bounds(assault()).height);
  });

  it('приглушено цветом поверхности, но не до пятна', () => {
    const model = assault();
    const mirror = assaultMirror();

    const dimmest = Math.max(...mirror.fills.map((run) => awayFromGround(run.color)));
    const brightest = Math.max(...model.fills.map((run) => awayFromGround(run.color)));

    // Смешивание поканальное и линейное, поэтому доля должна упасть
    // заметно — вдвое с запасом.
    expect(dimmest).toBeGreaterThan(0);
    expect(dimmest).toBeLessThan(brightest / 2);

    // Затенение граней при этом сохраняется: отражение остаётся
    // изображением машины, а не её тенью.
    expect(new Set(mirror.fills.map((run) => run.color)).size).toBeGreaterThan(1);
  });

  it('не несёт неоновой окантовки', () => {
    // Обводка сделала бы из отражения второй объект, а это изображение
    // объекта.
    expect(assaultMirror().outline).toHaveLength(0);
    expect(generalReflection(COLORS, SIDE_SELF, DIRECTION_SOUTH).outline).toHaveLength(0);
  });

  it('у генерала уходит от машины дальше, чем у юнита', () => {
    // Разрыв между машиной и отражением и есть мерка высоты. У генерала
    // он обязан быть больше — на этом держится его опознавание.
    const jetGap =
      bounds(generalReflection(COLORS, SIDE_SELF, DIRECTION_SOUTH)).minY -
      bounds(generalSilhouette(COLORS, SIDE_SELF, DIRECTION_SOUTH)).minY;
    const unitGap = bounds(assaultMirror()).minY - bounds(assault()).minY;

    expect(jetGap).toBeGreaterThan(unitGap * 3);
  });

  it('повторный запрос возвращает ту же запись', () => {
    expect(assaultMirror(1, 2, 5)).toBe(assaultMirror(1, 2, 5));
    expect(generalReflection(COLORS, SIDE_SELF, 4)).toBe(generalReflection(COLORS, SIDE_SELF, 4));
  });

  it('смена палитры перестраивает отражения', () => {
    const before = assaultMirror();
    const other = unitReflection(
      { ...COLORS, ground: 0x123456 },
      SIDE_SELF,
      UnitType.Assault,
      DIRECTION_SOUTH,
      0,
      0,
    );

    expect(other).not.toBe(before);
  });
});

describe('ударный вертолёт генерала', () => {
  it('идёт над землёй', () => {
    // Точка (0, 0) силуэта — это земля под машиной. Вся модель обязана
    // лежать выше неё: генерала опознают именно по тому, что он оторван
    // от земли дальше всех.
    expect(bounds(generalSilhouette(COLORS, SIDE_SELF, DIRECTION_SOUTH)).maxY).toBeLessThan(0);
  });

  it('силуэт шире любого юнита', () => {
    const gunship = bounds(generalSilhouette(COLORS, SIDE_SELF, DIRECTION_SOUTH));
    const unit = bounds(assault());

    expect(gunship.width).toBeGreaterThan(unit.width);
  });

  it('поворачивается на всех восьми румбах', () => {
    for (let facing = 1; facing <= 8; facing += 1) {
      expect(polygonCount(generalSilhouette(COLORS, SIDE_SELF, facing))).toBeGreaterThan(12);
    }
  });

  it('несёт ровно два светящихся хувера', () => {
    // Хуверы заменяют верхний винт, и говорит об этом их свечение.
    // Чистый цвет стороны на модели носят только они: у всех прочих
    // тел материал разбавлен тёмным корпусом, а верхняя грань неонового
    // диска остаётся цветом стороны в точности — освещённость верхней
    // грани равна единице, и `shade` её не трогает.
    //
    // Значит, число многоугольников чистого цвета стороны и есть число
    // хуверов. Их должно быть два, и ни одного лишнего: третье такое
    // пятно означало бы, что неон утёк на деталь, для которой он
    // не предназначен.
    const glowing = generalSilhouette(COLORS, SIDE_SELF, DIRECTION_SOUTH)
      .fills.filter((run) => run.color === COLORS.self)
      .reduce((count, run) => count + run.polygons.length, 0);

    expect(glowing).toBe(2);
  });

  it('свечение хувера ярче всего остального на машине', () => {
    // Если бы неон оказался не самым ярким, хувер читался бы глухим
    // кольцом, и признак «вот чем она держится» пропал бы.
    const green = (color: number): number => (color >> 8) & 0xff;
    const fills = generalSilhouette(COLORS, SIDE_SELF, DIRECTION_SOUTH).fills;

    expect(Math.max(...fills.map((run) => green(run.color)))).toBe(green(COLORS.self));
  });

  it('отражение не несёт окантовки и обходится без тени рядом', () => {
    // Тень убрана: рядом с отражением она читалась вторым отражением,
    // а не тенью. Здесь остаётся проверить, что заменять её отражение
    // не бросилось — окантовки у него по-прежнему нет.
    expect(generalReflection(COLORS, SIDE_SELF, DIRECTION_SOUTH).outline).toHaveLength(0);
  });
});

describe('скошенная броня', () => {
  /**
   * Верхняя граница числа заливок в силуэте.
   *
   * Число не круглое и взято не с потолка: замер до пересборки давал
   * 46 заливок в худшем случае (гранатомётчик на верхних ступенях обеих
   * веток), после пересборки — 48. Прибавка вся приходится на грани,
   * которые наклон вывел из тени: у отвесного тела они смотрели строго
   * от зрителя и не строились.
   *
   * Граница держится тесной намеренно. Любая новая деталь — это плюс
   * три-четыре заливки на каждой из двух сотен машин на экране, и склейка
   * по цвету от этого не спасает: она в этой модели не срабатывает
   * ни разу (см. «подряд идущих заливок одного цвета не остаётся»).
   * Значит, цена кадра — честное число заливок, умноженное на число
   * машин, и уводить его вверх молча нельзя.
   */
  const FILL_BUDGET = 50;

  it('число заливок остаётся в бюджете на всех комбинациях', () => {
    for (const unitType of UNIT_TYPES) {
      for (let attack = 0; attack < 3; attack += 1) {
        for (let fire = 0; fire < 3; fire += 1) {
          for (let facing = 1; facing < 9; facing += 1) {
            const silhouette = unitSilhouette(COLORS, SIDE_SELF, unitType, facing, attack, fire);

            expect(silhouette.fills.length).toBeLessThanOrEqual(FILL_BUDGET);
          }
        }
      }
    }
  });

  it('оттенков больше, чем может дать отвесное тело', () => {
    // У тела с отвесными боками грань принимает одну из трёх яркостей:
    // «на восток», «на юг» и верхнюю. Материалов четыре, значит потолок
    // плоского затенения — двенадцать оттенков на всю машину, и до
    // пересборки их было десять. Всё, что сверх двенадцати, могло взяться
    // только от наклонных граней.
    for (const unitType of UNIT_TYPES) {
      const silhouette = unitSilhouette(COLORS, SIDE_SELF, unitType, 2, 0, 0);
      const shades = new Set(silhouette.fills.map((run) => run.color));

      expect(shades.size).toBeGreaterThan(12);
    }
  });

  it('скос доезжает до отражения, не ломая его', () => {
    // Отражение строится обменом оснований местами, и обмен легко
    // испортить: при ошибке тело сворачивается, а координаты уходят
    // в NaN — молча, без единого исключения.
    for (const unitType of UNIT_TYPES) {
      const reflection = unitReflection(COLORS, SIDE_SELF, unitType, 2, 0, 0);

      expect(reflection.fills.length).toBeGreaterThan(0);

      for (const run of reflection.fills) {
        for (const polygon of run.polygons) {
          for (const point of polygon) {
            expect(Number.isFinite(point.x)).toBe(true);
            expect(Number.isFinite(point.y)).toBe(true);
          }
        }
      }
    }
  });

  it('у отражения граней не больше, чем у машины', () => {
    // Отражение показывает машину снизу, и грани, завалённые кверху,
    // в нём оказываются завалёнными книзу — то есть от зрителя.
    // Часть из них отсекается, и это не потеря, а следствие наклона.
    for (const unitType of UNIT_TYPES) {
      const model = unitSilhouette(COLORS, SIDE_SELF, unitType, 2, 0, 0);
      const reflection = unitReflection(COLORS, SIDE_SELF, unitType, 2, 0, 0);

      expect(reflection.fills.length).toBeLessThanOrEqual(model.fills.length);
    }
  });
});
