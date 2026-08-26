import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export const mutateFromDestructuring = (
    { repository: original }: Readonly<{ repository: ClientStateRepository; }>
): void => {
    const nested = { repository: original };
    const { repository } = nested;
    const alias = repository;
    void alias.insertPrincipal({} as never);
};
