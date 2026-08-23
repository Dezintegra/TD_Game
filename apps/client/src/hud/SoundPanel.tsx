import type { CSSProperties } from 'react';
import { Panel } from '@td/ui';
import { soundCommands, useHudStore } from '../game/store.js';
import type { SoundSettings } from '../audio/settings.js';

/**
 * Громкость: выключатель и три ползунка.
 *
 * Три, а не один, и это не избыточность. Музыка и бой мешают по-разному:
 * бой несёт сведения о поле — где стреляют, кто стреляет, что рушится, —
 * а музыка не несёт ничего. Игрок, которому музыка надоела на третьем
 * матче, не должен ради неё отключать то, что заменяет ему взгляд
 * за край экрана.
 *
 * Никакой игровой логики здесь нет: компонент читает состояние из store
 * и отдаёт новое через обратный канал. Применяет его игровой цикл,
 * он же сохраняет.
 */
export const SoundPanel = () => {
  const sound = useHudStore((state) => state.sound);

  const update = (patch: Partial<SoundSettings>): void => {
    soundCommands().apply({ ...sound, ...patch });
  };

  return (
    <Panel title="Звук" data-testid="sound-panel">
      <button
        type="button"
        data-testid="sound-toggle"
        data-enabled={String(sound.enabled)}
        onClick={() => update({ enabled: !sound.enabled })}
        style={toggleStyle(sound.enabled)}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: sound.enabled ? 'var(--td-accent)' : 'var(--td-text-muted-4)',
            boxShadow: sound.enabled ? 'var(--td-glow-accent)' : 'none',
          }}
        />
        {sound.enabled ? 'Включён' : 'Выключен'}
        <span style={{ marginLeft: 'auto', color: 'var(--td-text-muted-4)' }}>M</span>
      </button>

      <Slider
        label="Общая"
        testId="sound-master"
        value={sound.master}
        onChange={(master) => update({ master })}
      />
      <Slider
        label="Бой"
        testId="sound-battle"
        value={sound.battle}
        onChange={(battle) => update({ battle })}
      />
      <Slider
        label="Музыка"
        testId="sound-music"
        value={sound.music}
        onChange={(music) => update({ music })}
      />
    </Panel>
  );
};

const toggleStyle = (enabled: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--td-space-2)',
  width: '100%',
  marginBottom: 'var(--td-space-2)',
  padding: 'var(--td-space-1) var(--td-space-2)',
  background: 'transparent',
  border: `1px solid ${enabled ? 'var(--td-border-strong)' : 'var(--td-border-subtle)'}`,
  borderRadius: 'var(--td-radius-control)',
  color: enabled ? 'var(--td-text-primary)' : 'var(--td-text-muted-3)',
  fontFamily: 'var(--td-font-ui)',
  fontSize: 'var(--td-text-sm)',
  cursor: 'pointer',
});

interface SliderProps {
  readonly label: string;
  readonly testId: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}

/**
 * Ползунок.
 *
 * Собственного ползунка в `@td/ui` нет, и заводить его ради одной панели
 * рано: он появится тогда, когда понадобится второму месту. Пока хватает
 * штатного `input type=range`, покрашенного через `accent-color`
 * дизайн-токеном.
 */
const Slider = ({ label, testId, value, onChange }: SliderProps) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--td-space-2)',
      fontSize: 'var(--td-text-sm)',
      lineHeight: 1.7,
    }}
  >
    <span style={{ color: 'var(--td-text-muted-3)', minWidth: 54 }}>{label}</span>

    <input
      type="range"
      data-testid={testId}
      min={0}
      max={100}
      value={Math.round(value * 100)}
      onChange={(event) => onChange(Number(event.target.value) / 100)}
      style={{ flex: 1, minWidth: 0, accentColor: 'var(--td-accent)' }}
    />

    <span
      style={{
        fontFamily: 'var(--td-font-mono)',
        color: 'var(--td-text-secondary)',
        minWidth: 32,
        textAlign: 'right',
      }}
    >
      {Math.round(value * 100)}
    </span>
  </div>
);
