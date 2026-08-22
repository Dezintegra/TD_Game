import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import {
  BUILDABLE_KINDS,
  STRUCTURE_UPGRADE_TARGET,
  StructureKind,
  UNIT_TYPES,
  UNIT_UPGRADE_TARGET,
  UPGRADE_BRANCHES,
  UnitType,
  UpgradeTarget,
} from '@td/shared';
import { BATCH_ORDER_COUNT } from '../game/controls.js';
import { matchCommands, useHudStore } from '../game/store.js';
import type { StatRow } from '../game/store.js';
import { BaseGlyph, GeneralGlyph, STRUCTURE_GLYPH, UNIT_GLYPH } from './icons.js';
import { STRUCTURE_SHORT, UNIT_SHORT, UPGRADE_STAT_SHORT, UPGRADE_UNIT } from './labels.js';

/**
 * Нижний тулбар: всё, чем игрок распоряжается, и вся прокачка.
 *
 * Прокачка живёт здесь, а не отдельной панелью, и это главное решение
 * изменения. Прежняя панель перечисляла двадцать девять веток строкой
 * «Атака — ур. 7 — 96» в другом углу экрана. Ни на один вопрос игрока она
 * не отвечала: что такое седьмой уровень атаки, он не знает, а решение
 * «докупить Тесле дальность» принимается там, где видно саму Теслу.
 *
 * Поэтому под каждой плиткой стоит столбец с ДЕЙСТВУЮЩИМИ значениями,
 * и стрелка покупки — прямо у той характеристики, которую она поднимает.
 *
 * Плиток две группы. Слева заказываемое: юниты, постройки, ядерный удар.
 * Справа свои объекты: генерал и база. Разделять их обязательно —
 * нажатие по базе ничего не заказывает, и без границы это читалось бы
 * поломкой.
 *
 * Никакой игровой логики здесь нет: компонент читает готовый снимок
 * из store и вызывает команду. Решение, можно ли построить башню
 * в этой клетке, принимает ядро симуляции, а не кнопка.
 */

const barStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--td-space-3)',
  alignItems: 'flex-start',
};

/**
 * Промежутки здесь мельче обычных, и это вынужденно: плиток девять,
 * и каждая лишняя четвёрка точек между ними умножается на восемь.
 * На ноутбуке шириной 1366 запаса нет.
 */
const groupStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--td-space-1)',
  alignItems: 'flex-start',
};

/** Граница между заказываемым и своими объектами. */
const dividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  background: 'var(--td-border-divider)',
  margin: '0 var(--td-space-1)',
};

const tileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 2,
  minWidth: 96,
  padding: 'var(--td-space-1)',
  border: '1px solid var(--td-border-control)',
  borderRadius: 'var(--td-radius-control)',
  background: 'var(--td-bg-input)',
  color: 'var(--td-text-secondary)',
  fontFamily: 'var(--td-font-ui)',
  fontSize: 'var(--td-text-sm)',
};

const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--td-space-2)',
  width: '100%',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

const nameStyle: CSSProperties = {
  fontWeight: 600,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const monoStyle: CSSProperties = {
  fontFamily: 'var(--td-font-mono)',
  color: 'var(--td-text-muted-2)',
};

const hotkeyStyle: CSSProperties = {
  color: 'var(--td-text-muted-4)',
  fontSize: 11,
  marginLeft: 'auto',
};

interface TileProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly hotkey: string;
  /** Цена заказа. Ноль означает, что плитка ничего не заказывает. */
  readonly cost: number;
  readonly affordable: boolean;
  readonly active?: boolean;
  /** Цель прокачки, чьи характеристики показывать. Нет — столбца нет. */
  readonly target?: UpgradeTarget | undefined;
  readonly testId: string;
  readonly onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}

const Tile = ({
  icon,
  label,
  hotkey,
  cost,
  affordable,
  active,
  target,
  testId,
  onSelect,
}: TileProps) => {
  const statsOpen = useHudStore((state) => state.statsOpen);

  return (
    <div
      data-testid={testId}
      style={{
        ...tileStyle,
        borderColor: active === true ? 'var(--td-accent)' : 'var(--td-border-control)',
        boxShadow: active === true ? 'var(--td-glow-accent)' : 'none',
      }}
    >
      <button
        type="button"
        data-testid={`${testId}-select`}
        onClick={onSelect}
        style={{
          ...headStyle,
          // Недоступное по цене приглушается, но кликается: ядро само
          // отклонит команду, а серая плитка сообщает «дорого», не мешая
          // нажать заранее.
          opacity: affordable ? 1 : 0.45,
        }}
      >
        <span
          style={{
            width: 22,
            height: 20,
            flexShrink: 0,
            color: active === true ? 'var(--td-accent)' : 'var(--td-player-self)',
          }}
        >
          {icon}
        </span>
        <span style={{ ...nameStyle, color: active === true ? 'var(--td-accent)' : undefined }}>
          {label}
        </span>
        <span style={hotkeyStyle}>{hotkey}</span>
      </button>

      {cost > 0 && (
        <span style={{ ...monoStyle, fontSize: 11 }} data-testid={`${testId}-cost`}>
          цена {cost}
        </span>
      )}

      {statsOpen && target !== undefined && <StatColumn target={target} />}
    </div>
  );
};

/**
 * Столбец характеристик одной цели прокачки.
 *
 * Подписан на ЧИСЛО строк, а не на сам список. Список пересобирается
 * при каждом снимке матча — то есть пять раз в секунду, — и подписка
 * на него означала бы перерисовку столбца пять раз в секунду просто так:
 * содержимое-то не менялось.
 */
const StatColumn = ({ target }: { readonly target: UpgradeTarget }) => {
  const count = useHudStore((state) => state.match.stats[target]?.length ?? 0);

  if (count === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2 }}>
      {Array.from({ length: count }, (_, index) => (
        <StatLine key={index} target={target} index={index} />
      ))}
    </div>
  );
};

const lineStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  alignItems: 'center',
  gap: 'var(--td-space-1)',
  fontSize: 11,
  lineHeight: 1.5,
};

const arrowStyle = (affordable: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: '0 3px',
  border: `1px solid ${affordable ? 'var(--td-accent)' : 'var(--td-border-control)'}`,
  borderRadius: 2,
  background: 'transparent',
  // Недоступная стрелка приглушается, но не прячется: игрок должен видеть,
  // что копить есть на что.
  color: affordable ? 'var(--td-accent)' : 'var(--td-text-muted-4)',
  fontFamily: 'var(--td-font-mono)',
  fontSize: 10,
  lineHeight: 1.4,
  cursor: 'pointer',
});

/**
 * Одна характеристика: название, действующее значение и стрелка покупки.
 *
 * Подписки здесь на ЧИСЛА и признаки, а не на строку целиком, и это
 * не педантизм. Снимок матча пересобирается пять раз в секунду, и объект
 * строки каждый раз новый; подписка на него означала бы, что все тридцать
 * строк тулбара перерисовываются пять раз в секунду, хотя меняются они
 * только при покупке. Примитивы zustand сравнивает по значению, и лишней
 * перерисовки не происходит вовсе.
 */
const StatLine = ({
  target,
  index,
}: {
  readonly target: UpgradeTarget;
  readonly index: number;
}) => {
  const at = (state: { readonly match: { readonly stats: readonly (readonly StatRow[])[] } }) =>
    state.match.stats[target]?.[index];

  const branch = useHudStore((state) => at(state)?.branch ?? -1);
  const value = useHudStore((state) => at(state)?.value ?? 0);
  const fraction = useHudStore((state) => at(state)?.fraction ?? 0);
  const cost = useHudStore((state) => at(state)?.cost ?? 0);
  const affordable = useHudStore((state) => at(state)?.affordable ?? false);

  const description = UPGRADE_BRANCHES[branch];
  if (branch < 0 || description === undefined) return null;

  const row = { branch, value, fraction, cost, affordable };

  return (
    <div style={lineStyle} data-testid={`stat-${String(branch)}`}>
      <span
        title={description.label}
        style={{ color: 'var(--td-text-muted-3)', whiteSpace: 'nowrap' }}
      >
        {UPGRADE_STAT_SHORT[description.stat]}
      </span>
      <span
        data-testid={`stat-value-${String(branch)}`}
        style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-text-primary)' }}
      >
        {row.value.toFixed(row.fraction)}
        {UPGRADE_UNIT[description.stat]}
      </span>
      <button
        type="button"
        data-testid={`upgrade-${String(branch)}`}
        title={`Улучшить за ${String(row.cost)}`}
        onClick={() => matchCommands().buyUpgrade(branch)}
        style={arrowStyle(row.affordable)}
      >
        <span aria-hidden>▲</span>
        {row.cost}
      </button>
    </div>
  );
};

const UNIT_HOTKEY: Readonly<Record<UnitType, string>> = {
  [UnitType.Assault]: '1',
  [UnitType.Sniper]: '2',
  [UnitType.Tesla]: '3',
};

/** В режиме строительства цифры выбирают постройку — те же три. */
const STRUCTURE_HOTKEY: Readonly<Record<StructureKind, string>> = {
  [StructureKind.Base]: '',
  [StructureKind.Wall]: 'Q 1',
  [StructureKind.TowerBasic]: 'Q 2',
  [StructureKind.TowerSniper]: 'Q 3',
};

export const ActionBar = () => {
  const match = useHudStore((state) => state.match);

  return (
    <div style={barStyle} data-testid="toolbar">
      <div style={groupStyle} data-testid="production-panel">
        {UNIT_TYPES.map((type) => {
          const Icon = UNIT_GLYPH[type];
          const cost = match.unitCosts[type] ?? 0;

          return (
            <Tile
              key={`unit-${String(type)}`}
              testId={`train-${String(type)}`}
              icon={<Icon />}
              label={UNIT_SHORT[type]}
              hotkey={UNIT_HOTKEY[type]}
              cost={cost}
              affordable={match.energy >= cost}
              target={UNIT_UPGRADE_TARGET[type]}
              // Ctrl или Shift — заказ пачки. Ядро проверит каждый заказ
              // отдельно, поэтому «десять, когда хватает на четыре»
              // превращается в четыре.
              onSelect={(event) =>
                matchCommands().train(type, event.ctrlKey || event.shiftKey ? BATCH_ORDER_COUNT : 1)
              }
            />
          );
        })}
      </div>

      <div style={groupStyle} data-testid="build-panel">
        {BUILDABLE_KINDS.map((kind) => {
          const Icon = STRUCTURE_GLYPH[kind];
          const cost = match.structureCosts[kind] ?? 0;

          return (
            <Tile
              key={`structure-${String(kind)}`}
              testId={`build-${String(kind)}`}
              icon={<Icon />}
              label={STRUCTURE_SHORT[kind]}
              hotkey={STRUCTURE_HOTKEY[kind]}
              cost={cost}
              affordable={match.energy >= cost}
              active={match.buildKind === kind}
              target={STRUCTURE_UPGRADE_TARGET[kind]}
              onSelect={() => matchCommands().setBuildKind(match.buildKind === kind ? null : kind)}
            />
          );
        })}

        {/* У ядерного удара веток прокачки нет, поэтому и столбца нет. */}
        <Tile
          testId="aim-nuke"
          icon={<span style={{ fontSize: 16, lineHeight: 1 }}>☢</span>}
          label="Ядерка"
          hotkey="F"
          cost={match.nukeCost}
          affordable={match.energy >= match.nukeCost}
          active={match.aimingNuke}
          onSelect={() => matchCommands().toggleNukeAim()}
        />
      </div>

      <span style={dividerStyle} data-testid="toolbar-divider" />

      <div style={groupStyle} data-testid="own-panel">
        <Tile
          testId="focus-general"
          icon={<GeneralGlyph />}
          label="Генерал"
          hotkey="Пробел"
          cost={0}
          affordable
          target={UpgradeTarget.General}
          onSelect={() => matchCommands().focusOwn('general')}
        />

        <Tile
          testId="focus-base"
          icon={<BaseGlyph />}
          label="База"
          hotkey=""
          cost={0}
          affordable
          target={UpgradeTarget.Base}
          onSelect={() => matchCommands().focusOwn('base')}
        />
      </div>
    </div>
  );
};
