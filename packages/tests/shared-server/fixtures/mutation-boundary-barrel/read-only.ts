import { ClientStateRepository } from '@shared-server/mod.ts';

declare const repository: ClientStateRepository;
void repository.readSnapshot({} as never);
