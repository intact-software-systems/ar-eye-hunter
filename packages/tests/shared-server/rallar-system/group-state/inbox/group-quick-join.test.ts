import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toGroupMutationEventId } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUP_LIFECYCLE_POLICIES_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { decodeQuickJoinGroupRequest } from '@shared-server/rallar-system/group-state/quick-join/group-quick-join-codec.ts';
import { GroupQuickJoinService } from '@shared-server/rallar-system/group-state/quick-join/group-quick-join-service.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { encodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import type { CreateGroupRequest } from '@shared/api/state-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    createAuthorityHarness,
    createResilience,
    createRoom,
    processAuthenticated,
    SCOPE,
    waitForQueueEntry,
    type AuthorityHarness
} from './group-state-inbox-test-runtime.ts';

function createQuickJoinService(
    harness: AuthorityHarness,
    capacity: { readonly defaultMaxMembers: number | null; },
    now: () => number
): GroupQuickJoinService {
    return new GroupQuickJoinService({
        repository: harness.repository,
        authSessions: harness.authSessions
    }, {
        capacity,
        serviceId: 'quick-join-test',
        now,
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS
    });
}

async function quickJoin(
    harness: AuthorityHarness,
    request: Parameters<GroupStateInboxService['processQuickJoinUntilCompletion']>[0],
    principalId = 'bob'
) {
    const pending = harness.service.processQuickJoinUntilCompletion(request, harness.sessions[principalId]);
    await waitForQueueEntry(harness.queue);
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    return (await pending).fold((error) => {
        throw new Error(error.message);
    }, (result) => result);
}

async function seedCandidate(harness: AuthorityHarness, request: Partial<CreateGroupRequest> & { groupId: string; }) {
    const result = await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions.owner,
        input: {
            type: AppInboxType.GROUP_CREATE,
            resourceId: `create-${request.groupId}`,
            contextId: `create-${request.groupId}`,
            data: {
                scope: SCOPE,
                request: {
                    displayName: 'AR Eye Hunter',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    ...request,
                    requestId: `create-${request.groupId}`
                }
            }
        }
    });
    expect(result.left).toBeUndefined();
}

async function seedOnlineSessions(harness: AuthorityHarness, groupId: string, principalIds: readonly string[]) {
    const ref = { ...SCOPE, groupId };
    const activeSessions = principalIds.map((principalId, index): GroupPresenceSession => ({
        ...ref,
        principalId,
        sessionId: `online-${index}`,
        generationId: `generation-${index}`,
        generationVersion: harness.nowEpochMs,
        connectionGenerationId: `connection-${index}`,
        connectedAtEpochMs: harness.nowEpochMs,
        lastHeartbeatAtEpochMs: harness.nowEpochMs,
        expiresAtEpochMs: harness.nowEpochMs + 60_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
    for (const session of activeSessions) {
        await harness.repository.putPresenceSession(session);
    }
    const summary = await harness.repository.findPresenceSummaryEntry(ref);
    const group = await harness.repository.readSnapshot(ref);
    if (!summary || !group) {
        throw new Error('Expected a created candidate and its presence summary');
    }
    const activePrincipalIds = [...new Set(principalIds)].sort();
    await harness.repository.updatePresenceSummary({
        ...ref,
        causalRevision: { groupRevision: group.group.snapshotVersion, presenceRevision: 1 },
        activePrincipalIds,
        activeSessionIds: activeSessions.map((session) => session.sessionId),
        activeSessions,
        activePrincipalCount: activePrincipalIds.length,
        activeSessionCount: activeSessions.length,
        computedAtEpochMs: harness.nowEpochMs
    }, summary.entry.revision);
}

async function joinCandidate(harness: AuthorityHarness, groupId: string, principalId: string) {
    const requestId = `join-${groupId}-${principalId}`;
    const joined = await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions[principalId],
        input: {
            type: AppInboxType.GROUP_JOIN,
            resourceId: requestId,
            contextId: requestId,
            data: { scope: SCOPE, groupId, request: { requestId } }
        }
    });
    expect(joined.left).toBeUndefined();
}

describe('Quick Join through AppInbox', () => {
    it('admits to the matching existing room and returns its committed membership', async () => {
        const timings: RallarTimingEvent[] = [];
        const harness = await createAuthorityHarness(['owner', 'bob'], { timing: (event) => timings.push(event) });
        await createRoom(harness, 'unrelated', 'Relic Hunters');
        await createRoom(harness, 'arena', 'AR Eye Hunter');

        const result = await quickJoin(harness, {
            scope: SCOPE,
            request: { requestId: 'quick-bob', kind: 'room', q: ' EYE HUNTER ', includeEmpty: true }
        });

        expect(result).toMatchObject({
            status: 'joined',
            snapshot: {
                group: { groupId: 'arena', activeMemberCount: 2 },
                members: expect.arrayContaining([expect.objectContaining({ principalId: 'bob', status: 'active' })])
            }
        });
        const committed = await harness.repository.readSnapshot({ ...SCOPE, groupId: 'arena' });
        if (result.status !== 'joined') {
            throw new Error('Expected a joined room');
        }
        expect(result.snapshot).toEqual(committed);
        const other = await harness.repository.readSnapshot({ ...SCOPE, groupId: 'unrelated' });
        expect(other?.members.map((member) => member.principalId)).toEqual(['owner']);
        const phases = timings.filter((event) => event.component === 'group-quick-join');
        expect(phases.map((event) => event.operation)).toEqual(['read', 'compute', 'validate', 'write']);
        for (const phase of phases) {
            expect(phase).toMatchObject({
                ...SCOPE,
                requestId: 'quick-bob',
                principalId: 'bob',
                sessionId: harness.sessions.bob.sessionId,
                serviceId: 'server-12345678',
                status: 'ok',
                details: { attempt: 1 }
            });
        }
        const transactionTiming = timings.findIndex((event) =>
            event.component === 'app-inbox-phase' && event.operation === 'transaction' && event.requestId === 'quick-bob'
        );
        const writeTiming = timings.findIndex((event) => event.component === 'group-quick-join' && event.operation === 'write');
        expect(transactionTiming).toBeGreaterThanOrEqual(0);
        expect(writeTiming).toBeGreaterThan(transactionTiming);
    });

    it('returns unavailable without parking an approval request', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        const created = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                type: AppInboxType.GROUP_CREATE,
                resourceId: 'create-approval',
                contextId: 'create-approval',
                data: {
                    scope: SCOPE,
                    request: {
                        requestId: 'create-approval',
                        groupId: 'approval',
                        displayName: 'AR Eye Hunter',
                        kind: 'room',
                        joinMode: 'open',
                        createdByPrincipalId: 'owner',
                        lifecyclePolicy: {
                            manager: { selection: 'assigned', assignedPrincipalIds: ['owner'] },
                            admission: { mode: 'manager-approval' }
                        }
                    }
                }
            }
        });
        expect(created.left).toBeUndefined();

        const result = await quickJoin(harness, {
            scope: SCOPE,
            request: { requestId: 'quick-approval', includeEmpty: true }
        });

        expect(result).toEqual({ status: 'unavailable' });
        const room = await harness.repository.readSnapshot({ ...SCOPE, groupId: 'approval' });
        expect(room?.members.map((member) => ({ principalId: member.principalId, status: member.status })))
            .toEqual([{ principalId: 'owner', status: 'active' }]);
    });

    it('rejects a queued capacity fact changed without its authenticated proof', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await createRoom(harness, 'capacity', 'AR Eye Hunter');
        const service = createQuickJoinService(harness, { defaultMaxMembers: 1 }, () => harness.nowEpochMs);
        const authorized = await service.authorize({
            scope: SCOPE,
            request: { requestId: 'capacity-proof', includeEmpty: true }
        }, harness.sessions.bob);
        const ingress = await service.capture(authorized, harness.sessions.bob);

        await expect(service.read(
            encodeJsonWireValue({
                ...ingress,
                facts: { ...ingress.facts, capacity: { defaultMaxMembers: null } }
            }, 'Tampered Quick Join ingress'),
            1
        )).rejects.toMatchObject({ status: 403 });

        const room = await harness.repository.readSnapshot({ ...SCOPE, groupId: 'capacity' });
        expect(room?.group.activeMemberCount).toBe(1);
    });

    it('stamps each capture with the finished-command window and an event id of its own ingress instant', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        let nowEpochMs = harness.nowEpochMs;
        const service = createQuickJoinService(harness, { defaultMaxMembers: null }, () => nowEpochMs);
        const authorized = await service.authorize({
            scope: SCOPE,
            request: { requestId: 'window-capture', includeEmpty: true }
        }, harness.sessions.bob);

        const first = await service.capture(authorized, harness.sessions.bob);
        nowEpochMs += TEST_APP_INBOX_FINISHED_RETENTION_MS + 1;
        const replayAfterWindow = await service.capture(authorized, harness.sessions.bob);

        expect(first.facts.commandHash).toBe(replayAfterWindow.facts.commandHash);
        expect(first.facts.expireAtEpochMs).toBe(harness.nowEpochMs + TEST_APP_INBOX_FINISHED_RETENTION_MS);
        expect(replayAfterWindow.facts.expireAtEpochMs).toBe(nowEpochMs + TEST_APP_INBOX_FINISHED_RETENTION_MS);
        expect(replayAfterWindow.facts.eventId).not.toBe(first.facts.eventId);
        expect(first.facts.eventId).toBe(toGroupMutationEventId(first.facts.commandHash, harness.nowEpochMs));
        expect(replayAfterWindow.facts.eventId).toBe(toGroupMutationEventId(replayAfterWindow.facts.commandHash, nowEpochMs));
    });

    it('keeps an existing approval request pending and returns unavailable', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await seedCandidate(harness, {
            groupId: 'pending',
            lifecyclePolicy: {
                manager: { selection: 'assigned', assignedPrincipalIds: ['owner'] },
                admission: { mode: 'manager-approval' }
            }
        });
        const manual = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.bob,
            input: {
                type: AppInboxType.GROUP_JOIN,
                resourceId: 'manual-pending',
                contextId: 'manual-pending',
                data: { scope: SCOPE, groupId: 'pending', request: { requestId: 'manual-pending' } }
            }
        });
        expect(manual.left).toBeUndefined();

        const result = await quickJoin(harness, {
            scope: SCOPE,
            request: { requestId: 'already-pending', includeEmpty: true }
        });

        expect(result).toEqual({ status: 'unavailable' });
        const room = await harness.repository.readSnapshot({ ...SCOPE, groupId: 'pending' });
        expect(room?.members.find((member) => member.principalId === 'bob')?.status).toBe('pending');
    });

    it('admits a forming room whose policy closes entry after formation', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await seedCandidate(harness, {
            groupId: 'forming',
            lifecyclePolicy: { formation: 'phased', admission: { mode: 'closed' } }
        });
        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId: 'forming' }))?.group.lifecycleState)
            .toBe('forming');

        const result = await quickJoin(harness, {
            scope: SCOPE,
            request: { requestId: 'forming-join', includeEmpty: true }
        });

        expect(result).toMatchObject({ status: 'joined', snapshot: { group: { groupId: 'forming' } } });
    });

    it.each([
        { groupId: 'full', maxMembers: 1 },
        { groupId: 'window-cap', lifecyclePolicy: { admission: { untilMemberCount: 1 } } },
        { groupId: 'closed-active', lifecyclePolicy: { admission: { mode: 'closed' as const } } },
        { groupId: 'expired-window', lifecyclePolicy: { admission: { untilEpochMs: 1 } } },
        { groupId: 'private', joinMode: 'invite-only' as const }
    ])('skips $groupId without changing its roster', async (candidate) => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await seedCandidate(harness, candidate);

        const result = await quickJoin(harness, {
            scope: SCOPE,
            request: { requestId: `skip-${candidate.groupId}`, includeEmpty: true }
        });

        expect(result).toEqual({ status: 'unavailable' });
        const room = await harness.repository.readSnapshot({ ...SCOPE, groupId: candidate.groupId });
        expect(room?.members.map((member) => member.principalId)).toEqual(['owner']);
    });

    it('prefers two online members over three sessions of one member', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob', 'carol']);
        await createRoom(harness, 'a-many-sessions', 'AR Eye Hunter');
        await createRoom(harness, 'z-more-members', 'AR Eye Hunter');
        await joinCandidate(harness, 'z-more-members', 'carol');
        await seedOnlineSessions(harness, 'a-many-sessions', ['owner', 'owner', 'owner']);
        await seedOnlineSessions(harness, 'z-more-members', ['owner', 'carol']);

        const result = await quickJoin(harness, {
            scope: SCOPE,
            request: { requestId: 'rank-members' }
        });

        expect(result).toMatchObject({
            status: 'joined',
            snapshot: { group: { groupId: 'z-more-members' }, onlineMemberCount: 2 }
        });
    });

    it('breaks equal online-member counts by group ID, independent of insertion order', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await createRoom(harness, 'z-room', 'AR Eye Hunter');
        await createRoom(harness, 'a-room', 'AR Eye Hunter');
        await seedOnlineSessions(harness, 'z-room', ['owner']);
        await seedOnlineSessions(harness, 'a-room', ['owner']);

        const result = await quickJoin(harness, { scope: SCOPE, request: { requestId: 'rank-tie' } });

        expect(result).toMatchObject({ status: 'joined', snapshot: { group: { groupId: 'a-room' } } });
    });

    it('excludes empty rooms by default and preserves durable unavailable on replay', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await createRoom(harness, 'empty', 'AR Eye Hunter');
        const input = { scope: SCOPE, request: { requestId: 'empty-default' } };
        const first = await quickJoin(harness, input);
        expect(first).toEqual({ status: 'unavailable' });
        await seedOnlineSessions(harness, 'empty', ['owner']);

        const replay = await harness.service.processQuickJoinUntilCompletion(input, harness.sessions.bob);

        expect(replay.right).toEqual(first);
        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId: 'empty' }))?.group.activeMemberCount).toBe(1);
    });

    it('replays the committed room after a new session and a better candidate appear', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await createRoom(harness, 'z-original', 'AR Eye Hunter');
        const input = { scope: SCOPE, request: { requestId: 'stable-winner', includeEmpty: true } };
        const first = await quickJoin(harness, input);
        await createRoom(harness, 'a-new', 'AR Eye Hunter');
        const renewed = { ...harness.sessions.bob, sessionId: 'bob-renewed', accessToken: 'bob-renewed-token' };
        await harness.authSessions.putSession(renewed);

        const replay = await harness.service.processQuickJoinUntilCompletion(input, renewed);
        expect(replay.right).toEqual(first);
        await expect(harness.service.processQuickJoinUntilCompletion({
            ...input,
            request: { ...input.request, kind: 'room' }
        }, renewed)).rejects.toMatchObject({ status: 409 });
        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId: 'a-new' }))?.group.activeMemberCount).toBe(1);
        expect((await harness.repository.listEvents({ ...SCOPE, groupId: 'z-original' }))
            .filter((event) => event.eventType === 'member-joined')).toHaveLength(1);
    });

    it('rejects a session revoked after enqueue without changing membership', async () => {
        const timings: RallarTimingEvent[] = [];
        const harness = await createAuthorityHarness(['owner', 'bob'], { timing: (event) => timings.push(event) });
        await createRoom(harness, 'revoked', 'AR Eye Hunter');
        const pending = harness.service.processQuickJoinUntilCompletion({
            scope: SCOPE,
            request: { requestId: 'revoked-join', includeEmpty: true }
        }, harness.sessions.bob);
        await waitForQueueEntry(harness.queue);
        await harness.authSessions.deleteSession(harness.sessions.bob);

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect((await pending).left).toMatchObject({ status: 403 });
        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId: 'revoked' }))?.group.activeMemberCount).toBe(1);
        expect(timings.filter((event) => event.component === 'group-quick-join')).toEqual([
            expect.objectContaining({ operation: 'read', status: 'error', requestId: 'revoked-join' })
        ]);
    });

    it.each(['scope', 'member'] as const)('rejects a self-consistent durable result for another %s', async (substitution) => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await createRoom(harness, 'result-room', 'AR Eye Hunter');
        const before = await harness.repository.readSnapshot({ ...SCOPE, groupId: 'result-room' });
        const input = { scope: SCOPE, request: { requestId: `substituted-${substitution}`, includeEmpty: true } };
        const first = await quickJoin(harness, input);
        const entry = (await harness.queueEntries()).find((candidate) => candidate.key.resourceId === input.request.requestId);
        if (first.status !== 'joined' || !before || !entry) {
            throw new Error('Expected a committed Quick Join and its durable command slot');
        }
        const wrongScope = { applicationId: 'another-app', workspaceId: 'another-workspace' };
        const snapshot = substitution === 'member' ? before : {
            ...first.snapshot,
            group: { ...first.snapshot.group, ...wrongScope },
            members: first.snapshot.members.map((member) => ({ ...member, ...wrongScope })),
            activeSessions: first.snapshot.activeSessions.map((session) => ({ ...session, ...wrongScope }))
        };
        await harness.results.replace({
            ...entry,
            status: EntityStatus.COMPLETED,
            resource: JSON.stringify({ status: 'joined', snapshot })
        });

        const replay = await harness.service.processQuickJoinUntilCompletion(input, harness.sessions.bob);

        expect(replay.right).toBeUndefined();
        expect(replay.left).toMatchObject({ code: 'app-inbox-result-corrupt', status: 500 });
    });

    it('fails closed for a corrupt admission policy instead of skipping to another room', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await createRoom(harness, 'a-corrupt', 'AR Eye Hunter');
        await createRoom(harness, 'z-fallback', 'AR Eye Hunter');
        await harness.runtimeRepository.upsert(
            GROUP_LIFECYCLE_POLICIES_NAMESPACE,
            groupStateGroupStorageKey({ ...SCOPE, groupId: 'a-corrupt' }),
            '{}',
            Number.MAX_SAFE_INTEGER
        );

        await expect(quickJoin(harness, {
            scope: SCOPE,
            request: { requestId: 'corrupt-policy', includeEmpty: true }
        })).rejects.toThrow(/policy/i);

        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId: 'z-fallback' }))?.group.activeMemberCount).toBe(1);
    });

    it.each([
        { includeEmpty: 'true' },
        { kind: 'not-a-group-kind' },
        { q: 42 },
        { actorPrincipalId: 'someone-else' },
        { limit: 10 },
        { cursor: 'directory-only' }
    ])('rejects malformed or unsupported selection fields: %j', (fields) => {
        expect(() => decodeQuickJoinGroupRequest({ requestId: 'invalid-selection', ...fields })).toThrow();
    });
});
