import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateAfterPossibleBreak(
  repository: ClientStateRepository,
  stop: boolean,
): void {
  const mode: string = 'read';
  switch (mode) {
    case 'read':
      if (stop) {
        break;
      }
      /* falls through */
    case 'write':
      void repository.insertPrincipal({} as never);
  }
}

export function mutateAfterPossibleReturn(
  repository: ClientStateRepository,
  stop: boolean,
): void {
  const mode: string = 'read';
  switch (mode) {
    case 'read': {
      if (stop) {
        return;
      }
    }
    /* falls through */
    case 'write':
      void repository.updatePrincipal({} as never, 0);
  }
}

export function mutateAfterPossibleThrow(
  repository: ClientStateRepository,
  stop: boolean,
): void {
  const mode: string = 'read';
  switch (mode) {
    case 'read': {
      if (stop) {
        throw new Error('stop');
      }
    }
    /* falls through */
    case 'write':
      void repository.deletePrincipal({} as never, 0);
  }
}
