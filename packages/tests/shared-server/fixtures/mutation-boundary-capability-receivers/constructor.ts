import type { ClientStateRepository } from '@shared-server/mod.ts';

export class ConstructorReceiver {
  constructor(private readonly repository: ClientStateRepository) {}

  mutate(): void {
    void this.repository.insertPrincipal({} as never);
  }
}
