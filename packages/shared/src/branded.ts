/**
 * Брендированные (номинальные) типы.
 *
 * Проблема: `type PlayerId = number` и `type TickNumber = number` для
 * TypeScript — это одно и то же, поэтому он молча пропустит передачу
 * номера тика туда, где ждали идентификатор игрока.
 *
 * Решение: подмешиваем к числу невидимую метку. В рантайме это всё тот же
 * обычный number с нулевой стоимостью, но компилятор теперь считает
 * PlayerId и TickNumber разными типами и ловит перепутанные аргументы.
 */
declare const brand: unique symbol;

export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

/** Идентификатор игрока внутри матча: 0 или 1. */
export type PlayerId = Brand<number, 'PlayerId'>;

/** Порядковый номер тика симуляции. Единственная мера времени в игре. */
export type TickNumber = Brand<number, 'TickNumber'>;

/** Идентификатор матча. */
export type MatchId = Brand<string, 'MatchId'>;

/** Идентификатор сущности внутри мира: башни, врага, снаряда. */
export type EntityId = Brand<number, 'EntityId'>;

export const asPlayerId = (value: number): PlayerId => value as PlayerId;
export const asTickNumber = (value: number): TickNumber => value as TickNumber;
export const asMatchId = (value: string): MatchId => value as MatchId;
export const asEntityId = (value: number): EntityId => value as EntityId;
