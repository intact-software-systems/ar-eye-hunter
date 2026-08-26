import { createGroupStateRuntime } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('GroupStateService retry ownership', () => {
    it('exposes single-attempt phases and leaves complete retries to AppGroupInbox', () => {
        const service = createGroupStateRuntime({
            runtimeRepository: new FakeRuntimeStateRepository(),
            authSessionRepository: { findBySessionId: () => Promise.resolve(undefined) },
            groupStateEventStore: new InMemoryGroupStateEventStore(),
            serviceId: 'single-attempt-group-service'
        }).service;

        expect(service).toMatchObject({
            read: expect.any(Function),
            compute: expect.any(Function),
            validate: expect.any(Function),
            write: expect.any(Function),
            prepareMutation: expect.any(Function)
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
