import * as factories from './factory-capability-provider.ts';

declare const dynamicName: string;
declare const enabled: boolean;

export function mutateConditionalFactory(): void {
  const factoryName = enabled ? 'createRepository' : dynamicName;
  const repository = factories[factoryName]();
  void repository.insertPrincipal({} as never);
}

export function mutateLogicalFactory(): void {
  const factoryName = (enabled && 'createRepository') || dynamicName;
  const repository = factories[factoryName]();
  void repository.updatePrincipal({} as never);
}

export function mutateJoinedFactory(): void {
  let factoryName = 'createRepository';
  if (enabled) factoryName = dynamicName;
  const repository = factories[factoryName]();
  void repository.deletePrincipal({} as never);
}
