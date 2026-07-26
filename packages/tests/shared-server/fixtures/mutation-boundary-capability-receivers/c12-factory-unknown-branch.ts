import type { ClientStateRepository } from '@shared-server/mod.ts';

declare const unknownFactory: () => unknown;

export function mutatePossibleFactory(enabled: boolean): void {
  const selected = enabled ? createRepository : unknownFactory;
  const repository = selected();
  void repository.insertPrincipal({} as never);
}

function createRepository(): ClientStateRepository {
  throw new Error('analysis fixture');
}
