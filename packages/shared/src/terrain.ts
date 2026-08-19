/**
 * Тип клетки карты.
 *
 * Земля плоская, высот нет — клетка либо проходима, либо нет.
 * Различаем два вида непроходимости, потому что ведут они себя по-разному:
 * скалу нельзя разрушить, стену можно.
 */
export const Terrain = {
  /** Проходимая земля. */
  Ground: 0,
  /** Скала из генерации мира. Неразрушима. */
  Rock: 1,
  /** Стена, построенная игроком. Разрушима. */
  Wall: 2,
} as const;

export type Terrain = (typeof Terrain)[keyof typeof Terrain];

export const isPassable = (terrain: Terrain): boolean => terrain === Terrain.Ground;
