import * as factories from './factory-capability-provider.ts';

export function mutateNamespaceFactory(): void {
  const repository = factories.createRepository();
  void repository.insertPrincipal({} as never);
}
