import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateLocalFactoryAlias(): void {
  const alias = createRepository;
  const repository = alias();
  void repository.insertPrincipal({} as never);
}

function createRepository(): ClientStateRepository {
  throw new Error('analysis fixture');
}
