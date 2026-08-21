import type { ClientStateRepository } from '@shared-server/mod.ts';

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
