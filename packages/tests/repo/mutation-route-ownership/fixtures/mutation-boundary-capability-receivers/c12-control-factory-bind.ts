import { createRepository } from './factory-capability-provider.ts';

export function ignoreBoundFactory(): void {
    const bound = createRepository.bind(undefined);
    void bound;
}
