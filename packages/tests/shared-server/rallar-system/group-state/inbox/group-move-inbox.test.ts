import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toLogicalAppInboxCommand } from '@shared-server/rallar-system/app-inbox/logical-app-inbox-command.ts';
import { encodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createAuthorityHarness, createResilience, createRoom, processAuthenticated, SCOPE, waitForQueueEntry } from './group-state-inbox-test-runtime.ts';

function request(action: GroupMoveRequest['action']): GroupMoveRequest {
    return {
        requestId: `move-${action}`,
        moveId: 'move-1',
        source: { ...SCOPE, groupId: 'source' },
        destination: { ...SCOPE, groupId: 'destination' },
        action,
        joinCode: null,
        inviteToken: null
    };
}

describe('group moves through AppInbox', () => {
    it('replays the durable committed result without executing another admission', async () => {
        const timings: RallarTimingEvent[] = [];
        const harness = await createAuthorityHarness(['owner'], { timing: (event) => timings.push(event) });
        await createRoom(harness, 'source', 'Source');
        await createRoom(harness, 'destination', 'Destination');
        const connected = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                traceId: 'move-setup',
                type: AppInboxType.GROUP_PRESENCE_CONNECT,
                resourceId: 'connect-owner',
                contextId: 'source',
                data: {
                    scope: SCOPE,
                    groupId: 'source',
                    sessionId: harness.sessions.owner.sessionId,
                    request: {
                        requestId: 'connect-owner',
                        principalId: 'owner',
                        generationId: 'owner-generation',
                        connectionGenerationId: 'owner-connection',
                        connectedAtEpochMs: harness.nowEpochMs,
                        lastHeartbeatAtEpochMs: harness.nowEpochMs,
                        expiresAtEpochMs: harness.nowEpochMs + 60_000
                    }
                }
            }
        });
        expect(connected.left).toBeUndefined();
        async function act(action: GroupMoveRequest['action']) {
            const pending = harness.service.processGroupMoveUntilCompletion({ request: request(action), traceId: 'move-test' }, harness.sessions.owner);
            await waitForQueueEntry(harness.queue);
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            return (await pending).fold((failure) => {
                throw new Error(failure.message);
            }, (move) => move);
        }
        await act('propose');
        await act('confirm');
        const committed = await act('commit');
        expect(committed.status).toBe('committed');
        expect(timings.filter((event) => event.component === 'group-move' && event.requestId === 'move-commit').map((event) => [event.operation, event.status]))
            .toEqual([['read', 'ok'], ['compute', 'ok'], ['validate', 'ok'], ['write', 'ok']]);
        expect(timings.some((event) => event.component === 'app-inbox-phase' && event.operation === 'transaction')).toBe(true);
        const replay = await harness.service.processGroupMoveUntilCompletion({ request: request('commit'), traceId: 'retry' }, harness.sessions.owner);
        expect(replay.right).toEqual(committed);
        expect((await harness.repository.readSnapshot(request('commit').destination))?.memberCount).toBe(1);
        await expect(
            harness.service.processGroupMoveUntilCompletion(
                { request: { ...request('commit'), action: 'cancel' }, traceId: 'different-command' },
                harness.sessions.owner
            )
        ).rejects.toMatchObject({ status: 409 });
    });

    it('keeps the exact actor session in logical command identity', () => {
        const first = { ...request('confirm'), actorPrincipalId: 'owner', actorSessionId: 'first' };
        const enqueue = { type: AppInboxType.GROUP_MOVE, contextId: 'move', data: encodeJsonWireValue(first) };
        expect(toLogicalAppInboxCommand(enqueue)).not.toEqual(
            toLogicalAppInboxCommand({ ...enqueue, data: encodeJsonWireValue({ ...first, actorSessionId: 'second' }) })
        );
        expect(toLogicalAppInboxCommand(enqueue)).toEqual(toLogicalAppInboxCommand({ ...enqueue, authority: { capturedAt: 123 } }));
    });
});
