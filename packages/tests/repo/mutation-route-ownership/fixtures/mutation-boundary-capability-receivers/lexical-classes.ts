import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

type DomainRepository = Readonly<{ saveDomain(input: unknown): void; }>;

export class MutableOwner {
    constructor(private readonly repository: ClientStateRepository) {}

    mutate(): void {
        void this.repository.insertPrincipal({} as never);
    }
}

export class OrdinaryOwner {
    private readonly repository: DomainRepository = {
        saveDomain: () => undefined
    };

    save(): void {
        this.repository.saveDomain({ domain: true });
    }
}
