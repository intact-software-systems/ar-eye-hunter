import { describe, expect, it } from 'vitest';

import { resolveExposedGarbageCollector } from '@shared/runtime-health/resolve-exposed-garbage-collector.ts';

describe('resolveExposedGarbageCollector', () => {
    it('is the global gc only where the runtime exposes it as a function', () => {
        const collected: string[] = [];
        const collector = resolveExposedGarbageCollector({ gc: () => collected.push('gc') });
        collector?.();

        expect(collected).toEqual(['gc']);
        expect(resolveExposedGarbageCollector({})).toBeUndefined();
        expect(resolveExposedGarbageCollector({ gc: 'not a function' })).toBeUndefined();
    });
});
