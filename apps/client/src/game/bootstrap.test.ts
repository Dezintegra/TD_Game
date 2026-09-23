import { afterEach, expect, it, vi } from 'vitest';
import { createWorld } from '@td/sim';
import { FRAME_WORK_BUDGET_MS } from '@td/shared';
import type { RendererHost } from './scene.js';
import { startGame } from './bootstrap.js';

const harness = vi.hoisted(() => {
  const events: string[] = [];
  const mark = (name: string) =>
    vi.fn(() => {
      events.push(name);
    });
  return {
    events,
    now: 0,
    advanceCost: 0,
    terrain: true,
    frame: () => {},
    scene: {
      setMap: mark('map'),
      bakeTerrain: vi.fn(),
      bakeIcons: mark('icons'),
      follow: mark('follow'),
      render: mark('render'),
      adaptRocks: mark('adapt'),
      viewCentre: { x: 1, y: 1 },
      destroy: mark('destroy'),
    },
    guest: { predicted: null as unknown, confirmed: null, advance: vi.fn() },
  };
});
vi.mock('./scene.js', () => ({ createScene: () => harness.scene }));
vi.mock('@td/netplay', () => ({ createMatchGuest: () => harness.guest }));
vi.mock('./net.js', () => ({ createNetClient: () => ({ connect() {}, disconnect() {} }) }));
vi.mock('./loop.js', () => ({
  createRenderLoop: (options: { onFrame(): void }) => {
    harness.frame = options.onFrame;
    return { start() {}, stop() {} };
  },
}));
vi.mock('./controls.js', () => ({
  attachControls: () => ({
    state: { hoverCell: -1 },
    detach() {},
  }),
}));
vi.mock('../audio/index.js', () => ({
  createAudio: () => ({ settings: {}, frame() {}, stop() {} }),
}));
vi.mock('./readings-sender.js', () => ({ createReadingsSender: () => ({ send() {}, stop() {} }) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('конечное построение освобождает иконки, догон и текущая камера предшествуют адаптации', async () => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(performance, 'now').mockImplementation(() => harness.now);
  harness.guest.predicted = createWorld(4242);
  harness.scene.bakeTerrain.mockImplementation(() => {
    harness.events.push('terrain');
    harness.now += 1;
    return harness.terrain;
  });
  harness.scene.bakeIcons.mockImplementation(() => {
    harness.events.push('icons');
    return null as never;
  });
  harness.guest.advance.mockImplementation(() => {
    harness.events.push('advance');
    harness.now += harness.advanceCost;
  });
  const game = await startGame({ element: {} } as RendererHost, {
    seed: 4242,
    localPlayer: 0,
    ticket: 'test',
  });
  try {
    for (const terrain of [true, false, false]) {
      harness.terrain = terrain;
      harness.events.length = 0;
      harness.frame();
      expect(harness.events).toEqual([
        'map',
        'terrain',
        ...(terrain ? [] : ['icons']),
        'advance',
        'follow',
        'render',
        'adapt',
      ]);
      expect(harness.guest.advance).toHaveBeenLastCalledWith(FRAME_WORK_BUDGET_MS - 1);
      expect(harness.scene.adaptRocks).toHaveBeenLastCalledWith(FRAME_WORK_BUDGET_MS - 1);
    }
    harness.advanceCost = FRAME_WORK_BUDGET_MS;
    harness.frame();
    expect(harness.scene.adaptRocks).toHaveBeenLastCalledWith(0);
  } finally {
    game.stop();
  }
});
