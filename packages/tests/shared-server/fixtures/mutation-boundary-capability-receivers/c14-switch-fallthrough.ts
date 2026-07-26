import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateLaterFallthroughCase(
  repository: ClientStateRepository,
): void {
  switch ('read') {
    case 'read':
      void repository.readSnapshot;
      /* falls through */
    case 'write':
      void repository.insertPrincipal({} as never);
      break;
  }
}

export function mutateDefaultAfterMatch(
  repository: ClientStateRepository,
): void {
  switch ('read') {
    case 'read':
      void repository.readSnapshot;
      /* falls through */
    default:
      void repository.updatePrincipal({} as never);
      break;
  }
}

export function mutateNoMatchDefault(
  repository: ClientStateRepository,
): void {
  switch ('missing') {
    case 'read':
      void repository.readSnapshot;
      break;
    default:
      void repository.deletePrincipal({} as never);
  }
}
