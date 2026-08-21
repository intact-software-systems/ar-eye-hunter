import * as factories from './factory-capability-provider.ts';

declare const dynamicName: keyof typeof factories;
declare const enabled: boolean;

export function mutateConditionalFactory(): void {
    const factoryName = enabled ? 'createRepository' : dynamicName;
    const repository = factories[factoryName]();
    void repository.insertPrincipal({} as never);
}

export function mutateLogicalFactory(): void {
    const factoryName = (enabled && 'createRepository') || dynamicName;
    const repository = factories[factoryName]();
    void repository.updatePrincipal({} as never, 0);
}

export function mutateJoinedFactory(): void {
    let factoryName: keyof typeof factories = 'createRepository';
    if (enabled) {
        factoryName = dynamicName;
    }
    const repository = factories[factoryName]();
    void repository.deletePrincipal({} as never, 0);
}
