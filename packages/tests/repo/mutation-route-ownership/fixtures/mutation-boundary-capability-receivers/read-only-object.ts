import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

type ReadInput = Readonly<{ repository: ClientStateRepository; }>;

export function readObjectCapability(input: ReadInput): void {
    void input.repository.readSnapshot({} as never);
    const { readSnapshot: read } = input.repository;
    void read({} as never);
}
