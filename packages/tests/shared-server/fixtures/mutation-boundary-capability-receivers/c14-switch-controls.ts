import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreCaseAfterBreak(
  repository: ClientStateRepository,
): void {
  switch ('read') {
    case 'read':
      void repository.readSnapshot;
      break;
    case 'write':
      void repository.insertPrincipal({} as never);
  }
}

export function ignoreCaseAfterReturn(
  repository: ClientStateRepository,
): void {
  switch ('read') {
    case 'read':
      return;
    case 'write':
      void repository.updatePrincipal({} as never);
  }
}

export function ignoreCaseAfterThrow(
  repository: ClientStateRepository,
): void {
  switch ('read') {
    case 'read':
      throw new Error('stop');
    case 'write':
      void repository.deletePrincipal({} as never);
  }
}

export function ignoreCaseAfterNestedBreak(
  repository: ClientStateRepository,
): void {
  switch ('read') {
    case 'read': {
      void repository.readSnapshot;
      break;
    }
    case 'write':
      void repository.insertPrincipal({} as never);
  }
}

export function ignoreDefaultBeforeExactMatch(
  repository: ClientStateRepository,
): void {
  switch ('read') {
    default:
      void repository.insertPrincipal({} as never);
      break;
    case 'read':
      void repository.readSnapshot;
      break;
  }
}
