import type { ClientStateRepository } from '@shared-server/mod.ts';

type DomainRepository = Readonly<{ saveDomain(input: unknown): void; }>;

const domainRepository: DomainRepository = {
    saveDomain: () => undefined
};

export function shadowMutableName(repository: ClientStateRepository): void {
    void repository;
    {
        const repository = domainRepository;
        repository.saveDomain({ domain: true });
    }
}

export function captureReadOnlyMembers(repository: ClientStateRepository): void {
    const directRead = repository.readSnapshot;
    void directRead({} as never);

    let capturedRead: ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    capturedRead = repository.readSnapshot;
    [0].forEach(() => void capturedRead({} as never));
}

class NestedOrdinaryFunctionControl {
    private readonly repository: ClientStateRepository;

    constructor(repository: ClientStateRepository) {
        this.repository = repository;
    }

    run(): void {
        function saveDomain(this: { repository: DomainRepository; }): void {
            this.repository.saveDomain({ domain: true });
        }
        saveDomain.call({ repository: domainRepository });
    }
}

void NestedOrdinaryFunctionControl;
