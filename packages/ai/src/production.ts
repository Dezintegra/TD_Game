import { UnitType } from '@td/shared';

type Mix = Readonly<Record<UnitType, number>>;

/** Память обычного заказа: неудачная оплата не даёт дешёвому типу новый шанс. */
export const createProduction = () => {
  let chosen: UnitType | undefined;

  const reconcile = (mix: Mix): void => {
    if (chosen !== undefined && mix[chosen] <= 0) chosen = undefined;
  };

  return {
    reconcile,
    choose(mix: Mix, queueFull: boolean, roll: (bound: number) => number): UnitType | undefined {
      reconcile(mix);
      if (queueFull) return undefined;
      if (chosen !== undefined) return chosen;

      const types = [UnitType.Assault, UnitType.Sniper, UnitType.Tesla] as const;
      const total = types.reduce<number>((sum, type) => sum + mix[type], 0);
      if (total <= 0) return undefined;
      let pick = roll(total);
      for (const type of types) {
        if (pick < mix[type]) {
          chosen = type;
          break;
        }
        pick -= mix[type];
      }
      return chosen;
    },
    issued(): void {
      chosen = undefined;
    },
  };
};

export type Production = ReturnType<typeof createProduction>;
