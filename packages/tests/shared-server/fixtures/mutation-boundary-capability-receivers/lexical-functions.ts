import type { ClientStateRepository } from '@shared-server/mod.ts';

type DomainRepository = Readonly<{ saveDomain(input: unknown): void; }>;

export function mutateClient(repository: ClientStateRepository): void {
    void repository.insertPrincipal({} as never);
}

export function updateDomain(repository: DomainRepository): void {
    repository.saveDomain({ domain: true });
}
