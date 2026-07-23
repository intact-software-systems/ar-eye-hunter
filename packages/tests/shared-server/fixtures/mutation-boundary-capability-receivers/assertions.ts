import type { ClientStateRepository } from '@shared-server/mod.ts';

declare const unknownRepository: unknown;

const asserted = unknownRepository as ClientStateRepository;
void asserted.insertPrincipal({} as never);

const angleAsserted = <ClientStateRepository> unknownRepository;
void angleAsserted.insertPrincipal({} as never);
