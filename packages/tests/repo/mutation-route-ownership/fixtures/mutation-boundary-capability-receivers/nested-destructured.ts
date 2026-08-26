import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

type NestedRepositoryInput = Readonly<{
    nested: Readonly<{ repository: ClientStateRepository; }>;
}>;

export function mutateNestedDestructured(input: NestedRepositoryInput): void {
    const { nested: { repository: renamedRepository } } = input;
    void renamedRepository.insertPrincipal({} as never);
}
