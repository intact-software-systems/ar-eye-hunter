import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreNestedBreak(repository: ClientStateRepository): void {
  const stop: boolean = true;
  switch ('read') {
    case 'read': {
      if (stop) {
        break;
      }
    }
    /* falls through */
    case 'write':
      void repository.insertPrincipal({} as never);
  }
}

export function ignoreNestedReturn(repository: ClientStateRepository): void {
  const stop: boolean = true;
  switch ('read') {
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

export function ignoreNestedThrow(repository: ClientStateRepository): void {
  const stop: boolean = true;
  switch ('read') {
    case 'read': {
      if (stop) {
        throw new Error('stop');
      }
    }
    /* falls through */
    case 'write':
      void repository.deletePrincipal({} as never);
  }
}
