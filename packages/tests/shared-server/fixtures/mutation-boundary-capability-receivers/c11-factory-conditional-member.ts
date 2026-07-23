import type { ClientStateRepository } from '@shared-server/mod.ts';
import { createRepository as importedFactory } from './factory-capability-provider.ts';

export function mutateConditionalMemberFactory(enabled: boolean): void {
  const factories = { local: createRepository, imported: importedFactory };
  const selected = enabled ? factories.local : factories.imported;
  const alias = selected || factories.local;
  const repository = alias();
  void repository.insertPrincipal({} as never);
}

function createRepository(): ClientStateRepository {
  throw new Error('analysis fixture');
}
