import {
  rockBaseDensity,
  rockMemoryLimit,
  rockResolutionBridge,
  rockResizeLimit,
  rockTargetDensity,
  rockTextureBytes,
} from './bake-density.js';
import type { RockTextureSize } from './bake-density.js';

export interface RockBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}
export interface RockResource {
  readonly density: number;
  readonly bytes: number;
  destroy(): void;
}
export interface RockBakeEntry<T extends RockResource> extends RockTextureSize {
  readonly id: number;
  readonly bounds: RockBounds;
  base: T;
  detail?: T | undefined;
  install(resource: T): void;
}
export interface RockBakeJob<T extends RockResource> {
  advance(deadline: number): boolean;
  finish(): T;
  destroy(): void;
}
export interface RockView extends RockTextureSize {
  readonly resolution: number;
  readonly scale: number;
  readonly bounds: RockBounds;
}
const intersects = (a: RockBounds, b: RockBounds): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/** Очередь хранит последние цели; показанный источник принадлежит клетке до установки замены. */
export class RockBakeQueue<T extends RockResource> {
  readonly cells = new Map<number, RockBakeEntry<T>>();
  private view: RockView | undefined;
  private pending:
    { cell: RockBakeEntry<T>; density: number; base: boolean; job: RockBakeJob<T> } | undefined;
  private dead = false;
  private migrating = false;
  private ordinaryLimit = 0;
  private transitionLimit = 0;
  private reserved = 0;
  private readonly samples = new Map<number, number[]>();
  private initialEstimate = 1;
  private probeFrames = 0;
  overruns = 0;
  probes = 0;
  completed = 0;
  failures = 0;
  lastError: string | null = null;
  peakBytes = 0;

  constructor(
    private readonly prepare: (cell: RockBakeEntry<T>, density: number) => RockBakeJob<T>,
    private readonly now: () => number = () => performance.now(),
  ) {}

  observeInitialBake(milliseconds: number): void {
    this.initialEstimate = Math.max(this.initialEstimate, milliseconds * 1.25);
  }
  estimate(density: number): number {
    const samples = this.samples.get(density);
    return samples?.length ? Math.max(...samples) * 1.25 : this.initialEstimate;
  }

  get actualBytes(): number {
    let bytes = this.reserved;
    for (const cell of this.cells.values()) bytes += cell.base.bytes + (cell.detail?.bytes ?? 0);
    return bytes;
  }
  get limitBytes(): number {
    return this.transitionLimit;
  }
  get newLimitBytes(): number {
    return this.ordinaryLimit;
  }
  get baseDensity(): number {
    return rockBaseDensity(this.view?.resolution ?? 1);
  }
  visible(cell: RockBakeEntry<T>): boolean {
    return this.view !== undefined && intersects(cell.bounds, this.view.bounds);
  }
  target(cell: RockBakeEntry<T>): number {
    return this.visible(cell)
      ? rockTargetDensity(this.view!.resolution, this.view!.scale)
      : this.baseDensity;
  }
  get remaining(): number {
    let count = 0;
    for (const cell of this.cells.values()) {
      if (
        cell.base.density !== this.baseDensity ||
        (cell.detail ?? cell.base).density !== this.target(cell)
      )
        count += 1;
    }
    return count;
  }

  add(cell: RockBakeEntry<T>): void {
    if (this.dead || this.cells.has(cell.id)) throw new Error('Duplicate or destroyed rock cell');
    this.cells.set(cell.id, cell);
    if (this.view) this.recalculate(true);
    this.peakBytes = Math.max(this.peakBytes, this.actualBytes);
  }

  update(view: RockView): void {
    if (this.dead) return;
    const previous = this.view;
    const resolutionChanged = previous?.resolution !== view.resolution;
    const resized = previous?.width !== view.width || previous.height !== view.height;
    this.view = view;
    if (resolutionChanged || resized || (this.pending && !this.current(this.pending)))
      this.cancel();
    if (resolutionChanged || resized) this.recalculate(resolutionChanged);
  }

  private recalculate(resolutionChanged: boolean): void {
    if (!this.view) return;
    const cells = [...this.cells.values()];
    this.ordinaryLimit = rockMemoryLimit(cells, this.view, this.view.resolution).total;
    this.migrating = cells.some((cell) => cell.base.density !== this.baseDensity);
    if (this.migrating) {
      if (resolutionChanged)
        this.transitionLimit = rockResolutionBridge(
          cells.map((cell) => ({ ...cell, heldBytes: cell.base.bytes })),
          this.view.resolution,
          this.actualBytes,
        ).total;
    } else this.transitionLimit = rockResizeLimit(this.actualBytes, this.ordinaryLimit);
  }

  private current(work: NonNullable<RockBakeQueue<T>['pending']>): boolean {
    return (
      !this.dead &&
      this.cells.get(work.cell.id) === work.cell &&
      (work.base
        ? work.density === this.baseDensity && this.migrating
        : !this.migrating && work.density === this.target(work.cell) && this.visible(work.cell))
    );
  }
  private cancel(): void {
    const pending = this.pending;
    this.pending = undefined;
    this.probeFrames = 0;
    pending?.job.destroy();
  }
  private evict(cell: RockBakeEntry<T>): void {
    const old = cell.detail;
    if (!old) return;
    cell.install(cell.base);
    cell.detail = undefined;
    old.destroy();
  }

  step(budgetMs: number): void {
    if (this.dead || !this.view || budgetMs <= 0) return;
    const deadline = this.now() + budgetMs;
    try {
      // Освобождение тоже ограничено кадром; сеть его никогда не ждёт.
      for (const cell of this.cells.values()) {
        if (this.now() >= deadline) return;
        if (
          cell.detail &&
          (this.migrating ||
            this.target(cell) === this.baseDensity ||
            this.actualBytes > this.ordinaryLimit)
        )
          this.evict(cell);
      }
      if (!this.migrating && this.actualBytes <= this.ordinaryLimit)
        this.transitionLimit = this.ordinaryLimit;
      if (this.pending && !this.current(this.pending)) this.cancel();
      if (!this.pending) {
        const centreX = (this.view.bounds.minX + this.view.bounds.maxX) / 2;
        const centreY = (this.view.bounds.minY + this.view.bounds.maxY) / 2;
        const priority = (cell: RockBakeEntry<T>): number => {
          if (!this.visible(cell)) return 2;
          return (cell.detail ?? cell.base).density < this.target(cell) ? 0 : 1;
        };
        const distance = (cell: RockBakeEntry<T>): number =>
          ((cell.bounds.minX + cell.bounds.maxX) / 2 - centreX) ** 2 +
          ((cell.bounds.minY + cell.bounds.maxY) / 2 - centreY) ** 2;
        const candidates = [...this.cells.values()].filter((cell) =>
          this.migrating
            ? cell.base.density !== this.baseDensity
            : this.target(cell) !== (cell.detail ?? cell.base).density,
        );
        candidates.sort(
          (a, b) => priority(a) - priority(b) || distance(a) - distance(b) || a.id - b.id,
        );
        const cell = candidates[0];
        if (!cell || this.now() >= deadline) return;
        const density = this.migrating ? this.baseDensity : this.target(cell);
        this.pending = { cell, density, base: this.migrating, job: this.prepare(cell, density) };
      }
      const work = this.pending;
      if (!work.job.advance(deadline) || this.now() >= deadline) return;
      if (!this.current(work)) {
        this.cancel();
        return;
      }
      const bytes = rockTextureBytes(work.cell, work.density);
      const limit = this.migrating ? this.transitionLimit : this.ordinaryLimit;
      // Старые подробности могут занимать место для последней цели после уменьшения масштаба.
      for (const cell of this.cells.values()) {
        if (this.actualBytes + bytes <= limit) break;
        if (this.now() >= deadline) return;
        if (cell.detail && cell.detail.density !== this.target(cell)) this.evict(cell);
      }
      if (this.actualBytes + bytes > limit || this.now() >= deadline) return;
      const remaining = deadline - this.now();
      if (remaining < this.estimate(work.density)) {
        // Выброс не превращается в пожизненную остановку: одна проба на четыре свободных кадра.
        if (remaining < 6 || ++this.probeFrames < 4) return;
        this.probes += 1;
      }
      this.probeFrames = 0;
      this.reserved = bytes;
      this.peakBytes = Math.max(this.peakBytes, this.actualBytes);
      let result: T | undefined;
      const started = this.now();
      try {
        result = work.job.finish();
        if (!this.current(work) || this.pending !== work) return;
        if (result.bytes !== bytes || result.density !== work.density)
          throw new Error('Rock allocation differs from reservation');
        const old = work.base ? work.cell.base : work.cell.detail;
        work.cell.install(result);
        if (work.base) work.cell.base = result;
        else work.cell.detail = result;
        result = undefined;
        this.reserved = 0;
        old?.destroy();
        this.completed += 1;
        this.lastError = null;
      } finally {
        const elapsed = this.now() - started;
        const samples = this.samples.get(work.density) ?? [];
        samples.push(elapsed);
        if (samples.length > 8) samples.shift();
        this.samples.set(work.density, samples);
        if (this.now() > deadline) this.overruns += 1;
        result?.destroy();
        this.reserved = 0;
        if (this.pending === work) this.cancel();
      }
      if (
        this.migrating &&
        [...this.cells.values()].every((cell) => cell.base.density === this.baseDensity)
      ) {
        this.migrating = false;
        this.transitionLimit = this.ordinaryLimit;
      }
    } catch (error) {
      this.failures += 1;
      this.lastError = String(error);
      this.cancel();
    }
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.cancel();
    for (const cell of this.cells.values()) {
      cell.detail?.destroy();
      cell.base.destroy();
    }
    this.cells.clear();
    this.ordinaryLimit = this.transitionLimit = 0;
  }
}
