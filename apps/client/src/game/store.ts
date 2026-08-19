import { create } from 'zustand';

/**
 * Store — единственный канал связи между игровым циклом и React.
 *
 * Зачем такая строгость. Игровой цикл крутится 60 раз в секунду.
 * Если бы он дёргал setState на каждом кадре, React перерисовывал бы
 * дерево 60 раз в секунду и съел бы весь бюджет отзывчивости.
 *
 * Поэтому цикл пишет в store только то, что реально показывается
 * в HUD, и только когда значение изменилось. Всё остальное —
 * позиции башен, врагов, снарядов — живёт в PixiJS и до React
 * вообще не доходит.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'online';

interface HudState {
  readonly status: ConnectionStatus;
  readonly tick: number;
  /** Сколько раз сервер ответил на ping. Признак живого канала. */
  readonly pongCount: number;
  /** Время оборота пакета в миллисекундах. */
  readonly latencyMs: number;
  /** Кадров в секунду, усреднённо. */
  readonly fps: number;

  setStatus(status: ConnectionStatus): void;
  setTick(tick: number): void;
  registerPong(latencyMs: number): void;
  setFps(fps: number): void;
}

export const useHudStore = create<HudState>((set) => ({
  status: 'offline',
  tick: 0,
  pongCount: 0,
  latencyMs: 0,
  fps: 0,

  setStatus: (status) => set({ status }),
  setTick: (tick) => set({ tick }),
  registerPong: (latencyMs) => set((state) => ({ pongCount: state.pongCount + 1, latencyMs })),
  setFps: (fps) => set({ fps }),
}));

/**
 * Прямой доступ к store в обход React-хуков.
 * Нужен игровому циклу: он живёт вне дерева компонентов.
 */
export const hudActions = {
  setStatus: (status: ConnectionStatus) => useHudStore.getState().setStatus(status),
  setTick: (tick: number) => useHudStore.getState().setTick(tick),
  registerPong: (latencyMs: number) => useHudStore.getState().registerPong(latencyMs),
  setFps: (fps: number) => useHudStore.getState().setFps(fps),
};
