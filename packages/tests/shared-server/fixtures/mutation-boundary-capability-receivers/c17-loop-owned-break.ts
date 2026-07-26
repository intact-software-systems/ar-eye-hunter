import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateAfterOwnedBreak(repository: ClientStateRepository): void {
  for (;;) {
    break;
  }
  void repository.insertPrincipal({} as never);
}
