import { createRepository as importedFactory } from './factory-capability-provider.ts';

export function mutateImportedFactoryAlias(): void {
    const alias = importedFactory;
    const repository = alias();
    void repository.insertPrincipal({} as never);
}
