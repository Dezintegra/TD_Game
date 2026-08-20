import type { CSSProperties, ReactNode } from 'react';
import { Button, Panel } from '@td/ui';
import { matchCommands, useHudStore } from '../game/store.js';
import type { ConnectionStatus } from '../game/store.js';
import { ActionBar } from './ActionBar.js';
import { UpgradePanel } from './UpgradePanel.js';
import { HOTKEYS } from './labels.js';

const statusLabel: Record<ConnectionStatus, string> = {
  offline: 'нет связи',
  connecting: 'подключение',
  online: 'в сети',
};

const statusColor: Record<ConnectionStatus, string> = {
  offline: 'var(--td-error)',
  connecting: 'var(--td-warning)',
  online: 'var(--td-accent)',
};

/**
 * HUD — единственное место, где работает React.
 *
 * Каждое значение подписано на store отдельным селектором, поэтому
 * изменение частоты кадров перерисовывает одну строку, а не всю панель.
 * Игровое поле в рендере React не участвует вообще: его рисует PixiJS,
 * и даже миникарта живёт там же, чтобы не возить позиции сущностей
 * через store.
 */
export const Hud = () => (
  <div id="hud" data-testid="hud">
    <StatusColumn />
    <MatchBar />
    <ActionBar />
    <UpgradePanel />
    <ResultOverlay />
  </div>
);

const columnStyle: CSSProperties = {
  position: 'absolute',
  top: 'var(--td-space-4)',
  left: 'var(--td-space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--td-space-3)',
  width: 220,
};

const StatusColumn = () => (
  <div style={columnStyle}>
    <Panel title="Соединение">
      <ConnectionRow />
      <StatRow label="Тик" value={<TickValue />} />
      <StatRow label="Задержка" value={<LatencyValue />} />
      <StatRow label="Ответов" value={<PongValue />} />
      <StatRow label="Кадров/с" value={<FpsValue />} />
    </Panel>

    <Panel title="Карта">
      <StatRow label="Seed" value={<SeedValue />} />
      <StatRow label="Видно" value={<VisibleValue />} />
      <StatRow label="Скалы" value={<RockValue />} />
      <Button
        variant="ghost"
        data-testid="restart"
        onClick={() => matchCommands().restart()}
        style={{ width: '100%', marginTop: 'var(--td-space-2)', fontSize: 'var(--td-text-sm)' }}
      >
        Новый матч
      </Button>
    </Panel>

    <Panel title="Управление">
      {HOTKEYS.map((hint) => (
        <div
          key={hint.keys}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 'var(--td-space-2)',
            fontSize: 'var(--td-text-sm)',
            lineHeight: 1.6,
            color: 'var(--td-text-muted-3)',
          }}
        >
          <span style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-text-muted-1)' }}>
            {hint.keys}
          </span>
          <span style={{ textAlign: 'right' }}>{hint.what}</span>
        </div>
      ))}
    </Panel>
  </div>
);

/**
 * Верхняя полоса матча.
 *
 * Здесь только то, что игрок обязан видеть постоянно и не глядя:
 * сколько энергии, сколько прибывает, сколько войск, сколько идёт матч.
 * Всё остальное — по запросу.
 */
const MatchBar = () => {
  const match = useHudStore((state) => state.match);

  const minutes = Math.floor(match.matchSeconds / 60);
  const seconds = Math.floor(match.matchSeconds % 60);

  return (
    <div
      style={{
        position: 'absolute',
        top: 'var(--td-space-4)',
        left: '50%',
        transform: 'translateX(-50%)',
      }}
    >
      <Panel data-testid="match-bar">
        <div style={{ display: 'flex', gap: 'var(--td-space-6)', alignItems: 'baseline' }}>
          <Metric
            label="Энергия"
            value={<span data-testid="energy">{match.energy}</span>}
            hint={`+${String(match.incomePerSecond)} / с`}
            accent
          />
          <Metric
            label="Войска"
            value={<span data-testid="unit-count">{match.unitCount}</span>}
            hint={`из ${String(match.unitCap)}`}
          />
          <Metric label="Цель" value={<span data-testid="target">{match.targetLabel}</span>} />
          <Metric
            label="Генерал"
            value={
              <span data-testid="general-state">
                {match.generalAlive ? 'в строю' : `${String(match.respawnInSeconds)} с`}
              </span>
            }
          />
          <Metric label="Время" value={`${String(minutes)}:${String(seconds).padStart(2, '0')}`} />
        </div>
      </Panel>
    </div>
  );
};

interface MetricProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
  readonly accent?: boolean;
}

const Metric = ({ label, value, hint, accent }: MetricProps) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 74 }}>
    <span
      style={{
        color: 'var(--td-text-muted-3)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 'var(--td-ls-label)',
      }}
    >
      {label}
    </span>
    <span
      style={{
        fontFamily: 'var(--td-font-mono)',
        fontSize: 'var(--td-text-lg)',
        color: accent === true ? 'var(--td-accent)' : 'var(--td-text-primary)',
      }}
    >
      {value}
    </span>
    {hint !== undefined && (
      <span style={{ color: 'var(--td-text-muted-4)', fontSize: 11 }}>{hint}</span>
    )}
  </div>
);

/**
 * Итог матча.
 *
 * Перекрывает поле целиком: матч закончен, и продолжать смотреть на него
 * незачем. Единственное действие — начать заново.
 */
const ResultOverlay = () => {
  const winner = useHudStore((state) => state.match.winner);

  if (winner === null) return null;

  const victory = winner === 0;

  return (
    <div
      data-testid="result-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--td-space-4)',
        background: 'var(--td-bg-overlay)',
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          letterSpacing: 'var(--td-ls-button)',
          color: victory ? 'var(--td-accent)' : 'var(--td-error)',
          textShadow: victory ? 'var(--td-glow-accent)' : 'none',
        }}
      >
        {victory ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'}
      </div>
      <div style={{ color: 'var(--td-text-muted-2)' }}>
        {victory ? 'База противника разрушена' : 'Ваша база разрушена'}
      </div>
      <Button data-testid="restart-overlay" onClick={() => matchCommands().restart()}>
        Новый матч
      </Button>
    </div>
  );
};

const ConnectionRow = () => {
  const status = useHudStore((state) => state.status);

  return (
    <div
      data-testid="connection-status"
      data-status={status}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--td-space-2)',
        marginBottom: 'var(--td-space-2)',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: statusColor[status],
          boxShadow: status === 'online' ? 'var(--td-glow-accent)' : 'none',
        }}
      />
      <span style={{ color: statusColor[status], fontWeight: 600 }}>{statusLabel[status]}</span>
    </div>
  );
};

const StatRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 'var(--td-space-4)',
      fontSize: 'var(--td-text-sm)',
      lineHeight: 1.7,
    }}
  >
    <span style={{ color: 'var(--td-text-muted-3)' }}>{label}</span>
    <span style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-text-secondary)' }}>
      {value}
    </span>
  </div>
);

const TickValue = () => <>{useHudStore((state) => state.tick)}</>;
const LatencyValue = () => <>{useHudStore((state) => state.latencyMs)} мс</>;
const PongValue = () => (
  <span data-testid="pong-count">{useHudStore((state) => state.pongCount)}</span>
);
const FpsValue = () => <span data-testid="fps">{useHudStore((state) => state.fps)}</span>;
const SeedValue = () => <span data-testid="seed">{useHudStore((state) => state.seed)}</span>;
const VisibleValue = () => (
  <span data-testid="visible-percent">
    {useHudStore((state) => state.visiblePercent).toFixed(1)} %
  </span>
);
const RockValue = () => <>{useHudStore((state) => state.rockPercent).toFixed(1)} %</>;
