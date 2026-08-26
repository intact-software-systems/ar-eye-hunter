import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateAfterOwnedBreak(repository: ClientStateRepository): void {
    for (;;) {
        break;
    }
    void repository.insertPrincipal({} as never);
}
