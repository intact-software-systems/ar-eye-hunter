import { describe, expect, it } from 'vitest';

import {
    computeTopologyConfigMutationAttempt,
    validateTopologyConfigMutationAttempt
} from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';

import { createTopologyConfigMutationTestInput } from './group-topology-config-mutation-test-fixtures.ts';

describe('group topology config mutation attempt', () => {
    it('computes override expiry from captured facts and validates the exact candidate', () => {
        const mutation = createTopologyConfigMutationTestInput({ operation: 'putOverride' });
        const read = {
            state: mutation.read,
            policyNowEpochMs: 10_000,
            actorIsPlatformAdmin: false,
            serverDefaults: mutation.serverDefaults
        };
        const attempt = {
            commandHash: mutation.facts.commandHash,
            capturedAtEpochMs: 10_000,
            count: 1
        };
        const computed = computeTopologyConfigMutationAttempt(mutation.command, read, attempt);

        expect(computed).toMatchObject({
            outcome: 'write',
            result: { kind: 'override', override: { expiresAtEpochMs: 15_000 } }
        });
        expect(validateTopologyConfigMutationAttempt({ command: mutation.command, read, attempt }, computed)).toEqual([]);
        expect(validateTopologyConfigMutationAttempt({
            command: mutation.command,
            read,
            attempt: { ...attempt, capturedAtEpochMs: 11_000 }
        }, computed)).toMatchObject([{ path: 'mutation' }]);
    });
});
