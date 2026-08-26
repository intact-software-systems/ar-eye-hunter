import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

type RepositoryInput = Readonly<{ repository: ClientStateRepository; }>;

export const mutateObjectParameter = (input: RepositoryInput): void => {
    void input.repository.insertPrincipal({} as never);
};
