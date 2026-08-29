import { DIRECTION_SOUTH, StructureKind, UNIT_TYPES } from '@td/shared';
import type { UnitType } from '@td/shared';
import type { Renderer } from 'pixi.js';
import { DEFAULT_TUNING, bakeArmour } from './armour-render.js';
import { ARMOUR_SUPERSAMPLE } from './bake-density.js';
import type { ArmourTuning } from './armour-render.js';
import { generalSolids, machinePalette, unitSolids } from './machines.js';
import {
  WALL_LINK_NORTH,
  WALL_LINK_SOUTH,
  structurePalette,
  structureSolids,
} from './structures.js';
import type { MachineSpriteColors } from './machine-sprites.js';
import type { StructureSpriteColors } from './structure-sprites.js';

/**
 * Иконки интерфейса — те же тела, что и на поле, только крупнее.
 *
 * Плитка заказа отвечает на вопрос «та ли это машина», и схематичный
 * контур на него не отвечает: игрок сопоставляет рисунок с машиной
 * на поле сам, а ошибается не в названии, а в заказе. Поэтому иконка
 * печётся тем же `bakeArmour`, из тех же наборов тел, тем же светом
 * и в той же проекции, что и спрайт на поле. Расхождение между иконкой
 * и машиной становится невозможным: их рисует один код.
 *
 * ## Почему не картинки в репозитории
 *
 * Растровая иконка разошлась бы с моделью при первой же правке модели,
 * и заметить это было бы некому: файл лежит в репозитории и выглядит
 * свежим, пока его кто-нибудь не откроет. Тут же нечему расходиться.
 *
 * ## Почему data-URL, а не холст
 *
 * Одна и та же иконка стоит и на плитке заказа, и в строке окна
 * прокачки, и в сводке стороны. Холст на каждое место — это три десятка
 * холстов вместо десяти строк; строка же кешируется браузером и рисуется
 * обычной картинкой.
 *
 * ## Почему по одной за кадр
 *
 * Ровно по той же причине, по какой по кускам печётся рельеф: запекание
 * идёт в главном потоке, и семь штук подряд съели бы кадр целиком.
 * Игрок при этом ничего не ждёт — до готовности плитка показывает
 * прежний контурный значок, а замена не двигает вёрстку.
 */

/**
 * Ключ иконки.
 *
 * Строкой, а не парой «вид, номер»: карта иконок уезжает в store,
 * а по строковому ключу компонент достаёт свою иконку одним обращением,
 * не разбирая, юнит перед ним или постройка.
 */
export type IconKey = string;

/**
 * Сторона, в цветах которой печётся иконка.
 *
 * Номером, а не признаком «своё — чужое»: тем же числом стороны говорят
 * между собой запекатели поля, и второе обозначение того же разошлось бы
 * с первым.
 */
export const SIDE_SELF = 0;
export const SIDE_ENEMY = 1;

export const unitIconKey = (unitType: UnitType, side: number): IconKey =>
  `unit-${String(unitType)}-${String(side)}`;
export const structureIconKey = (kind: StructureKind, side: number): IconKey =>
  `structure-${String(kind)}-${String(side)}`;
export const generalIconKey = (side: number): IconKey => `general-${String(side)}`;

export type IconMap = Readonly<Record<IconKey, string>>;

/**
 * Во сколько раз иконка плотнее поля.
 *
 * Модель юнита занимает на поле около полусотни точек, а показывается
 * иконка на тридцати-сорока. Четырёхкратная плотность даёт около двух
 * сотен точек на ту же модель — впятеро больше показанного размера,
 * то есть резко при любой плотности экрана, включая тройную.
 *
 * Больше брать незачем: цена запекания растёт как квадрат стороны,
 * а разницы на экране уже не видно.
 */
const ICON_RESOLUTION = 4;

/**
 * Во сколько раз черновик иконки плотнее её самой.
 *
 * Броня печётся в черновик и уменьшается вторым проходом — так получается
 * сглаживание, не спорящее с затенением в стыках. Кратность берётся общая
 * с полем: у иконки своя плотность, назначенная выше и от экрана
 * не зависящая, а вот отношение черновика к готовому — та же величина
 * и того же смысла.
 *
 * Прежде здесь стояла тройка, потому что столько было у поля. Полтора
 * иконке хватает с избытком: она печётся вчетверо плотнее показа
 * и уменьшается браузером, а уменьшение сглаживает само.
 */
const ICON_SUPERSAMPLE = ARMOUR_SUPERSAMPLE;

/**
 * Ступени прокачки у иконки нулевые.
 *
 * Плитка, меняющая картинку от покупки дальности, читается как ДРУГАЯ
 * плитка, а не как та же с длинным стволом. Постоянство иконки здесь
 * важнее её точности.
 */
const BASE_TIER = 0;

/**
 * Облик стены на иконке — прямой участок вдоль оси «юг — север».
 *
 * Столб (нулевая маска) выглядел бы тумбой и не сообщал бы, что стену
 * ставят линией. Прямой участок вдоль юга даёт на экране ту же диагональ
 * влево вниз, по которой едут машины, — и все иконки складываются
 * в один ракурс, а не в несколько разных.
 */
const WALL_ICON_LOOK = WALL_LINK_SOUTH | WALL_LINK_NORTH;

/**
 * Фактура постройки грубее машинной — та же, что на поле.
 *
 * Повторена здесь, а не взята из `structure-sprites.ts`: там она
 * не экспортируется, а открывать её наружу ради иконки значило бы
 * сделать подробность запекания поля частью чужого договора. Совпадение
 * значений удерживает проверка `icon-sprites.test.ts`.
 */
const STRUCTURE_TUNING: ArmourTuning = {
  ...DEFAULT_TUNING,
  seamFrequency: 5,
  seamWidth: 0.009,
  seamDepth: 0.5,
};

/**
 * Постройки, у которых есть своё тело.
 *
 * Базы здесь нет намеренно: тело у неё есть, но печёт его отдельный
 * запекатель и печёт целиком — подиум четыре на четыре клетки
 * с антенной. В иконку на тридцать точек такое тело не сворачивается,
 * выходит пятно. Ядерного удара нет по другой причине: у него тела
 * нет вовсе, это событие, а не предмет на поле.
 */
const ICON_STRUCTURES: readonly StructureKind[] = [
  StructureKind.Wall,
  StructureKind.TowerBasic,
  StructureKind.TowerSniper,
];

/**
 * Порядок запекания: сперва всё своё, потом всё чужое.
 *
 * Порядок здесь значит ровно то, что игрок увидит раньше. Плитки заказа
 * и строки прокачки показывают только СВОИ объекты, и они на экране всё
 * время; чужие иконки живут в одной сводке из шести значков. Своё
 * поэтому идёт первым — по иконке за кадр, и к седьмому кадру плитки
 * уже настоящие.
 */
export const ICON_KEYS: readonly IconKey[] = [SIDE_SELF, SIDE_ENEMY].flatMap((side) => [
  ...UNIT_TYPES.map((unitType) => unitIconKey(unitType, side)),
  generalIconKey(side),
  ...ICON_STRUCTURES.map((kind) => structureIconKey(kind, side)),
]);

export interface IconBaker {
  /**
   * Запечь очередную иконку.
   *
   * Возвращает пополненную карту, пока работа есть, и `null`, когда
   * всё запечено. Карта каждый раз новая: её сравнивают по ссылке.
   */
  step(): IconMap | null;
}

/**
 * Запекатель иконок.
 *
 * Ничего не делает, пока его не позовут: вызывать `step` положено
 * из кадра и ПОСЛЕ того, как допечён рельеф. Старт матча уже держит
 * запекание рельефа, и складывать с ним ещё и иконки нельзя.
 */
export const createIconBaker = (
  renderer: Renderer,
  machineColors: MachineSpriteColors,
  structureColors: StructureSpriteColors,
): IconBaker => {
  // Цвет стороны — единственное, чем набор чужих иконок отличается
  // от своего. Броня, стекло, бетон и небо у обеих сторон одни: стороны
  // различаются оттенком маркеров и подсветкой по краю, а не веществом,
  // из которого сделана машина.
  const machineArmour = (side: number) => {
    const accent = side === SIDE_SELF ? machineColors.self : machineColors.enemy;

    return {
      palette: machinePalette({
        plate: machineColors.plate,
        metal: machineColors.metal,
        shadow: machineColors.shadow,
        glass: machineColors.glass,
        accent,
      }),
      accent,
      sky: machineColors.sky,
      ground: machineColors.ground,
    };
  };

  const structureArmour = (side: number) => {
    const accent = side === SIDE_SELF ? structureColors.self : structureColors.enemy;

    return {
      palette: structurePalette({
        plate: structureColors.plate,
        steel: structureColors.steel,
        concrete: structureColors.concrete,
        glass: structureColors.glass,
        accent,
      }),
      accent,
      sky: structureColors.sky,
      ground: structureColors.ground,
    };
  };

  const bakers: Readonly<Record<IconKey, () => ReturnType<typeof bakeArmour>>> = Object.fromEntries(
    [SIDE_SELF, SIDE_ENEMY].flatMap((side) => [
      ...UNIT_TYPES.map((unitType): [IconKey, () => ReturnType<typeof bakeArmour>] => [
        unitIconKey(unitType, side),
        () =>
          bakeArmour(
            renderer,
            unitSolids(unitType, BASE_TIER, BASE_TIER, BASE_TIER),
            // Юг — и это не «примерно влево вниз», а ровно оно: проекция
            // переводит мировой юг в экранный сдвиг влево и вниз. Та же
            // причина стоит за тем, что юг выбран направлением
            // по умолчанию для всего, что обязано куда-то смотреть.
            DIRECTION_SOUTH,
            machineArmour(side),
            false,
            ICON_RESOLUTION,
            ICON_SUPERSAMPLE,
          ),
      ]),
      [
        generalIconKey(side),
        () =>
          bakeArmour(
            renderer,
            generalSolids(),
            DIRECTION_SOUTH,
            machineArmour(side),
            false,
            ICON_RESOLUTION,
            ICON_SUPERSAMPLE,
          ),
      ] as [IconKey, () => ReturnType<typeof bakeArmour>],
      ...ICON_STRUCTURES.map((kind): [IconKey, () => ReturnType<typeof bakeArmour>] => [
        structureIconKey(kind, side),
        () =>
          bakeArmour(
            renderer,
            structureSolids(
              kind,
              kind === StructureKind.Wall ? WALL_ICON_LOOK : DIRECTION_SOUTH,
              true,
              1,
            ),
            // Постройка всегда печётся на юг: разворот турели и разворот
            // стены сделаны поворотом местных координат, а не запеканием.
            DIRECTION_SOUTH,
            structureArmour(side),
            false,
            ICON_RESOLUTION,
            ICON_SUPERSAMPLE,
            STRUCTURE_TUNING,
          ),
      ]),
    ]),
  );

  let next = 0;
  let icons: IconMap = {};

  return {
    step: () => {
      const key = ICON_KEYS[next];
      if (key === undefined) return null;
      next += 1;

      const bake = bakers[key];
      if (bake === undefined) return null;

      const baked = bake();
      try {
        // Через холст, а не через `extract.base64`: тот же результат,
        // но без промиса. Промис здесь означал бы, что иконки печатаются
        // не по одной за кадр, а пачкой в одном сливе микрозадач, —
        // то есть ровно то, от чего пошаговость и заводилась.
        const canvas = renderer.extract.canvas(baked.texture);
        const url = canvas.toDataURL?.('image/png');
        if (url !== undefined) icons = { ...icons, [key]: url };
      } finally {
        // Освобождать обязательно: текстура живёт в видеопамяти,
        // а сборщик мусора о видеопамяти не знает. Здесь она нужна
        // ровно на один вызов — дальше живёт строка, а не текстура.
        baked.texture.destroy(true);
      }

      return icons;
    },
  };
};

/** Только для проверок: чем и как печётся иконка. */
export const ICON_BAKE_PARAMS = {
  resolution: ICON_RESOLUTION,
  facing: DIRECTION_SOUTH,
  wallLook: WALL_ICON_LOOK,
  tier: BASE_TIER,
  structureTuning: STRUCTURE_TUNING,
} as const;
