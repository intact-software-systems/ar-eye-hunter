import { createRepository as factory } from './factory-capability-provider.ts';

export function ignoreShadowedFactory(): void {
  void factory;
  {
    const factory = () => ({ ordinary(): void {} });
    factory().ordinary();
  }
}
