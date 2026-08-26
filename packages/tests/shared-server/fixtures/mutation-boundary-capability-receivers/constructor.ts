import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export class ConstructorReceiver {
    readonly #repository: ClientStateRepository;

    constructor(repository: ClientStateRepository) {
        this.#repository = repository;
    }

    mutate(): void {
        void this.#repository.insertPrincipal({} as never);
    }
}
