import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateDestructuredMethod(repository: ClientStateRepository): void {
    const { insertPrincipal } = repository;
    const { insertPrincipal: renamedWrite } = repository;
    void insertPrincipal({} as never);
    void renamedWrite({} as never);
}
