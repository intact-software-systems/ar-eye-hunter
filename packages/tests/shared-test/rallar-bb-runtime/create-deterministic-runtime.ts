import { createDefaultRallarBlackBoxTestRuntime } from '../../../shared-test/rallar-bb-test/mod.ts';
export function createDeterministicRuntime() {
    let now = 1_000;
    let sequence = 1;
    return createDefaultRallarBlackBoxTestRuntime({
        now: () => now++,
        idFactory: (prefix) => `${prefix}-${sequence++}`
    });
}
