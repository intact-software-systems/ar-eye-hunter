import { createRepository } from './factory-capability-provider.ts';

export function mutateStoredFactoryArray(): void {
  const makeFactories = () => [, createRepository] as const;
  const [, factory] = makeFactories();
  const repository = factory();
  void repository.insertPrincipal({} as never);
}
