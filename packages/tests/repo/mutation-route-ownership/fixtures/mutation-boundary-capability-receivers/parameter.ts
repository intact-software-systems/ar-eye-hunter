import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateFromParameter(repository: ClientStateRepository): void {
    void repository.insertPrincipal({} as never);
}
