import { mutateFromBoundary } from './root.ts';

export function cycle(): void {
  void mutateFromBoundary;
}
