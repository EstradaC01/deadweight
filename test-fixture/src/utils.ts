export function usedHelper(value: number): number {
  return value * 2;
}

// Never imported anywhere - Deadweight should flag this.
export function unusedHelper(value: string): string {
  return value.trim();
}

export const USED_CONSTANT = 42;

// Never imported anywhere - Deadweight should flag this.
export const UNUSED_CONSTANT = 'orphan';

// Never imported anywhere - Deadweight should flag this.
export interface UnusedShape {
  id: string;
}
