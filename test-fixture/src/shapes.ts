/** Used by index.ts, so this must never be reported. */
export type LiveShape = { id: string };

/**
 * Doc comment attached to a dead export - deleting the export should take this
 * comment with it.
 */
export interface DeadShape {
  id: string;
  extra: number;
}

export enum DeadEnum {
  A,
  B,
}

export class DeadClass {
  run(): void {
    /* no-op */
  }
}

// Two declarators on one statement: deleting `deadPair` must leave `livePair`.
export const livePair = 1,
  deadPair = 2;

export type DeadAlias = string | number;
