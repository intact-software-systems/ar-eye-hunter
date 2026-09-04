import { describe, expect, it } from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import {
    computeGroupStateInboxResult,
    validateGroupStateInboxResult
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';

import {
    createMutationCommand,
    createMutationFacts,
    createMutationRead
} from '../group-state-concurrency-test-fixtures.ts';

describe('group-state AppInbox result validation', () => {
    it('returns every exact-result issue and returns no issues for the canonical result', () => {
        const command = {
            authorityProof: null,
            descriptor: null,
            command: createMutationCommand(),
            facts: createMutationFacts()
        } as const;
        const read = createMutationRead();
        const mutation = computeGroupMutation({
            command: command.command,
            read,
            facts: command.facts
        });
        if (mutation.outcome !== 'write' || read.group === null || read.actorMember === null) {
            throw new Error('Expected an effectful group mutation fixture');
        }
        const currentSnapshot: GroupSnapshot = {
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            group: { ...read.group.value, presenceVersion: 0 },
            members: [read.actorMember],
            activeSessions: [],
            memberCount: 1,
            onlineMemberCount: 0
        };
        const input = {
            command,
            read,
            computed: mutation,
            currentSnapshot,
            recordedEvent: undefined
        } as const;
        const computed = computeGroupStateInboxResult(input);
        if (!('result' in computed)) {
            throw new Error('Expected a group-state durable result');
        }

        expect(validateGroupStateInboxResult(input, computed)).toEqual([]);
        const issues = validateGroupStateInboxResult(input, {
            ...computed,
            status: 'created',
            result: {
                ...computed.result,
                snapshot: {
                    ...computed.result.snapshot,
                    memberCount: computed.result.snapshot.memberCount + 1
                }
            }
        });
        expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
            'computed.status',
            'computed.result.snapshot.memberCount'
        ]));
    });
});
