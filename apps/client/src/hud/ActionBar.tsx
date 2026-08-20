import type { CSSProperties, MouseEvent } from 'react';
import { Panel } from '@td/ui';
import { BUILDABLE_KINDS, RejectReason, StructureKind, UNIT_TYPES, UnitType } from '@td/shared';
import { BATCH_ORDER_COUNT } from '../game/controls.js';
import { matchCommands, useHudStore } from '../game/store.js';
import { Nudge } from './Notices.js';
import { STRUCTURE_SHORT, UNIT_SHORT } from './labels.js';

/**
 * Панель действий: производство, строительство, ядерный удар.
 *
 * Кнопки дублируют горячие клавиши, а не заменяют их. В реальном матче
 * играть будут с клавиатуры — рука не успевает возвращаться к панели, —
 * но кнопка показывает цену и доступность, а клавиша нет.
 *
 * Никакой игровой логики здесь нет: компонент читает готовый снимок
 * из store и вызывает команду. Решение о том, можно ли построить башню
 * в этой клетке, принимает ядро симуляции, а не кнопка.
 */

const barStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'var(--td-space-4)',
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 'var(--td-space-3)',
  alignItems: 'flex-end',
};

const groupStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--td-space-2)',
};

const tileBase: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  minWidth: 88,
  padding: 'var(--td-space-2)',
  border: '1px solid var(--td-border-control)',
  borderRadius: 'var(--td-radius-control)',
  background: 'var(--td-bg-input)',
  color: 'var(--td-text-secondary)',
  fontFamily: 'var(--td-font-ui)',
  fontSize: 'var(--td-text-sm)',
  cursor: 'pointer',
};

interface TileProps {
  readonly label: string;
  readonly hotkey: string;
  readonly cost: number;
  readonly affordable: boolean;
  readonly active?: boolean;
  readonly testId?: string;
  readonly onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}

const Tile = ({ label, hotkey, cost, affordable, active, testId, onSelect }: TileProps) => (
  <button
    type="button"
    data-testid={testId}
    onClick={onSelect}
    style={{
      ...tileBase,
      borderColor: active === true ? 'var(--td-accent)' : 'var(--td-border-control)',
      boxShadow: active === true ? 'var(--td-glow-accent)' : 'none',
      // Недоступное по цене приглушается, но кликается: ядро само
      // отклонит команду, а серая кнопка сообщает «дорого», не мешая
      // нажать заранее.
      opacity: affordable ? 1 : 0.45,
    }}
  >
    <span style={{ fontWeight: 600, color: active === true ? 'var(--td-accent)' : undefined }}>
      {label}
    </span>
    <span style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-text-muted-2)' }}>
      {cost}
    </span>
    <span style={{ color: 'var(--td-text-muted-4)', fontSize: 11 }}>{hotkey}</span>
  </button>
);

const UNIT_HOTKEY: Readonly<Record<UnitType, string>> = {
  [UnitType.Assault]: '1',
  [UnitType.Sniper]: '2',
  [UnitType.Grenadier]: '3',
};

const STRUCTURE_HOTKEY: Readonly<Record<StructureKind, string>> = {
  [StructureKind.Base]: '',
  [StructureKind.Wall]: 'Q',
  [StructureKind.TowerBasic]: 'E',
  [StructureKind.TowerSniper]: 'R',
};

export const ActionBar = () => {
  const match = useHudStore((state) => state.match);

  return (
    <div style={barStyle}>
      <Panel title="Производство" data-testid="production-panel">
        <div style={groupStyle}>
          {UNIT_TYPES.map((type) => (
            <Tile
              key={type}
              testId={`train-${String(type)}`}
              label={UNIT_SHORT[type]}
              hotkey={UNIT_HOTKEY[type]}
              cost={match.unitCosts[type] ?? 0}
              affordable={match.energy >= (match.unitCosts[type] ?? 0)}
              // Ctrl или Shift — заказ пачки. Ядро проверит каждый заказ
              // отдельно, поэтому «десять, когда хватает на четыре»
              // превращается в четыре.
              onSelect={(event) =>
                matchCommands().train(type, event.ctrlKey || event.shiftKey ? BATCH_ORDER_COUNT : 1)
              }
            />
          ))}
        </div>
        <Nudge reason={RejectReason.QueueFull}>
          <Queue queue={match.queue} />
        </Nudge>
      </Panel>

      <Panel title="Строительство" data-testid="build-panel">
        <div style={groupStyle}>
          {BUILDABLE_KINDS.map((kind) => (
            <Tile
              key={kind}
              testId={`build-${String(kind)}`}
              label={STRUCTURE_SHORT[kind]}
              hotkey={STRUCTURE_HOTKEY[kind]}
              cost={match.structureCosts[kind] ?? 0}
              affordable={match.energy >= (match.structureCosts[kind] ?? 0)}
              active={match.buildKind === kind}
              onSelect={() => matchCommands().setBuildKind(match.buildKind === kind ? null : kind)}
            />
          ))}

          <Tile
            testId="aim-nuke"
            label="Ядерка"
            hotkey="F"
            cost={match.nukeCost}
            affordable={match.energy >= match.nukeCost}
            active={match.aimingNuke}
            onSelect={() => matchCommands().toggleNukeAim()}
          />
        </div>
      </Panel>
    </div>
  );
};

/**
 * Очередь производства.
 *
 * Показывается точками, а не списком названий: в очереди до двадцати
 * заказов, и читать их построчно игрок всё равно не будет — ему нужно
 * знать, сколько ещё ждать и чего именно.
 */
const Queue = ({ queue }: { readonly queue: readonly number[] }) => (
  <div
    data-testid="production-queue"
    style={{
      display: 'flex',
      gap: 3,
      marginTop: 'var(--td-space-2)',
      minHeight: 10,
      alignItems: 'center',
    }}
  >
    {queue.length === 0 ? (
      <span style={{ color: 'var(--td-text-muted-4)', fontSize: 11 }}>очередь пуста</span>
    ) : (
      queue.map((type, index) => (
        <span
          key={`${String(index)}-${String(type)}`}
          title={UNIT_SHORT[type as UnitType]}
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            background: 'var(--td-accent)',
            // Первый в очереди производится прямо сейчас — он ярче.
            opacity: index === 0 ? 1 : 0.4,
          }}
        />
      ))
    )}
  </div>
);
