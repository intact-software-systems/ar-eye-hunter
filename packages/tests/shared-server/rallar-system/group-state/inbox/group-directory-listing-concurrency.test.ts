import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { encodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { UpdateGroupRequest } from '@shared/api/state-types.ts';

import {
    createAuthorityHarness,
    createRoom,
    processAuthenticated,
    SCOPE,
    type AuthorityHarness
} from './group-state-inbox-test-runtime.ts';

const ROOM_REF = { ...SCOPE, groupId: 'listing-race' };

describe('listing changes under optimistic concurrency', () => {
    it('rebases a listing-only update over concurrently committed metadata', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, ROOM_REF.groupId, 'Shared room');
        const service = harness.groupStateService;
        const ingress = await service.captureMutationIngress({
            operation: 'updateGroup',
            scope: SCOPE,
            groupId: ROOM_REF.groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { requestId: 'hide-room', directoryListing: 'unlisted', actorPrincipalId: 'owner' }
        }, harness.sessions.owner);
        const command = {
            ...ingress,
            facts: toGroupMutationAttemptFacts({
                ingressFacts: ingress.facts,
                attemptCount: 1,
                laneNowEpochMs: harness.nowEpochMs,
                traceId: 'trace-group-directory-listing-concurrency'
            })
        };
        const read = await service.read(command);
        const computed = service.compute(command, read);
        expect(service.validate(command, read, computed)).toEqual([]);
        if (computed.outcome !== 'write') {
            throw new Error('Expected an initial listing write');
        }
        await updateRoom(harness, { requestId: 'new-theme', metadata: { theme: 'ocean' } });
        const committed = await harness.repository.readSnapshot(ROOM_REF);
        const outboxCount = harness.database.outboxEntries.size;

        await expect(harness.database.begin((transaction) => service.write(transaction, computed)))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await harness.repository.readSnapshot(ROOM_REF)).toEqual(committed);
        expect(harness.database.outboxEntries.size).toBe(outboxCount);

        const retry = {
            ...command,
            facts: toGroupMutationAttemptFacts({
                ingressFacts: ingress.facts,
                attemptCount: 2,
                laneNowEpochMs: harness.nowEpochMs,
                traceId: 'trace-group-directory-listing-concurrency'
            })
        };
        const fresh = await service.read(retry);
        const rebased = service.compute(retry, fresh);
        expect(service.validate(retry, fresh, rebased)).toEqual([]);
        if (rebased.outcome !== 'write') {
            throw new Error('Expected the fresh attempt to hide the room');
        }
        await harness.database.begin((transaction) => service.write(transaction, rebased));

        const after = await harness.repository.readSnapshot(ROOM_REF);
        expect(after?.group.metadata).toEqual({ theme: 'ocean', rallarDirectoryListing: 'unlisted' });
        expect(after?.group.snapshotVersion).toBe(3);
        expect(after?.members).toEqual(committed?.members);
        expect((await harness.repository.listEvents(ROOM_REF)).filter((event) => event.eventType === 'group-updated'))
            .toHaveLength(2);
    });

    it('rejects a Quick Join computed before hiding and skips it on the fresh attempt', async () => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        await createRoom(harness, ROOM_REF.groupId, 'Shared room');
        const service = harness.groupStateService.quickJoin;
        const command = service.authorize({
            scope: SCOPE,
            request: { requestId: 'quick-join-race', includeEmpty: true }
        }, harness.sessions.guest);
        const ingress = encodeJsonWireValue(await service.capture(command, harness.sessions.guest), 'Quick Join');
        const read = await service.read(ingress, 1, 'trace-group-directory-listing-concurrency');
        const computed = service.compute(read);
        expect(service.validate(read, computed)).toEqual([]);
        expect(computed.result.status).toBe('joined');
        await updateRoom(harness, { requestId: 'hide-before-join', directoryListing: 'unlisted' });
        const committed = await harness.repository.readSnapshot(ROOM_REF);
        const outboxCount = harness.database.outboxEntries.size;

        await expect(harness.database.begin((transaction) => service.write(transaction, computed)))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await harness.repository.readSnapshot(ROOM_REF)).toEqual(committed);
        expect(harness.database.outboxEntries.size).toBe(outboxCount);
        const fresh = await service.read(ingress, 2, 'trace-group-directory-listing-concurrency');
        const rebased = service.compute(fresh);

        expect(service.validate(fresh, rebased)).toEqual([]);
        expect(rebased).toEqual({ mutation: null, result: { status: 'unavailable' } });
        expect(committed?.members.map((member) => member.principalId)).toEqual(['owner']);
        expect(await harness.repository.listEvents(ROOM_REF)).toHaveLength(2);
    });
});

async function updateRoom(harness: AuthorityHarness, request: UpdateGroupRequest): Promise<void> {
    const result = await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions.owner,
        input: {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: request.requestId,
            contextId: ROOM_REF.groupId,
            data: { scope: SCOPE, groupId: ROOM_REF.groupId, request }
        }
    });
    expect(result.left).toBeUndefined();
}
