import type { ReactNode } from 'react';
import { StructureKind, UnitType } from '@td/shared';
import { SIDE_SELF, generalIconKey, structureIconKey, unitIconKey } from '../game/icon-sprites.js';
import { useHudStore } from '../game/store.js';

/**
 * Пиктограммы юнитов и построек для верхней полосы.
 *
 * Живут в HUD клиента, а не в `packages/ui`. Та библиотека собрана
 * из вещей, ничего не знающих об игре, — кнопка, поле, панель, — а это
 * содержимое: чтобы нарисовать штурмовика, надо знать, что он есть.
 *
 * Цвет не задаётся: все линии рисуются `currentColor`, и сторону задаёт
 * родитель через `color`. Так одна и та же пиктограмма служит и своей
 * стороне, и чужой, а литеральных цветов в компонентах не появляется —
 * это прямое требование проекта.
 *
 * Силуэты подобраны по одному признаку каждый, и признак этот тот же,
 * по которому машина узнаётся на поле:
 * штурмовик — широкий и приземистый, снайпер — длинный ствол,
 * Тесла — мачта с катушкой, стена — глухой блок, башня — башня,
 * снайперская — башня с тем же длинным стволом.
 */

interface GlyphProps {
  readonly children: ReactNode;
}

const Glyph = ({ children }: GlyphProps) => (
  <svg
    viewBox="0 0 24 24"
    width="100%"
    height="100%"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinejoin="round"
    strokeLinecap="round"
    aria-hidden
    focusable="false"
  >
    {children}
  </svg>
);

/** Штурмовик: широкий приземистый корпус, ствол короткий и толстый. */
const AssaultGlyph = () => (
  <Glyph>
    <path d="M3 16 L6 11 H18 L21 16 Z" />
    <rect x="9" y="6" width="6" height="5" />
    <path d="M12 6 V3" strokeWidth={2.4} />
  </Glyph>
);

/** Снайпер: узкий корпус, ствол длинный и тонкий, вынесен вбок. */
const SniperGlyph = () => (
  <Glyph>
    <path d="M5 17 L7 12 H16 L18 17 Z" />
    <rect x="9" y="8" width="5" height="4" />
    <path d="M14 10 H22" />
  </Glyph>
);

/** Тесла: корпус с мачтой, наверху катушка и разряд. */
const TeslaGlyph = () => (
  <Glyph>
    <path d="M5 18 L7 14 H17 L19 18 Z" />
    <path d="M12 14 V8" />
    <circle cx="12" cy="6" r="2.4" />
    <path d="M12 2 L10 5 H14 L12 8" strokeWidth={1.2} />
  </Glyph>
);

/** Стена: глухой блок со швом. Ни ствола, ни мачты — она не стреляет. */
const WallGlyph = () => (
  <Glyph>
    <rect x="3" y="7" width="18" height="11" />
    <path d="M3 12.5 H21" />
    <path d="M9 7 V12.5" />
    <path d="M15 12.5 V18" />
  </Glyph>
);

/** Башня: широкое основание, сужающийся ствол, короткое орудие сверху. */
const TowerGlyph = () => (
  <Glyph>
    <path d="M5 20 H19" />
    <path d="M8 20 L9.5 9 H14.5 L16 20 Z" />
    <rect x="9" y="5" width="6" height="4" />
    <path d="M15 7 H19" />
  </Glyph>
);

/** Снайперская башня: та же башня, но выше и с длинным стволом. */
const TowerSniperGlyph = () => (
  <Glyph>
    <path d="M5 21 H19" />
    <path d="M9 21 L10.5 7 H13.5 L15 21 Z" />
    <rect x="9.5" y="4" width="5" height="3" />
    <path d="M14.5 5.5 H22" />
    <path d="M9.5 5.5 H6" strokeWidth={1.2} />
  </Glyph>
);

/**
 * Генерал: винтокрылая машина на боковых хуверах.
 *
 * Признак тот же, по которому он узнаётся на поле среди сотни машин, —
 * он в воздухе. Отсюда и хуверы по бокам, и отсутствие гусеничного низа.
 */
export const GeneralGlyph = () => (
  <Glyph>
    <path d="M6 12 H16 L19 14 H8 Z" />
    <path d="M16 12 L20 9" />
    <path d="M18 8 H22" />
    <circle cx="5" cy="15" r="2" />
    <circle cx="18" cy="16.5" r="2" />
    <path d="M8 9 H14" strokeWidth={1.2} />
  </Glyph>
);

/**
 * База: широкое основание, объёмы разной высоты, мачта.
 *
 * Силуэт узнаётся тем же, чем на поле: она единственная, что стоит
 * на площадке три на три и несёт антенну.
 */
export const BaseGlyph = () => (
  <Glyph>
    <path d="M2 19 H22" />
    <path d="M5 19 V12 H13 V19" />
    <path d="M13 19 V15 H19 V19" />
    <path d="M9 12 V5" />
    <path d="M6 4 L12 6 L6 8 Z" />
  </Glyph>
);

/**
 * Цель атаки: перекрестие с кольцом.
 *
 * Тот же знак, которым цель отмечена на поле, — окружность
 * с перекрестием. Пиктограмма, не совпадающая с меткой на карте,
 * заставляла бы игрока запоминать два обозначения одного.
 */
export const TargetGlyph = () => (
  <Glyph>
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2 V7" />
    <path d="M12 17 V22" />
    <path d="M2 12 H7" />
    <path d="M17 12 H22" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </Glyph>
);

export const UNIT_GLYPH: Readonly<Record<UnitType, () => ReactNode>> = {
  [UnitType.Assault]: AssaultGlyph,
  [UnitType.Sniper]: SniperGlyph,
  [UnitType.Tesla]: TeslaGlyph,
};

export const STRUCTURE_GLYPH: Readonly<Record<StructureKind, () => ReactNode>> = {
  // У базы пиктограммы нет и не нужно: она показывается полосой прочности,
  // а не числом в ряду «сколько чего построено».
  [StructureKind.Base]: WallGlyph,
  [StructureKind.Wall]: WallGlyph,
  [StructureKind.TowerBasic]: TowerGlyph,
  [StructureKind.TowerSniper]: TowerSniperGlyph,
};

// ─────────────────────────────────────────────────────────────────────────
// Отрисованные объекты вместо контуров
// ─────────────────────────────────────────────────────────────────────────

/**
 * Значок объекта: отрисованная машина, а пока её нет — прежний контур.
 *
 * Плитка заказа отвечает на вопрос «та ли это машина», и контур на него
 * не отвечает: игрок сопоставляет рисунок с машиной на поле сам,
 * а ошибается не в названии, а в заказе. Поэтому здесь стоит тот же
 * объект, что и на поле, — отрисованный тем же кодом и с того же ракурса
 * (см. `game/icon-sprites.ts`).
 *
 * Контур при этом никуда не девается и мёртвым грузом не лежит. Иконки
 * печатаются по одной за кадр и уже ПОСЛЕ рельефа, чтобы не удлинять
 * начало матча, — и всё это время плитка обязана что-то показывать.
 * Показывает она контур.
 *
 * Подписка идёт на СТРОКУ иконки, а не на карту целиком: строку zustand
 * сравнивает по значению, и появление соседней иконки этот значок
 * не перерисовывает.
 *
 * Размер задаёт родитель — и это то же правило, что у контуров:
 * `width`/`height` в сто процентов, а сколько это точек, решает CSS.
 * Иначе размер иконки нельзя было бы поменять медиазапросом.
 */
const ObjectIcon = ({
  iconKey,
  fallback: Fallback,
}: {
  readonly iconKey: string;
  readonly fallback: () => ReactNode;
}) => {
  const src = useHudStore((state) => state.icons[iconKey]);

  if (src === undefined) return <Fallback />;

  return (
    <img
      src={src}
      alt=""
      aria-hidden
      // `contain` обязателен: у машин и башен разные пропорции, и растянуть
      // снайпера по клетке башни значило бы соврать про его силуэт —
      // а силуэтом они и различаются.
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    />
  );
};

/**
 * Сторона у значка обязательна там, где показывают ЧУЖОЙ состав.
 *
 * Машина покрашена в графит, и сторону на ней несут маркеры да подсветка
 * по краю. Поставь в сводку соперника свой значок — и чужие восемь Тесл
 * оказались бы помечены своим цветом: на поле, где цвет означает
 * принадлежность, это худшая из возможных ошибок.
 *
 * Своя сторона стоит умолчанием: заказывает игрок только своё, и плитки
 * с окном прокачки о существовании второй стороны не знают.
 */
export const UnitIcon = ({
  type,
  side = SIDE_SELF,
}: {
  readonly type: UnitType;
  readonly side?: number;
}) => <ObjectIcon iconKey={unitIconKey(type, side)} fallback={UNIT_GLYPH[type]} />;

export const StructureIcon = ({
  kind,
  side = SIDE_SELF,
}: {
  readonly kind: StructureKind;
  readonly side?: number;
}) => <ObjectIcon iconKey={structureIconKey(kind, side)} fallback={STRUCTURE_GLYPH[kind]} />;

export const GeneralIcon = ({ side = SIDE_SELF }: { readonly side?: number }) => (
  <ObjectIcon iconKey={generalIconKey(side)} fallback={GeneralGlyph} />
);
