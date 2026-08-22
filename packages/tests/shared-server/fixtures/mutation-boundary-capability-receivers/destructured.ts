import type { ClientStateRepository } from '@shared-server/mod.ts';

export const mutateFromDestructuring = (
    { repository: original }: Readonly<{ repository: ClientStateRepository; }>
): void => {
    const nested = { repository: original };
    const { repository } = nested;
    const alias = repository;
    void alias.insertPrincipal({} as never);
};
