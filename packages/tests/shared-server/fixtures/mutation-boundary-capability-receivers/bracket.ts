import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateFromBracket(repository: ClientStateRepository): void {
    void repository['insertPrincipal']({} as never);
    const method = 'insertPrincipal';
    void repository?.[method]({} as never);
}
