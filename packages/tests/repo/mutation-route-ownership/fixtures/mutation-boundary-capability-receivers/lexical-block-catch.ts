import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

type DomainRepository = Readonly<{ saveDomain(input: unknown): void; }>;

const domainRepository: DomainRepository = {
    saveDomain: () => undefined
};

export function mutateAcrossLexicalScopes(repository: ClientStateRepository): void {
    void repository.insertPrincipal({} as never);
    {
        const repository = domainRepository;
        repository.saveDomain({ block: true });
    }
    try {
        domainRepository.saveDomain({ try: true });
    }
    catch (repository) {
        const domain = repository as DomainRepository;
        domain.saveDomain({ catch: true });
    }
}
