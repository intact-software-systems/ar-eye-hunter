import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import { createAuthorityHarness, waitForQueueEntry } from '../../../group-state/inbox/group-state-inbox-test-runtime.ts';

import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import type { TopologyAppInboxMutationOwners } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';

describe('topology inbox result decoding', () => {
    it('returns the exact terminal left for a malformed completed topology result', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const authority = harness.sessions.owner;
        const command = await toTopologyAppInboxCommand({
            actor: {
                principalId: authority.clientId,
                sessionId: authority.sessionId
            },
            groupRef: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                groupId: 'malformed-result-room'
            },
            requestId: 'malformed-topology-result',
            capturedAtEpochMs: harness.nowEpochMs,
            payload: {
                operation: 'putConfig',
                config: { topologyKind: 'tree' }
            }
        });
        const service = new TopologyInboxService(
            {
                inboxQueueReader: harness.reader,
                resourceInboxRepository: harness.queue,
                resourceInboxResultsRepository: harness.results,
                database: harness.database,
                groupStateService: harness.groupStateService,
                mutationOwners: {} as TopologyAppInboxMutationOwners
            },
            { serviceId: 'topology-result-decoding' }
        );
        const pending = service.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.TOPOLOGY_CONFIG_PUT,
                resourceId: command.requestId,
                data: command
            },
            authority
        );

        await waitForQueueEntry(harness.queue);
        const [key] = await harness.queue.getAllKeys();
        if (key === undefined) {
            throw new Error('Expected a durable topology queue key');
        }
        const queued = await harness.queue.getItem(key);
        if (queued === undefined) {
            throw new Error('Expected a durable topology queue entry');
        }
        const completed = {
            ...queued,
            resource: JSON.stringify({ status: 'accepted', requestId: command.requestId }),
            status: EntityStatus.COMPLETED
        };
        await harness.results.replace(completed);
        await harness.queue.enqueue(completed);

        const result = await pending;
        expect(result.right).toBeUndefined();
        expect(result.left).toEqual({
            type: 'app-inbox-failure',
            code: 'app-inbox-result-corrupt',
            status: 500,
            message: 'Persisted AppInbox result is corrupt',
            issues: null,
            denial: null,
            retry: null
        });
    });
});
