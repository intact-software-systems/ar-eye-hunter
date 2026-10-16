import { describe, expect, it, vi } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { GroupMutationIngress } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createQueueResilience } from '../../../../shared/app-inbox/fair-service-fixture.ts';
import { createAuthorityHarness, SCOPE, type AuthorityHarness } from './group-state-inbox-test-runtime.ts';

const BUSY_GROUP: GroupRef = { ...SCOPE, groupId: 'busy-room' };
const IDLE_GROUP: GroupRef = { ...SCOPE, groupId: 'idle-room' };
const BACKLOG = 15;

describe('group system commands', () => {
    it('serve one group\'s command ahead of another group\'s backlog and keep each group in order', async () => {
        const harness = await createAuthorityHarness(['owner']);
        stubSystemIngresses(harness);
        for (let index = 0; index < BACKLOG; index += 1) {
            await harness.service.enqueueFormationCriterionCommand(toCommand(BUSY_GROUP, `busy-${index}`), 1);
        }
        await harness.service.enqueueFormationCriterionCommand(toCommand(IDLE_GROUP, 'idle-0'), 1);
        const reader = new InboxQueueReader(harness.queue, { laneBudgetPolicy: 'fixed-retry-two' });
        const served: string[] = [];
        reader.onInboxMessageDo(AppInboxType.GROUP_FORMATION_CRITERION, {
            onMessage: async (message) => {
                served.push(message.route.resourceId);
            }
        });

        while (await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience()) > 0) {
            // Each pass serves at most one entry per context.
        }

        expect(served).toHaveLength(BACKLOG + 1);
        expect(served.indexOf('idle-0'), `service order ${served.join(',')}`).toBeLessThan(served.indexOf('busy-2'));
        expect(served.filter((id) => id.startsWith('busy-')))
            .toEqual(Array.from({ length: BACKLOG }, (_, index) => `busy-${index}`));
    });

    it('enqueue every server-issued group command in its group\'s context', async () => {
        const harness = await createAuthorityHarness(['owner']);
        stubSystemIngresses(harness);
        vi.spyOn(harness.groupStateService, 'captureExpiredPresenceMutationIngresses')
            .mockResolvedValue([toIngress(toCommand(IDLE_GROUP, 'expire-0'))]);

        await harness.service.enqueueFormationCriterionCommand(toCommand(BUSY_GROUP, 'criterion-0'), 1);
        await harness.service.enqueueFormationAutomationCommand(toCommand(BUSY_GROUP, 'automation-0'), 1);
        await harness.service.enqueueTopologyPublicationCommand(toCommand(BUSY_GROUP, 'publication-0'), 1);
        await harness.service.enqueueActivationStatusCommand(toCommand(BUSY_GROUP, 'activation-0'), 1);
        await harness.service.enqueueExpiredPresenceSessions(1);

        const contexts = Object.fromEntries((await harness.queueEntries()).map((entry) => [entry.key.resourceId, entry.key.contextId]));
        expect(contexts).toEqual({
            'criterion-0': toQueueContextId(BUSY_GROUP),
            'automation-0': toQueueContextId(BUSY_GROUP),
            'publication-0': toQueueContextId(BUSY_GROUP),
            'activation-0': toQueueContextId(BUSY_GROUP),
            'expire-0': toQueueContextId(IDLE_GROUP)
        });
        expect(toQueueContextId(BUSY_GROUP)).not.toBe(toQueueContextId(IDLE_GROUP));
    });
});

function toQueueContextId(ref: GroupRef): string {
    return toAppQueueKey({ topicId: '', resourceId: '', contextId: groupStateGroupStorageKey(ref) }).contextId;
}

function stubSystemIngresses(harness: AuthorityHarness): void {
    const capture = async (command: GroupMutationCommand) => toIngress(command);
    vi.spyOn(harness.groupStateService, 'captureFormationCriterionMutationIngress').mockImplementation(capture);
    vi.spyOn(harness.groupStateService, 'captureFormationAutomationMutationIngress').mockImplementation(capture);
    vi.spyOn(harness.groupStateService, 'captureTopologyPublicationMutationIngress').mockImplementation(capture);
    vi.spyOn(harness.groupStateService, 'captureActivationStatusMutationIngress').mockImplementation(capture);
}

function toCommand(aggregateRef: GroupRef, commandId: string): GroupMutationCommand {
    return {
        aggregateRef,
        commandId,
        requestId: null,
        operation: 'appointDirector',
        input: { actorPrincipalId: null, actorSessionId: null, reason: null, traceId: null, heartbeatTtlMs: 1 }
    };
}

/** The enqueue reads only the command and its queue identity; the facts are placeholders. */
function toIngress(command: GroupMutationCommand): GroupMutationIngress {
    return {
        authorityProof: null,
        descriptor: null,
        command,
        facts: {
            nowEpochMs: 1,
            expireAtEpochMs: 2,
            serviceId: 'server-12345678',
            eventId: `event-${command.commandId}`,
            commandHash: `hash-${command.commandId}`,
            resolvedJoinCode: null,
            joinCodeVerifier: null,
            internalAuthority: 'formation-criterion',
            capacity: { defaultMaxMembers: null },
            authenticatedAuthority: null
        },
        causalToken: `token-${command.commandId}`,
        queueResourceId: command.commandId
    };
}
