import type { CSSProperties, ReactNode } from 'react';
import { useSessionStore } from '../session/session-store.js';

/**
 * Общая оболочка экранов меню.
 *
 * Меню — единственное место, где React отвечает за всё, что видно:
 * игрового поля здесь ещё нет. Поэтому обычная вёрстка по центру,
 * без оверлеев и слоёв, которыми живёт HUD.
 */
const layoutStyle: CSSProperties = {
  width: '100%',
  maxWidth: 620,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--td-space-4)',
};

export interface MenuShellProps {
  readonly children: ReactNode;
}

export const MenuShell = ({ children }: MenuShellProps) => (
  <div id="menu" data-testid="menu">
    <div style={layoutStyle}>
      <Brand />
      {children}
    </div>
  </div>
);

const Brand = () => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--td-space-3)' }}>
    <div
      style={{
        fontSize: 30,
        fontWeight: 700,
        letterSpacing: 'var(--td-ls-button)',
        textTransform: 'uppercase',
      }}
    >
      TD{' '}
      <span style={{ color: 'var(--td-accent)', textShadow: 'var(--td-glow-accent)' }}>Game</span>
    </div>
    <div style={{ color: 'var(--td-text-muted-3)', fontSize: 'var(--td-text-sm)' }}>
      башенная оборона на двоих
    </div>
  </div>
);

/**
 * Состояние связи с сервером комнат.
 *
 * Показывается на экранах, где от связи что-то зависит. На экране
 * представления её нет: там связь ещё не нужна, и красная точка
 * пугала бы игрока ровно в тот момент, когда он решает, играть ли вообще.
 */
export const LinkState = () => {
  const connected = useSessionStore((state) => state.connected);

  return (
    <div
      data-testid="link-state"
      data-connected={connected ? 'yes' : 'no'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--td-space-2)',
        fontSize: 'var(--td-text-sm)',
        color: connected ? 'var(--td-accent)' : 'var(--td-warning)',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: 'currentColor',
          boxShadow: connected ? 'var(--td-glow-accent)' : 'none',
        }}
      />
      {connected ? 'сервер на связи' : 'связи нет, пробуем'}
    </div>
  );
};

/** Строка «вы вошли как ...» с возможностью сменить профиль. */
export const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--td-space-3)',
};
