import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

declare const unknownFactory: () => ClientStateRepository;

export function mutatePossibleFactory(enabled: boolean): void {
    const selected = enabled ? createRepository : unknownFactory;
    const repository = selected();
    void repository.insertPrincipal({} as never);
}

function createRepository(): ClientStateRepository {
    throw new Error('analysis fixture');
}
