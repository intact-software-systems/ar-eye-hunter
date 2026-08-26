import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateAfterExactFalseLoop(repository: ClientStateRepository): void {
    while (false) {
        void repository.updatePrincipal({} as never, 0);
    }
    void repository.deletePrincipal({} as never, 0);
}
