import { createRepository as importedFactory } from './factory-capability-provider.ts';

export function mutateFactoryCallFamily(enabled: boolean): void {
  const selected = enabled ? importedFactory : importedFactory;
  const called = selected.call(undefined);
  void called.insertPrincipal({} as never);

  const applied = selected.apply(undefined, []);
  void applied.updatePrincipal({} as never, 0);

  const bound = selected.bind(undefined);
  const alias = bound;
  const removed = alias();
  void removed.deletePrincipal({} as never, 0);
}
