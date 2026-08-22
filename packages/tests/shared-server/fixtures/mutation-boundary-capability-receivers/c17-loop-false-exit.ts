import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateAfterExactFalseLoop(repository: ClientStateRepository): void {
    while (false) {
        void repository.updatePrincipal({} as never, 0);
    }
    void repository.deletePrincipal({} as never, 0);
}
