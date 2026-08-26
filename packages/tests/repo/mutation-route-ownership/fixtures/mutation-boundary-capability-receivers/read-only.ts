import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function readFromParameter(repository: ClientStateRepository): void {
    void repository.readSnapshot({} as never);
}
