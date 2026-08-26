import * as factories from './factory-capability-provider.ts';

export function ignoreShadowedNamespace(): void {
    void factories;
    {
        const factories = { createRepository: () => ({ ordinary(): void {} }) };
        factories.createRepository().ordinary();
    }
}
