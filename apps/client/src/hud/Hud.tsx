import type { ReactNode } from 'react';
import { Panel } from '@td/ui';
import { useHudStore } from '../game/store.js';
import type { ConnectionStatus } from '../game/store.js';

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
 * Игровое поле в рендере React не участвует вообще.
 */
export const Hud = () => (
  <div id="hud" data-testid="hud">
    <div
      style={{
        position: 'absolute',
        top: 'var(--td-space-4)',
        left: 'var(--td-space-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--td-space-3)',
        width: 220,
      }}
    >
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
      </Panel>

      <Panel title="Управление">
        <Hint>Перетаскивание мышью — прокрутка</Hint>
        <Hint>Стрелки — прокрутка</Hint>
        <Hint>R — новая карта</Hint>
      </Panel>
    </div>
  </div>
);

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

const Hint = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontSize: 'var(--td-text-sm)',
      lineHeight: 1.7,
      color: 'var(--td-text-muted-3)',
    }}
  >
    {children}
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
