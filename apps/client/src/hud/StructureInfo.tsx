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

/** Склонение «убийство» — иначе строка читается машинной. */
const kills = (count: number): string => {
  const tail = count % 100;
  const last = count % 10;

  if (tail >= 11 && tail <= 14) return `${String(count)} убийств`;
  if (last === 1) return `${String(count)} убийство`;
  if (last >= 2 && last <= 4) return `${String(count)} убийства`;

  return `${String(count)} убийств`;
};

/**
 * Строка ранга: номер, набранные убийства и ход к следующему рангу.
 *
 * У высшего ранга следующего не обещаем — обещание, которое не сбудется,
 * хуже его отсутствия.
 */
const rankText = (selection: {
  readonly rank: number;
  readonly kills: number;
  readonly killsToNextRank: number;
}): string => {
  const earned = `${String(selection.rank)} · ${kills(selection.kills)}`;

  if (selection.killsToNextRank <= 0) {
    return selection.rank === 0 ? earned : `${earned} · высший`;
  }

  return `${earned} · до следующего ${String(selection.killsToNextRank)}`;
};

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

      {/* Ветеранский ранг — заметная механика: башня растёт убийствами
          и вместе с ними гибнет. Без этого игрок не знает, какую из своих
          башен стоит защищать.

          Показываем не только номер ранга. Пороги неравномерны (1, 3, 6,
          10, 15), и одного номера мало: «второй ранг» не отвечает
          на вопрос, стоит ли держаться за башню, которой до звезды
          осталось одно убийство. */}
      {selection.ranked ? <Row label="Ранг" value={rankText(selection)} /> : null}

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
