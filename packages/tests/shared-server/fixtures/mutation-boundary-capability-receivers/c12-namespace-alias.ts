import * as factories from './factory-capability-provider.ts';

export function mutateNamespaceAlias(): void {
  const namespaceAlias = factories;
  const holder = { namespaceAlias };
  const factoryName = 'createRepository';
  const boundFactory = holder.namespaceAlias[factoryName].bind(undefined);
  const repository = boundFactory.call(undefined);
  void repository.insertPrincipal({} as never);
}
