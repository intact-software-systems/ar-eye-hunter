import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateThroughMemberReferences(repository: ClientStateRepository): void {
    const directWrite = repository.insertPrincipal;
    void directWrite({} as never);

    let capturedWrite: ClientStateRepository['insertPrincipal'] = repository.insertPrincipal;
    capturedWrite = repository.insertPrincipal;
    [0].forEach(() => {
        const renamedWrite = capturedWrite;
        void renamedWrite({} as never);
    });
}
