import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateFromBracket(repository: ClientStateRepository): void {
    void repository['insertPrincipal']({} as never);
    const method = 'insertPrincipal';
    void repository?.[method]({} as never);
}
