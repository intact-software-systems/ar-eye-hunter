import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreDirectBreak(repository: ClientStateRepository): void {
  switch ('read') {
    case 'read':
      break;
    case 'write':
      void repository.insertPrincipal({} as never);
  }
}

export function ignoreDirectReturn(repository: ClientStateRepository): void {
  switch ('read') {
    case 'read':
      return;
    case 'write':
      void repository.updatePrincipal({} as never, 0);
  }
}

export function ignoreDirectThrow(repository: ClientStateRepository): void {
  switch ('read') {
    case 'read':
      throw new Error('stop');
    case 'write':
      void repository.deletePrincipal({} as never);
  }
}
