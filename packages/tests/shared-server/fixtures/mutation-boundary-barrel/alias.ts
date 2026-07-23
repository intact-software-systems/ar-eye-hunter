import { ClientStateRepository as MutableClientRepository } from '@shared-server/mod.ts';

declare const repository: MutableClientRepository;
void repository.insertPrincipal({} as never);
