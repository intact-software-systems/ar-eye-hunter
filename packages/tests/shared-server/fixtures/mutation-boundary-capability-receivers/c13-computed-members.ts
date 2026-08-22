import type { ClientStateRepository } from '@shared-server/mod.ts';
import * as factories from './factory-capability-provider.ts';

declare const enabled: boolean;
declare const dynamicMethod: string;

export function mutateComputedMembers(repository: ClientStateRepository): void {
    const conditionalMethod = enabled ? 'insertPrincipal' : 'insertPrincipal';
    const logicalMethod = (enabled && 'updatePrincipal') || 'updatePrincipal';
    const differentMethod = enabled ? 'insertPrincipal' : 'updatePrincipal';
    const unknownMethod = enabled ? 'deletePrincipal' : dynamicMethod;

    void repository[conditionalMethod]({} as never);
    void repository[logicalMethod]({} as never, 0);
    void repository[differentMethod]({} as never, 0);
    void repository[unknownMethod as 'deletePrincipal']({} as never, 0);
}

export function mutateComputedFactory(): void {
    const factoryName = enabled ? 'createRepository' : 'createRepository';
    const repository = factories[factoryName]();
    void repository.insertPrincipal({} as never);
}
