import type { CSSProperties } from 'react';
import { matchCommands, useHudStore } from '../game/store.js';

/**
 * Окно сведений о выделенной постройке.
 *
 * Показывает то, что уже есть в состоянии мира, и ничего сверх.
 * Все величины приезжают из игрового цикла готовыми: React ничего
 * не считает и в мир не заглядывает — это правило проекта, а не вкус.
 *
 * Чужие постройки показываются наравне со своими. Тумана войны в игре
 * нет намеренно, уровни соперника видны обоим, и прятать здесь нечего.
 *
 * Кнопка сноса при невозможности показывается недоступной с причиной,
 * а не прячется. Спрятанная кнопка оставляет игрока гадать, а причина
 * ему что-то говорит: «далеко от генерала» — подойди, «генерал
 * уничтожен» — подожди.
 */

const panelStyle: CSSProperties = {
  position: 'absolute',
  right: 'var(--td-space-4)',
  bottom: 'var(--td-space-4)',
  width: 240,
  padding: 'var(--td-space-3)',
  border: '1px solid var(--td-border)',
  borderRadius: 'var(--td-radius-panel)',
  background: 'var(--td-bg-panel)',
  color: 'var(--td-text)',
  fontSize: 'var(--td-text-sm)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--td-space-2)',
  pointerEvents: 'auto',
};

const titleStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 'var(--td-space-2)',
  color: 'var(--td-accent)',
  fontSize: 'var(--td-text-md)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 'var(--td-space-2)',
};

const barStyle: CSSProperties = {
  height: 6,
  borderRadius: 'var(--td-radius-control)',
  background: 'var(--td-bg-overlay)',
  overflow: 'hidden',
};

const buttonStyle: CSSProperties = {
  padding: 'var(--td-space-1) var(--td-space-2)',
  border: '1px solid var(--td-error)',
  borderRadius: 'var(--td-radius-control)',
  background: 'transparent',
  color: 'var(--td-error)',
  cursor: 'pointer',
  font: 'inherit',
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: 'var(--td-border)',
  color: 'var(--td-text-muted)',
  cursor: 'not-allowed',
};

const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={rowStyle}>
    <span style={{ color: 'var(--td-text-muted)' }}>{label}</span>
    <span>{value}</span>
  </div>
);

const seconds = (value: number): string => `${value.toFixed(1)} с`;

export const StructureInfo = () => {
  const selection = useHudStore((state) => state.selection);

  if (selection === null) return null;

  const share = selection.maxHealth <= 0 ? 0 : selection.health / selection.maxHealth;

  return (
    <div style={panelStyle} data-testid="structure-info">
      <div style={titleStyle}>
        <span>{selection.label}</span>
        <span style={{ color: 'var(--td-text-muted)', fontSize: 'var(--td-text-sm)' }}>
          {selection.own ? 'своя' : 'чужая'}
        </span>
      </div>

      <div style={barStyle}>
        <div
          style={{
            width: `${String(Math.round(share * 100))}%`,
            height: '100%',
            background: share > 0.5 ? 'var(--td-accent)' : 'var(--td-error)',
          }}
        />
      </div>

      <Row
        label="Прочность"
        value={`${String(Math.round(selection.health))} / ${String(Math.round(selection.maxHealth))}`}
      />

      {selection.attack > 0 ? (
        <>
          <Row label="Урон" value={String(Math.round(selection.attack))} />
          <Row label="Дальность" value={`${String(selection.rangeCells)} кл.`} />
        </>
      ) : null}

      {/* Личный рост — заметная механика: башня растёт убийствами и вместе
          с ними гибнет. Без этого числа игрок не знает, какую из своих
          башен стоит защищать. */}
      {selection.growthPercent > 0 ? (
        <Row label="Рост за убийства" value={`+${String(selection.growthPercent)}%`} />
      ) : null}

      {selection.buildingSeconds > 0 ? (
        <Row label="Возводится" value={seconds(selection.buildingSeconds)} />
      ) : null}

      {selection.demolishSeconds > 0 ? (
        <Row label="Сносится" value={seconds(selection.demolishSeconds)} />
      ) : null}

      {selection.own ? (
        <button
          type="button"
          style={selection.canDemolish ? buttonStyle : disabledButtonStyle}
          disabled={!selection.canDemolish}
          title={selection.demolishBlocked}
          data-testid="demolish"
          onClick={() => {
            matchCommands().demolish(selection.cell);
          }}
        >
          {selection.demolishSeconds > 0 ? 'Сносится…' : 'Снести'}
        </button>
      ) : null}

      {selection.own && !selection.canDemolish && selection.demolishBlocked !== '' ? (
        <span style={{ color: 'var(--td-text-muted)' }}>{selection.demolishBlocked}</span>
      ) : null}
    </div>
  );
};
