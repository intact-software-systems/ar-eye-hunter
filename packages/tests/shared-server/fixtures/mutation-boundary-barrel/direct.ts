import { ClientStateRepository } from '@shared-server/mod.ts';

declare const repository: ClientStateRepository;
void repository.insertPrincipal({} as never);
