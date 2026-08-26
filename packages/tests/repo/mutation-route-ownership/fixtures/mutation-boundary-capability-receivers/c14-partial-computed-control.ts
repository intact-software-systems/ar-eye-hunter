import * as unrelated from './c14-unrelated-provider.ts';

declare const dynamicName: keyof typeof unrelated;
declare const enabled: boolean;

export function ignoreUnrelatedNamespace(): void {
    const factoryName = enabled ? 'createRepository' : dynamicName;
    unrelated[factoryName]().read();
}
