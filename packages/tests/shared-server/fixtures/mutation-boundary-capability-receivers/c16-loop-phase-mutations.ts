import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateForUpdateAfterContinue(repository: ClientStateRepository): void {
  for (;; repository.insertPrincipal({} as never)) {
    continue;
  }
}

export function mutateDoTestAfterContinue(repository: ClientStateRepository): void {
  do {
    continue;
  } while (repository.updatePrincipal({} as never, 0) as never);
}

export function mutatePostLoopAfterBreak(repository: ClientStateRepository): void {
  for (;; repository.updatePrincipal({} as never, 0)) {
    break;
  }
  void repository.deletePrincipal({} as never, 0);
}
