import type { ClientStateRepository } from '@shared-server/mod.ts';

export class ConstructorReceiver {
    readonly #repository: ClientStateRepository;

    constructor(repository: ClientStateRepository) {
        this.#repository = repository;
    }

    mutate(): void {
        void this.#repository.insertPrincipal({} as never);
    }
}
