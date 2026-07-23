import * as sharedServer from '@shared-server/mod.ts';

declare const repository: sharedServer.ClientStateRepository;
void repository.insertPrincipal({} as never);
