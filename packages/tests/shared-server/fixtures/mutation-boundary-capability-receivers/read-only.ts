import type { ClientStateRepository } from '@shared-server/mod.ts';

export function readFromParameter(repository: ClientStateRepository): void {
    void repository.readSnapshot({} as never);
}
