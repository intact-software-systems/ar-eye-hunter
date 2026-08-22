import type { ClientStateRepository } from '@shared-server/mod.ts';

type RepositoryInput = Readonly<{ repository: ClientStateRepository; }>;

export const mutateObjectParameter = (input: RepositoryInput): void => {
    void input.repository.insertPrincipal({} as never);
};
