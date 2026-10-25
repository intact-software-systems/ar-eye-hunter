import { createGroupStateRuntime } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../app-inbox/test-support/test-app-inbox-finished-retention.ts';

describe('GroupStateService retry ownership', () => {
    it('exposes single-attempt phases and leaves complete retries to AppGroupInbox', () => {
        const service = createGroupStateRuntime({
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            runtimeRepository: new FakeRuntimeStateRepository(),
            groupStateEventStore: new InMemoryGroupStateEventStore(),
            serviceId: 'single-attempt-group-service',
            readPlannedLayoutRow: async () => null,
            readAcceptedLayoutRow: async () => null
        }).service;

        expect(service).toMatchObject({
            read: expect.any(Function),
            compute: expect.any(Function),
            validate: expect.any(Function),
            write: expect.any(Function),
            captureMutationIngress: expect.any(Function)
        });
        for (
            const directMutation of [
                'createGroup',
                'updateGroup',
                'upsertMember',
                'connectPresenceSession',
                'heartbeatPresenceSession',
                'disconnectPresenceSession',
                'expireExpiredPresenceSessions'
            ]
        ) {
            expect(Reflect.get(service, directMutation)).toBeUndefined();
        }
    });
});
