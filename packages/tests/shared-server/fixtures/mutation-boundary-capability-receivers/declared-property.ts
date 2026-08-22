import type { ClientStateRepository } from '@shared-server/mod.ts';

export class DeclaredPropertyReceiver {
    private readonly repository: ClientStateRepository;

    constructor(repository: ClientStateRepository) {
        this.repository = repository;
    }

    mutate(): void {
        void this.repository.insertPrincipal({} as never);
    }
}
