import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

declare const unknownRepository: unknown;

const asserted = unknownRepository as ClientStateRepository;
void asserted.insertPrincipal({} as never);

const angleAsserted = <ClientStateRepository> unknownRepository;
void angleAsserted.insertPrincipal({} as never);
