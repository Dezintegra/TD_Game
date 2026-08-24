import { describe, expect, it } from 'vitest';
import { UNIT_TYPES, UnitType } from '@td/shared';
import type { Solid } from './armour.js';
import { Material, generalSolids, machinePalette, unitSolids } from './machines.js';

/**
 * Из чего собраны машины.
 *
 * Проверяется не красота — её видно только в матче, — а то, что от неё
 * не пострадало: признаки типа, признаки прокачки и признаки стороны.
 * Всё это игрок читает с поля взглядом, и отделка не имеет права их
 * сдвинуть.
 */

const labelled = (solids: readonly Solid[], label: string): Solid[] =>
  solids.filter((solid) => solid.label === label);

const span = (solids: readonly Solid[]): { length: number; width: number; height: number } => {
  let minF = Infinity;
  let maxF = -Infinity;
  let minS = Infinity;
  let maxS = -Infinity;
  let maxUp = -Infinity;

  for (const solid of solids) {
    for (const point of [...solid.bottom, ...solid.top]) {
      minF = Math.min(minF, point.forward);
      maxF = Math.max(maxF, point.forward);
      minS = Math.min(minS, point.side);
      maxS = Math.max(maxS, point.side);
      maxUp = Math.max(maxUp, point.up);
    }
  }

  return { length: maxF - minF, width: maxS - minS, height: maxUp };
};

describe('состав машины', () => {
  it('каждый тип собран из многих тел', () => {
    for (const unitType of UNIT_TYPES) {
      expect(unitSolids(unitType, 0, 0).length).toBeGreaterThan(20);
    }
  });

  it('число колёс различает типы', () => {
    // Число колёс — признак типа, а не отделка: по нему игрок отличает
    // тяжёлую машину от средней раньше, чем разглядит пропорции.
    expect(labelled(unitSolids(UnitType.Tesla, 0, 0), 'колесо')).toHaveLength(6);
    expect(labelled(unitSolids(UnitType.Assault, 0, 0), 'колесо')).toHaveLength(4);
    expect(labelled(unitSolids(UnitType.Sniper, 0, 0), 'колесо')).toHaveLength(4);
  });

  it('колёса и стволы круглые в сечении', () => {
    const solids = unitSolids(UnitType.Assault, 0, 0);

    for (const wheel of labelled(solids, 'колесо')) expect(wheel.round).toBe(true);
    for (const barrel of labelled(solids, 'ствол 1')) expect(barrel.round).toBe(true);
  });

  it('силуэты типов остаются разными', () => {
    const sniper = span(unitSolids(UnitType.Sniper, 0, 0));
    const tesla = span(unitSolids(UnitType.Tesla, 0, 0));
    const assault = span(unitSolids(UnitType.Assault, 0, 0));

    // Снайпер длинный и низкий, Тесла широкая и высокая, штурмовик
    // посередине. Различие по габаритам обязано сохраниться, иначе типы
    // перестанут читаться.
    expect(sniper.height).toBeLessThan(assault.height);
    expect(tesla.height).toBeGreaterThan(assault.height);
    expect(tesla.width).toBeGreaterThan(sniper.width);
  });

  it('у каждой машины есть маска орудия', () => {
    for (const unitType of UNIT_TYPES) {
      const solids = unitSolids(unitType, 0, 0);
      const masks = solids.filter((solid) => solid.label.startsWith('маска'));

      expect(masks.length).toBeGreaterThan(0);
    }
  });
});

describe('машина генерала', () => {
  it('висит выше юнита целиком', () => {
    // Признак генерала — величина отрыва от земли. Пересекись он по высоте
    // с обычной машиной, и опознавать его пришлось бы по деталям, которых
    // на сорока пикселях не разглядеть.
    const lowest = Math.min(
      ...generalSolids().flatMap((solid) =>
        [...solid.bottom, ...solid.top].map((point) => point.up),
      ),
    );

    for (const unitType of UNIT_TYPES) {
      expect(lowest).toBeGreaterThan(span(unitSolids(unitType, 2, 2)).height);
    }
  });

  it('собран из многих тел и несёт остекление', () => {
    const solids = generalSolids();

    expect(solids.length).toBeGreaterThan(15);
    expect(solids.some((solid) => solid.material === Material.Glass)).toBe(true);
  });
});

describe('прокачка на модели', () => {
  it('атака удлиняет ствол', () => {
    const short = span(labelled(unitSolids(UnitType.Assault, 0, 0), 'ствол 1'));
    const long = span(labelled(unitSolids(UnitType.Assault, 2, 0), 'ствол 1'));

    expect(long.length).toBeGreaterThan(short.length);
  });

  it('атака утолщает ствол', () => {
    const thin = span(labelled(unitSolids(UnitType.Assault, 0, 0), 'ствол 1'));
    const thick = span(labelled(unitSolids(UnitType.Assault, 2, 0), 'ствол 1'));

    expect(thick.width).toBeGreaterThan(thin.width);
  });

  it('скорострельность добавляет стволы', () => {
    const barrels = (fire: number): number =>
      unitSolids(UnitType.Assault, 0, fire).filter((solid) => solid.label.startsWith('ствол '))
        .length;

    expect(barrels(0)).toBe(1);
    expect(barrels(1)).toBe(2);
    expect(barrels(2)).toBe(3);
  });

  it('верхняя ступень атаки добавляет дульный тормоз', () => {
    const brakes = (attack: number): number =>
      unitSolids(UnitType.Assault, attack, 0).filter((solid) =>
        solid.label.startsWith('дульный тормоз'),
      ).length;

    expect(brakes(0)).toBe(0);
    expect(brakes(1)).toBe(0);
    expect(brakes(2)).toBe(1);
  });

  it('прокачка чужого типа модель не трогает', () => {
    const plain = unitSolids(UnitType.Sniper, 0, 0);
    const same = unitSolids(UnitType.Sniper, 0, 0);

    expect(plain).toEqual(same);
  });
});

describe('маркеры стороны', () => {
  it('есть у каждой машины и лежат на горизонтали', () => {
    const machines = [...UNIT_TYPES.map((type) => unitSolids(type, 0, 0)), generalSolids()];

    for (const solids of machines) {
      const markers = solids.filter((solid) => solid.material === Material.Neon);
      expect(markers.length).toBeGreaterThan(2);

      // Маркер на борту пропадал бы на каждом втором развороте: камера
      // смотрит сверху, и борт виден только у половины румбов.
      for (const marker of markers) {
        const flat = marker.bottom.every(
          (point, index) => Math.abs(point.up - (marker.bottom[0]?.up ?? 0)) < 1e-9 || index === 0,
        );
        expect(flat).toBe(true);
      }
    }
  });

  it('маркеры разбросаны по всей машине', () => {
    // Иначе на румбе, где маркер закрыт корпусом, сторона не читается
    // вовсе. Раскидать их по длине — самый дешёвый способ этого избежать.
    const markers = unitSolids(UnitType.Assault, 0, 0).filter(
      (solid) => solid.material === Material.Neon,
    );
    const forwards = markers.map((marker) => marker.bottom[0]?.forward ?? 0);

    expect(Math.max(...forwards) - Math.min(...forwards)).toBeGreaterThan(0.3);
  });
});

describe('палитра', () => {
  const COLORS = {
    plate: 0x3d4245,
    metal: 0x585e62,
    shadow: 0x131618,
    glass: 0x232e36,
  };

  it('цвет стороны несёт только маркер', () => {
    const mine = machinePalette({ ...COLORS, accent: 0x00ff29 });
    const theirs = machinePalette({ ...COLORS, accent: 0xd264ff });

    expect(mine[Material.Hull]).toBe(theirs[Material.Hull]);
    expect(mine[Material.Gun]).toBe(theirs[Material.Gun]);
    expect(mine[Material.Tread]).toBe(theirs[Material.Tread]);
    expect(mine[Material.Glass]).toBe(theirs[Material.Glass]);
    expect(mine[Material.Neon]).not.toBe(theirs[Material.Neon]);
  });

  it('броня светлее поля, а тень темнее', () => {
    // Поле — `#191919`. Броня обязана быть светлее его, иначе теневой борт
    // машины пропадает на тёмной земле; тень, наоборот, обязана уходить
    // в провал, иначе машина теряет опору.
    const field = 0x19;
    const channel = (color: number): number => (color >> 8) & 0xff;
    const palette = machinePalette({ ...COLORS, accent: 0x00ff29 });

    expect(channel(palette[Material.Hull] ?? 0)).toBeGreaterThan(field);
    expect(channel(palette[Material.Tread] ?? 0)).toBeLessThan(field);
  });
});
