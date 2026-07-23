import { createRepository as makeRepository } from './factory-capability-provider.ts';

export function mutateImportedFactoryCapability(): void {
  const repository = makeRepository();
  void repository.insertPrincipal({} as never);
}
