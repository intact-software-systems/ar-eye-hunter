import { describe, expect, it } from 'vitest';

import { assertLifecycleGroupMutationCommandInput } from '@shared-server/rallar-system/group-state/mutation/command-validation/assert-lifecycle-group-mutation-command-input.ts';

const ACTOR_INPUT = {
    actorPrincipalId: 'alice',
    actorSessionId: 'alice-session',
    reason: null,
    traceId: null
};

const FAIL_FORMATION_KEYS = [...Object.keys(ACTOR_INPUT), 'observedRate', 'expectedFormationEpoch', 'expectedLayout'];

const ACTIVATE_KEYS = [...FAIL_FORMATION_KEYS, 'degraded'];

describe('lifecycle group mutation command input', () => {
    // Wire input cannot carry -0, so only a typed field reaches this check with one.
    it.each(
        [
            ['failGroupFormation', FAIL_FORMATION_KEYS, {}],
            ['activateGroup', ACTIVATE_KEYS, { degraded: null }]
        ] as const
    )('rejects a negative-zero observedRate on %s as the stored rate does', (operation, keys, extra) => {
        const input = { ...ACTOR_INPUT, ...extra, expectedFormationEpoch: null, expectedLayout: null };

        expect(() =>
            assertLifecycleGroupMutationCommandInput({
                operation,
                input: { ...input, observedRate: 0.5 },
                requiredInputKeys: keys
            })
        ).not.toThrow();
        expect(() =>
            assertLifecycleGroupMutationCommandInput({
                operation,
                input: { ...input, observedRate: -0 },
                requiredInputKeys: keys
            })
        ).toThrow(`Group ${operation} observedRate must be within [0, 1]`);
    });
});
