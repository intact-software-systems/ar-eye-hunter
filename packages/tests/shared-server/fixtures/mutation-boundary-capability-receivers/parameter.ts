import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateFromParameter(repository: ClientStateRepository): void {
    void repository.insertPrincipal({} as never);
}
