import type { Budget } from './types';

// All player-mode budget accounting lives here, so the invariant — real
// parts on the map plus parts in stock is conserved — has one home. Ghosts
// are outside the invariant: they are never paid for and never refunded.
// God mode bypasses these entirely.

// Take up to `want` cells of pipe from the stock; returns how many were
// affordable (callers lay the remainder as ghost).
export function takePipe(budget: Budget, want: number): number {
  const got = Math.min(want, Math.max(0, Math.floor(budget.pipe)));
  budget.pipe -= got;
  return got;
}

export function refundPipe(budget: Budget, cells: number): void {
  budget.pipe += cells;
}

// Take one machine of this type from the stock; false = out of stock
// (callers place a ghost instead).
export function takeMachine(budget: Budget, typeId: string): boolean {
  if ((budget.machines[typeId] ?? 0) < 1) return false;
  budget.machines[typeId] -= 1;
  return true;
}

export function refundMachine(budget: Budget, typeId: string): void {
  budget.machines[typeId] = (budget.machines[typeId] ?? 0) + 1;
}
