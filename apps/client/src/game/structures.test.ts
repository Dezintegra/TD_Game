import { describe, expect, it } from 'vitest';
import { DIRECTION_SOUTH, StructureKind } from '@td/shared';
import type { Solid } from './armour.js';
import { buildArmourMesh } from './armour.js';
import { DEFAULT_TUNING } from './armour-render.js';
import {
  BUILT_STEP,
  WALL_LINK_EAST,
  WALL_LINK_NORTH,
  WALL_LINK_SOUTH,
  WALL_LINK_WEST,
  WallShape,
  readinessLift,
  readinessStep,
  structureModelHeight,
  structureMuzzleHeight,
  structurePalette,
  structureSolids,
  wallLook,
} from './structures.js';

/**
 * Модель постройки проверяется числами, а не картинкой.
 *
 * Картинка сказала бы то же самое, но перестала бы что-либо доказывать
 * при первой смене палитры, а запекание её к тому же требует видеокарты.
 * Числа же отвечают ровно на те вопросы, которые ставит спецификация:
 * круглый ли ствол, стоит ли постамент по клетке, растёт ли стена в линию.
 */

const TOWERS = [StructureKind.TowerBasic, StructureKind.TowerSniper] as const;

const built = (kind: StructureKind, look = DIRECTION_SOUTH): readonly Solid[] =>
  structureSolids(kind, look, true, 1);

const labelled = (solids: readonly Solid[], label: string): Solid[] =>
  solids.filter((solid) => solid.label === label);

const extent = (solids: readonly Solid[], pick: (solid: Solid) => number[]): number =>
  Math.max(...solids.flatMap(pick));

const forwards = (solid: Solid): number[] =>
  [...solid.bottom, ...solid.top].map((point) => point.forward);
const sides = (solid: Solid): number[] =>
  [...solid.bottom, ...solid.top].map((point) => point.side);

/** Насколько далеко модель уходит в каждую из четырёх сторон, по битам маски. */
const reaches = (solids: readonly Solid[]): number[] => [
  extent(solids, forwards),
  extent(solids, sides),
  -Math.min(...solids.flatMap(forwards)),
  -Math.min(...solids.flatMap(sides)),
];

describe('башня — сооружение, а не коробка', () => {
  it('модель собрана из многих тел', () => {
    for (const kind of TOWERS) {
      expect(built(kind).length).toBeGreaterThan(15);
    }
  });

  it('у башни есть постамент, турель, маска орудия и ствол', () => {
    for (const kind of TOWERS) {
      const solids = built(kind);

      expect(labelled(solids, 'постамент')).toHaveLength(1);
      expect(labelled(solids, 'маска орудия')).toHaveLength(1);
      expect(labelled(solids, 'ствол').length).toBeGreaterThan(0);
    }
  });

  it('ствол круглый в сечении', () => {
    // Брус квадратного сечения читается балкой, а не орудием. Это
    // единственная деталь, по которой на полусотне пикселей видно,
    // что постройка вооружена.
    for (const kind of TOWERS) {
      for (const barrel of labelled(built(kind), 'ствол')) {
        expect(barrel.bottom.length).toBeGreaterThan(4);
        expect(barrel.round).toBe(true);
      }
    }
  });

  it('виды различаются силуэтом, а не размером', () => {
    // Снайперская выше и уже: её дальность должна читаться с поля
    // раньше, чем игрок наведёт курсор.
    const basic = built(StructureKind.TowerBasic);
    const sniper = built(StructureKind.TowerSniper);

    expect(structureModelHeight(StructureKind.TowerSniper)).toBeGreaterThan(
      structureModelHeight(StructureKind.TowerBasic),
    );
    expect(extent(sniper, sides)).toBeLessThan(extent(basic, sides));
    expect(labelled(basic, 'ствол')).toHaveLength(2);
    expect(labelled(sniper, 'ствол')).toHaveLength(1);
  });

  it('основание башни лежит внутри клетки', () => {
    // Границы клетки игрок читает по постройке, и тело, вылезшее за них,
    // соврало бы о том, что занято. Проверяется основание, а не вся
    // модель: ствол торчит наружу поверху, и это законно.
    for (const kind of TOWERS) {
      for (const look of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const ground = built(kind, look).filter((solid) =>
          solid.bottom.every((point) => point.up === 0),
        );

        expect(ground.length).toBeGreaterThan(0);
        expect(extent(ground, forwards)).toBeLessThanOrEqual(0.5);
        expect(extent(ground, sides)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('постамент не поворачивается вместе с турелью', () => {
    // Постамент, повёрнутый на сорок пять градусов, вылез бы за клетку,
    // а восьмигранник ещё и подставил бы вершину туда, где была грань.
    for (const kind of TOWERS) {
      const south = labelled(built(kind, DIRECTION_SOUTH), 'постамент')[0];
      const west = labelled(built(kind, 5), 'постамент')[0];

      expect(south).toBeDefined();
      expect(west).toEqual(south);
    }
  });

  it('турель повёрнута туда, куда смотрит румб', () => {
    const south = labelled(built(StructureKind.TowerBasic, DIRECTION_SOUTH), 'ствол')[0];
    const west = labelled(built(StructureKind.TowerBasic, 5), 'ствол')[0];
    if (south === undefined || west === undefined) throw new Error('ствола нет');

    // Повёрнутый на два румба ствол уходит туда, где у неповёрнутого был бок.
    expect(Math.max(...forwards(west))).toBeLessThan(Math.max(...forwards(south)));
    expect(Math.max(...sides(west))).toBeCloseTo(Math.max(...forwards(south)), 6);
  });

  it('выстрел выходит из ствола, а не рядом с ним', () => {
    for (const kind of TOWERS) {
      const barrel = labelled(built(kind), 'ствол')[0];
      if (barrel === undefined) throw new Error('ствола нет');

      const axis =
        (Math.max(...barrel.bottom.map((point) => point.up)) +
          Math.min(...barrel.bottom.map((point) => point.up))) /
        2;

      expect(axis).toBeCloseTo(structureMuzzleHeight(kind), 6);
    }
  });

  it('высота модели совпадает с высотой запечённой сетки', () => {
    // Два числа вместо одного — это приглашение к расхождению. Полоса
    // прочности берёт высоту у спрайта, а точка попадания выстрела —
    // из таблицы, и разъехаться им нельзя.
    for (const kind of [...TOWERS, StructureKind.Wall]) {
      const mesh = buildArmourMesh(built(kind), DIRECTION_SOUTH);
      expect(mesh.modelHeight).toBeCloseTo(structureModelHeight(kind), 6);
    }
  });
});

describe('ход возведения', () => {
  it('у недостроя нет ни турели, ни ствола', () => {
    for (const kind of TOWERS) {
      const raw = structureSolids(kind, DIRECTION_SOUTH, false, readinessLift(0));

      expect(labelled(raw, 'ствол')).toHaveLength(0);
      expect(labelled(raw, 'маска орудия')).toHaveLength(0);
      expect(labelled(raw, 'постамент')).toHaveLength(1);
    }
  });

  it('недострой ниже готовой постройки, но не плоский', () => {
    for (const kind of TOWERS) {
      const raw = structureSolids(kind, DIRECTION_SOUTH, false, readinessLift(0));
      const top = Math.max(...raw.flatMap((solid) => solid.top.map((point) => point.up)));

      expect(top).toBeGreaterThan(0);
      expect(top).toBeLessThan(structureModelHeight(kind));
    }
  });

  it('облик недостроя не зависит от разворота и от связей', () => {
    // На этом стоит ключ кеша: иначе восемь румбов недостроя дали бы
    // восемь текстур, которых никто не различит.
    expect(structureSolids(StructureKind.TowerBasic, 1, false, 0.5)).toEqual(
      structureSolids(StructureKind.TowerBasic, 7, false, 0.5),
    );
    expect(structureSolids(StructureKind.Wall, 0, false, 0.5)).toEqual(
      structureSolids(StructureKind.Wall, 15, false, 0.5),
    );
  });

  it('последняя ступень означает «достроено», и только она', () => {
    expect(readinessStep(1)).toBe(BUILT_STEP);
    expect(readinessStep(0.99)).toBeLessThan(BUILT_STEP);
    expect(readinessLift(BUILT_STEP)).toBe(1);
    expect(readinessLift(0)).toBeGreaterThan(0);
  });
});

describe('стена сливается в линию', () => {
  const wall = (mask: number): readonly Solid[] =>
    structureSolids(StructureKind.Wall, mask, true, 1);

  const hasPylon = (mask: number): boolean => labelled(wall(mask), 'контрфорс').length > 0;

  it('маска раскладывается на шесть форм', () => {
    expect(wallLook(0).shape).toBe(WallShape.Post);
    expect(wallLook(WALL_LINK_SOUTH).shape).toBe(WallShape.End);
    expect(wallLook(WALL_LINK_SOUTH | WALL_LINK_NORTH).shape).toBe(WallShape.Straight);
    expect(wallLook(WALL_LINK_SOUTH | WALL_LINK_WEST).shape).toBe(WallShape.Corner);
    expect(wallLook(WALL_LINK_SOUTH | WALL_LINK_WEST | WALL_LINK_NORTH).shape).toBe(WallShape.Tee);
    expect(wallLook(15).shape).toBe(WallShape.Cross);
  });

  it('поворот связей на четверть даёт ту же форму и следующий румб', () => {
    // Ради этого свойства биты и уложены по часовой стрелке: шестнадцать
    // строк, написанных руками, разошлись бы с формами молча.
    //
    // «Следующий» считается по периоду самой формы, а не всегда по четырём:
    // столб и перекрестье при повороте переходят сами в себя, прогон —
    // сам в себя через полоборота. Разворот у них поэтому всегда нулевой
    // и первый, а не пробегает все четыре, — и это не изъян таблицы,
    // а свойство симметрии, на котором держится счёт комбинаций кеша.
    const period: Readonly<Record<WallShape, number>> = {
      [WallShape.Post]: 1,
      [WallShape.End]: 4,
      [WallShape.Straight]: 2,
      [WallShape.Corner]: 4,
      [WallShape.Tee]: 4,
      [WallShape.Cross]: 1,
    };

    for (let mask = 0; mask < 16; mask += 1) {
      const turned = ((mask << 1) | (mask >> 3)) & 15;
      const look = wallLook(mask);
      const steps = period[look.shape];

      expect(wallLook(turned).shape).toBe(look.shape);
      expect(wallLook(turned).quarter).toBe((look.quarter + 1) % steps);
    }
  });

  it('контрфорс стоит везде, кроме прямого прогона', () => {
    // Поставь его в каждую клетку — и прямая стена превратится
    // в нанизанные бусины; убери с угла — и на внешнем углу останется
    // голое вертикальное ребро.
    expect(hasPylon(WALL_LINK_SOUTH | WALL_LINK_NORTH)).toBe(false);
    expect(hasPylon(WALL_LINK_WEST | WALL_LINK_EAST)).toBe(false);

    for (const mask of [0, WALL_LINK_SOUTH, WALL_LINK_SOUTH | WALL_LINK_WEST, 7, 15]) {
      expect(hasPylon(mask)).toBe(true);
    }
  });

  it('стена достаёт до границы клетки ровно по связанным сторонам', () => {
    // Нахлёст обязателен: оборвись геометрия ровно на границе, вдоль
    // стыка двух спрайтов пошла бы светлая нитка — две половинные
    // прозрачности складываются в три четверти, а не в единицу.
    for (let mask = 0; mask < 16; mask += 1) {
      const reach = reaches(wall(mask));

      for (let bit = 0; bit < 4; bit += 1) {
        const linked = (mask & (1 << bit)) !== 0;
        const value = reach[bit] ?? 0;

        if (linked) expect(value).toBeGreaterThan(0.5);
        else expect(value).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('нить по гребню идёт через всю связанную сторону', () => {
    // Нить — маркер стороны и то, что сваривает звенья в одну стену:
    // у соседних клеток нити встречаются на границе и продолжают
    // друг друга.
    const straight = labelled(wall(WALL_LINK_SOUTH | WALL_LINK_NORTH), 'нить');
    expect(straight).toHaveLength(1);
    expect(Math.max(...straight.flatMap(forwards))).toBeGreaterThan(0.5);
    expect(Math.min(...straight.flatMap(forwards))).toBeLessThan(-0.5);
  });

  it('одинокая стена — столб, и он не тянется никуда', () => {
    const post = wall(0);

    expect(labelled(post, 'нить')).toHaveLength(0);
    expect(Math.max(...reaches(post))).toBeLessThan(0.5);
  });
});

describe('принадлежность несут маркеры', () => {
  /** Значения из `tokens.css`. Здесь они нужны числами: CSS в тестах нет. */
  const SELF = 0x00ff29;
  const ENEMY = 0xd264ff;
  const SKY = [0x5c / 255, 0x7e / 255, 0xa8 / 255] as const;

  const palette = (accent: number): readonly number[] =>
    structurePalette({
      plate: 0x3d4245,
      steel: 0x585e62,
      concrete: 0x6b6f72,
      glass: 0x232e36,
      accent,
    });

  const channels = (color: number): number[] => [
    ((color >> 16) & 0xff) / 255,
    ((color >> 8) & 0xff) / 255,
    (color & 0xff) / 255,
  ];

  /** Мерка приглушённости у нас одна на всё поле — та же, что у скал. */
  const hsv = (colour: readonly number[]): { saturation: number; value: number } => {
    const [r = 0, g = 0, b = 0] = colour;
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);

    return { saturation: high === 0 ? 0 : (high - low) / high, value: high };
  };

  /**
   * Самое яркое, что материал может выдать: полный свет плюс свет неба.
   *
   * Берётся максимум обоих сразу — на поверхности так не совпадёт
   * никогда, значит проверка строже действительности. Тот же приём,
   * что в `relief-palette.test.ts`, и это не совпадение: правило
   * приглушённости одно, значит и мерка обязана быть одна.
   */
  const brightest = (color: number): number[] =>
    channels(color).map(
      (channel, index) => channel + (SKY[index] ?? 0) * DEFAULT_TUNING.skyStrength,
    );

  it('палитры двух сторон различаются только маркером', () => {
    const self = palette(SELF);
    const enemy = palette(ENEMY);

    const differing = self.filter((color, index) => color !== enemy[index]);
    expect(differing).toEqual([SELF]);
  });

  it('корпус заметно тусклее любой из сторон', () => {
    // Стороны опознаются полной яркостью, постройка — приглушённостью.
    // Возьми корпус долю цвета стороны — и поле превратилось бы
    // в светящиеся глыбы, между которыми теряются машины.
    //
    // Проверяются три материала корпуса: броня, сталь и бетон. Линза
    // и маркер сюда не входят намеренно — они и обязаны быть яркими.
    for (const material of [0, 1, 2]) {
      const extreme = hsv(brightest(palette(SELF)[material] ?? 0));

      for (const side of [SELF, ENEMY]) {
        const theirs = hsv(channels(side));
        expect(extreme.value).toBeLessThan(theirs.value - 0.2);
        expect(extreme.saturation).toBeLessThan(theirs.saturation - 0.2);
      }
    }
  });
});
