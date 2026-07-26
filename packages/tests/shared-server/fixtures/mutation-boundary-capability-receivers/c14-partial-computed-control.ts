import * as unrelated from './c14-unrelated-provider.ts';

declare const dynamicName: string;
declare const enabled: boolean;

export function ignoreUnrelatedNamespace(): void {
  const factoryName = enabled ? 'createRepository' : dynamicName;
  unrelated[factoryName]().read();
}
