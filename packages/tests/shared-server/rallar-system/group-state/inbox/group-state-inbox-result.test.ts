import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type {
    GroupJoinCodeWritten,
    GroupStateMutationCommand,
    GroupStateWritten
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { decodeGroupStateWritten } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';
import {
    computeGroupStateInboxMutation,
    GroupStateInboxResultReadConflictError,
    validateGroupStateInboxMutation,
    type ComputeGroupStateInboxMutationInput,
    type GroupStateInboxMutationComputed
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-snapshot-read-through-cache.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import type { UpdateGroupRequest } from '@shared/api/state-types.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { configureTestCacheRepositories } from '../../../../configure-test-cache-repositories.ts';
import {
    createAuthorityHarness,
    createResilience,
    createRoom,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    waitForQueueEntry,
    type AuthorityHarness
} from './group-state-inbox-test-runtime.ts';

const RESULT_GROUP_ID = 'canonical-result-room';
const RESULT_GROUP_REF = { ...SCOPE, groupId: RESULT_GROUP_ID };

describe('GroupStateInbox durable result computation', () => {
    it('commits a reconnect without reading or installing a speculative snapshot in the actual cache', async () => {
        const harness = await createResultHarness();
        await seedOnlineOwner(harness);
        configureTestCacheRepositories();
        const cache = createGroupStateSnapshotReadThroughCache({ groupsRepository: harness.repository });
        const cachedService = createCachedGroupStateService({ durable: harness.groupStateService, cache });
        const before = await cache.findOrLoadByRef(RESULT_GROUP_REF);
        const reader = new InboxQueueReader(harness.queue);
        let wakes = 0;
        const service = new GroupStateInboxService({
            inboxQueueReader: reader,
            resourceInboxRepository: harness.queue,
            resourceInboxResultsRepository: harness.results,
            database: harness.database,
            groupStateService: cachedService,
            resultReader: {
                readSnapshot: async () => {
                    throw new TypeError('Presence must not depend on a snapshot read.');
                },
                readEvent: async () => {
                    throw new TypeError('Presence receipt must not depend on an event read.');
                }
            }
        }, {
            serviceId: 'server-12345678',
            wakeOwningQueue: () => {
                wakes += 1;
            }
        });
        const result = await processAuthenticated({
            service,
            reader,
            authority: harness.sessions.owner,
            input: {
                type: AppInboxType.GROUP_PRESENCE_CONNECT,
                resourceId: 'handler-reconnect',
                contextId: RESULT_GROUP_ID,
                senderId: 'owner',
                data: {
                    scope: SCOPE,
                    groupId: RESULT_GROUP_ID,
                    sessionId: 'owner-session',
                    request: {
                        actorPrincipalId: 'owner',
                        actorSessionId: 'owner-session',
                        requestId: 'handler-reconnect',
                        principalId: 'owner',
                        generationId: 'next-generation',
                        connectedAtEpochMs: harness.nowEpochMs + 1,
                        lastHeartbeatAtEpochMs: harness.nowEpochMs + 1,
                        expiresAtEpochMs: harness.nowEpochMs + 60_001
                    }
                }
            }
        });

        expect(result.left).toBeUndefined();
        expect(result.right).toMatchObject({ outcome: 'applied', causalRevision: { groupRevision: 1, presenceRevision: 1 } });
        expect((await harness.repository.findPresenceSession({ ...RESULT_GROUP_REF, sessionId: 'owner-session' }))?.generationId)
            .toBe('next-generation');
        expect(cache.peek(RESULT_GROUP_REF)).toEqual(before);
        expect(wakes).toBeGreaterThan(0);
    });

    it('leaves a stale predecessor attempt before write and re-enters through queue redelivery with fresh reads', async () => {
        const harness = await createResultHarness();
        const stale = await harness.repository.readSnapshot(RESULT_GROUP_REF);
        await seedOnlineOwner(harness);
        const attempts: number[] = [];
        const reader = new InboxQueueReader(harness.queue);
        let snapshotReads = 0;
        const service = new GroupStateInboxService({
            inboxQueueReader: reader,
            resourceInboxRepository: harness.queue,
            resourceInboxResultsRepository: harness.results,
            database: harness.database,
            groupStateService: {
                ...harness.groupStateService,
                read: async (command) => {
                    attempts.push(command.facts.attemptCount);
                    return await harness.groupStateService.read(command);
                }
            },
            resultReader: {
                readEvent: async () => undefined,
                readSnapshot: async () => {
                    snapshotReads += 1;
                    if (snapshotReads === 2) {
                        expect(attempts).toEqual([1]);
                        expect((await harness.repository.readSnapshot(RESULT_GROUP_REF))?.group.displayName).toBe('Before');
                        expect(await harness.repository.listEvents(RESULT_GROUP_REF)).toHaveLength(1);
                    }
                    return snapshotReads === 1 ? stale : await harness.repository.readSnapshot(RESULT_GROUP_REF);
                }
            }
        }, { serviceId: 'server-12345678' });
        const pending = service.processAuthenticatedGroupEntryUntilCompletion({
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'outer-result-retry',
            contextId: RESULT_GROUP_ID,
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: RESULT_GROUP_ID,
                request: {
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'outer-result-retry',
                    displayName: 'After'
                }
            }
        }, harness.sessions.owner);
        await waitForQueueEntry(harness.queue);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await new Promise((resolve) => setTimeout(resolve, 5));
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        const result = requireGroupStateResult(await pending);
        expect(attempts).toEqual([1, 2]);
        expect(result.result.snapshot).toMatchObject({ causalRevision: { groupRevision: 2, presenceRevision: 1 }, onlineMemberCount: 1 });
        expect(await harness.repository.readSnapshot(RESULT_GROUP_REF)).toEqual(result.result.snapshot);
    });

    it('rejects a valid-shaped result snapshot that differs from the canonical mutation', async () => {
        const harness = await createResultHarness();
        const command = await prepareUpdate(harness, { displayName: 'Wanted', requestId: 'wanted' });
        const input = await readResultInput(harness, command);
        const computed = requireComputedResult(computeGroupStateInboxMutation(input));
        const written = requireWrittenResult(computed);
        const snapshot = { ...written.result.snapshot, group: { ...written.result.snapshot.group, displayName: 'Never written' } };
        const tampered = {
            ...computed,
            durableResult: { ...written, result: { ...written.result, snapshot } }
        };

        expect(validateGroupStateInboxMutation({ ...input, computed: tampered })).toEqual(
            expect.arrayContaining([expect.objectContaining({ cause: expect.any(TypeError) })])
        );
        expect((await harness.repository.readSnapshot(RESULT_GROUP_REF))?.group.displayName).toBe('Before');
    });

    it('validates an equivalent result by value instead of requiring object identity', async () => {
        const harness = await createResultHarness();
        const command = await prepareUpdate(harness, { displayName: 'After', requestId: 'equivalent-result' });
        const input = await readResultInput(harness, command);
        const computed = requireComputedResult(computeGroupStateInboxMutation(input));
        const written = requireWrittenResult(computed);
        const copied = { ...computed, durableResult: structuredClone(written) };

        expect(validateGroupStateInboxMutation({ ...input, computed: copied })).toEqual([]);
    });

    it('archives an online group with canonical zero presence aggregates', async () => {
        const harness = await createResultHarness();
        await seedOnlineOwner(harness);
        const command = await prepareUpdate(harness, { status: 'archived', requestId: 'archive' });
        const input = await readResultInput(harness, command);
        const computed = requireComputedResult(computeGroupStateInboxMutation(input));
        expect(validateGroupStateInboxMutation({ ...input, computed })).toEqual([]);
        const snapshot = requireWrittenResult(computed).result.snapshot;

        expect(snapshot.activeSessions).toEqual([]);
        expect(snapshot.onlineMemberCount).toBe(0);
        expect(snapshot.memberCount).toBe(1);
        await writeComputed(harness, computed);
        expect(await harness.repository.readSnapshot(RESULT_GROUP_REF)).toEqual(snapshot);
    });

    it('uses canonical storage-key member order in both the result and durable snapshot', async () => {
        const harness = await createAuthorityHarness(['owner', 'Zed']);
        await createRoom(harness, RESULT_GROUP_ID, 'Before');
        const prepared = await harness.groupStateService.prepareMutation(
            mutationDescriptor({
                operation: 'joinGroup',
                scope: SCOPE,
                groupId: RESULT_GROUP_ID,
                request: { actorPrincipalId: 'Zed', actorSessionId: 'Zed-session', requestId: 'join-Zed' }
            }),
            harness.sessions.Zed
        );
        const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
        const input = await readResultInput(harness, command);
        const computed = requireComputedResult(computeGroupStateInboxMutation(input));
        expect(validateGroupStateInboxMutation({ ...input, computed })).toEqual([]);
        const snapshot = requireWrittenResult(computed).result.snapshot;

        expect(snapshot.members.map((member) => member.principalId)).toEqual(['Zed', 'owner']);
        await writeComputed(harness, computed);
        expect(await harness.repository.readSnapshot(RESULT_GROUP_REF)).toEqual(snapshot);
    });

    it('rejects a group-write snapshot whose presence predecessor advanced between reads', async () => {
        const harness = await createResultHarness();
        const currentSnapshot = await harness.repository.readSnapshot(RESULT_GROUP_REF);
        await seedOnlineOwner(harness);
        const command = await prepareUpdate(harness, { displayName: 'After', requestId: 'presence-race' });
        const input = { ...await readResultInput(harness, command), currentSnapshot };

        expect(computeGroupStateInboxMutation(input).left).toBeInstanceOf(GroupStateInboxResultReadConflictError);
        const fresh = await readResultInput(harness, command);
        const computed = requireComputedResult(computeGroupStateInboxMutation(fresh));
        expect(validateGroupStateInboxMutation({ ...fresh, computed })).toEqual([]);
        expect(requireWrittenResult(computed).result.snapshot).toMatchObject({
            causalRevision: { groupRevision: 2, presenceRevision: 1 },
            onlineMemberCount: 1
        });
    });

    it('rejects a no-op snapshot older than the read that established the no-op', async () => {
        const harness = await createResultHarness();
        const currentSnapshot = await harness.repository.readSnapshot(RESULT_GROUP_REF);
        const update = await prepareUpdate(harness, { displayName: 'After', requestId: 'first-update' });
        await writeComputed(harness, requireComputedResult(computeGroupStateInboxMutation(await readResultInput(harness, update))));
        const command = await prepareUpdate(harness, { displayName: 'After', requestId: 'noop-update' });
        const input = { ...await readResultInput(harness, command), currentSnapshot };

        expect(computeGroupStateInboxMutation(input).left).toBeInstanceOf(GroupStateInboxResultReadConflictError);
        const fresh = await readResultInput(harness, command);
        const computed = requireComputedResult(computeGroupStateInboxMutation(fresh));
        expect(validateGroupStateInboxMutation({ ...fresh, computed })).toEqual([]);
        expect(computed.mutation.outcome).toBe('no-op');
        expect(requireWrittenResult(computed).result.snapshot.group.displayName).toBe('After');
    });

    it('replays the recorded event while returning the current snapshot after a later mutation', async () => {
        const harness = await createResultHarness();
        const command = await prepareUpdate(harness, { displayName: 'After', requestId: 'replayed-update' });
        const first = requireComputedResult(computeGroupStateInboxMutation(await readResultInput(harness, command)));
        await writeComputed(harness, first);
        const later = await prepareUpdate(harness, { displayName: 'Latest', requestId: 'later-update' });
        await writeComputed(harness, requireComputedResult(computeGroupStateInboxMutation(await readResultInput(harness, later))));
        const recordedEvent = (await harness.repository.listEvents(RESULT_GROUP_REF)).find(
            (event) => event.requestId === 'replayed-update'
        );
        expect(recordedEvent).toBeDefined();
        const input = { ...await readResultInput(harness, command), recordedEvent };
        const computed = requireComputedResult(computeGroupStateInboxMutation(input));
        expect(validateGroupStateInboxMutation({ ...input, computed })).toEqual([]);

        expect(computed.mutation.outcome).toBe('replay');
        expect(requireWrittenResult(computed).result.event).toEqual(requireWrittenResult(first).result.event);
        expect(requireWrittenResult(computed).result.snapshot.group.displayName).toBe('Latest');
    });

    it('loads the recorded replay event through the point-read port before committing the durable result', async () => {
        const harness = await createResultHarness();
        const request: UpdateGroupRequest = {
            actorPrincipalId: 'owner',
            actorSessionId: 'owner-session',
            requestId: 'point-replay',
            displayName: 'After'
        };
        const descriptor = mutationDescriptor({
            operation: 'updateGroup',
            scope: SCOPE,
            groupId: RESULT_GROUP_ID,
            request
        });
        const prepared = await harness.groupStateService.prepareMutation(descriptor, harness.sessions.owner);
        const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
        const first = requireComputedResult(computeGroupStateInboxMutation(await readResultInput(harness, command)));
        await writeComputed(harness, first);
        const reader = new InboxQueueReader(harness.queue);
        const eventReads: string[] = [];
        const service = new GroupStateInboxService({
            inboxQueueReader: reader,
            resourceInboxRepository: harness.queue,
            resourceInboxResultsRepository: harness.results,
            database: harness.database,
            groupStateService: {
                ...harness.groupStateService,
                prepareAppInboxMutation: async () => prepared
            },
            resultReader: {
                readSnapshot: harness.groupStateService.readSnapshot,
                readEvent: async (ref, eventId) => {
                    eventReads.push(eventId);
                    return await harness.groupStateService.readEvent(ref, eventId);
                }
            }
        }, { serviceId: 'server-12345678' });
        const result = requireGroupStateResult(
            await processAuthenticated({
                service,
                reader,
                authority: harness.sessions.owner,
                input: {
                    type: AppInboxType.GROUP_UPDATE,
                    resourceId: 'point-replay-result',
                    contextId: RESULT_GROUP_ID,
                    senderId: 'owner',
                    data: { scope: SCOPE, groupId: RESULT_GROUP_ID, request }
                }
            })
        );

        expect(eventReads).toEqual([requireWrittenResult(first).result.event?.eventId]);
        expect(result.result.event).toEqual(requireWrittenResult(first).result.event);
        expect(await harness.repository.listEvents(RESULT_GROUP_REF)).toHaveLength(2);
    });

    it('rejects absent or wrongly scoped recorded events instead of silently dropping replay history', async () => {
        const harness = await createResultHarness();
        const command = await prepareUpdate(harness, { displayName: 'After', requestId: 'corrupt-event' });
        const first = requireComputedResult(computeGroupStateInboxMutation(await readResultInput(harness, command)));
        await writeComputed(harness, first);
        const event = requireWrittenResult(first).result.event;
        if (!event) {
            throw new TypeError('Expected a recorded update event.');
        }
        const input = await readResultInput(harness, command);
        const invalidEvents = [
            undefined,
            { ...event, eventId: 'another-event' },
            { ...event, workspaceId: 'another-workspace' },
            { ...event, groupId: 'another-group' },
            { ...event, requestId: 'another-request' },
            { ...event, snapshotVersion: event.snapshotVersion + 1 },
            { ...event, causalRevision: { ...event.causalRevision, presenceRevision: 1 } }
        ];

        for (const recordedEvent of invalidEvents) {
            expect(() => computeGroupStateInboxMutation({ ...input, recordedEvent })).toThrow();
        }
        const computed = requireComputedResult(computeGroupStateInboxMutation({ ...input, recordedEvent: event }));
        const written = requireWrittenResult(computed);
        expect(validateGroupStateInboxMutation({
            ...input,
            recordedEvent: event,
            computed: { ...computed, durableResult: { ...written, result: { ...written.result, event: null } } }
        })).toEqual(expect.arrayContaining([expect.objectContaining({ cause: expect.any(TypeError) })]));
        expect(await harness.repository.listEvents(RESULT_GROUP_REF)).toHaveLength(2);
    });

    it('returns only a receipt for reconnect without projecting a changed generation at the same revision', async () => {
        const harness = await createResultHarness();
        await seedOnlineOwner(harness);
        const prepared = await harness.groupStateService.prepareMutation(
            mutationDescriptor({
                operation: 'connectPresence',
                scope: SCOPE,
                groupId: RESULT_GROUP_ID,
                sessionId: 'owner-session',
                request: {
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'reconnect',
                    principalId: 'owner',
                    generationId: 'next-generation',
                    connectedAtEpochMs: harness.nowEpochMs + 1,
                    lastHeartbeatAtEpochMs: harness.nowEpochMs + 1,
                    expiresAtEpochMs: harness.nowEpochMs + 60_001
                }
            }),
            harness.sessions.owner
        );
        const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
        const input = await readResultInput(harness, command);
        const computed = requireComputedResult(computeGroupStateInboxMutation(input));
        expect(validateGroupStateInboxMutation({ ...input, computed })).toEqual([]);

        expect(computed.durableResult).not.toHaveProperty('result');
        expect(computed.durableResult).not.toHaveProperty('snapshot');
        expect(computed.durableResult).toMatchObject({
            outcome: 'applied',
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        await writeComputed(harness, computed);
        expect((await harness.repository.findPresenceEntry({ ...RESULT_GROUP_REF, sessionId: 'owner-session' }))?.value.generationId)
            .toBe('next-generation');
        expect((await harness.repository.findPresenceSummaryEntry(RESULT_GROUP_REF))?.value.activeSessions[0]?.generationId)
            .toBe('original-generation');
    });

    it('builds the complete result during compute and validates that same result before write', async () => {
        const harness = await createAuthorityHarness(['owner', 'alice', 'bob']);
        const groupId = 'computed-group-result-room';
        await createRoom(harness, groupId, 'Computed group result room');
        const staleSnapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId });
        if (!staleSnapshot) {
            throw new TypeError('Expected the owner snapshot before the first join.');
        }
        await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.alice,
            input: {
                type: AppInboxType.GROUP_JOIN,
                resourceId: 'join-alice-before-computed-result',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
                senderId: 'alice',
                data: {
                    scope: SCOPE,
                    groupId,
                    request: {
                        actorPrincipalId: 'alice',
                        actorSessionId: 'alice-session',
                        requestId: 'join-alice-before-computed-result'
                    }
                }
            }
        });
        const prepared = await harness.groupStateService.prepareMutation(
            mutationDescriptor({
                operation: 'joinGroup',
                scope: SCOPE,
                groupId,
                request: {
                    actorPrincipalId: 'bob',
                    actorSessionId: 'bob-session',
                    requestId: 'join-bob-computed-result'
                }
            }),
            harness.sessions.bob
        );
        const command = {
            authorityProof: prepared.authorityProof,
            descriptor: prepared.descriptor,
            command: prepared.command,
            facts: { ...prepared.facts, attemptCount: 1 }
        };
        const read = await harness.groupStateService.read(command);
        expect(
            computeGroupStateInboxMutation({
                currentSnapshot: staleSnapshot,
                command,
                read,
                recordedEvent: undefined
            }).left
        ).toBeInstanceOf(GroupStateInboxResultReadConflictError);

        const currentSnapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId });
        const computed = requireComputedResult(computeGroupStateInboxMutation({
            currentSnapshot,
            command,
            read,
            recordedEvent: undefined
        }));
        const before = JSON.stringify(computed);
        expect(validateGroupStateInboxMutation({
            currentSnapshot,
            recordedEvent: undefined,
            command,
            read,
            computed
        })).toEqual([]);

        expect(JSON.stringify(computed)).toBe(before);
        expect(() =>
            decodeGroupStateWritten(
                decodeJsonWireValue(
                    JSON.parse(JSON.stringify(computed.durableResult)),
                    'Computed group result'
                )
            )
        ).not.toThrow();
    });
});

async function createResultHarness(): Promise<AuthorityHarness> {
    const harness = await createAuthorityHarness(['owner']);
    await createRoom(harness, RESULT_GROUP_ID, 'Before');
    return harness;
}

async function prepareUpdate(harness: AuthorityHarness, request: UpdateGroupRequest): Promise<GroupStateMutationCommand> {
    const prepared = await harness.groupStateService.prepareMutation(
        mutationDescriptor({
            operation: 'updateGroup',
            scope: SCOPE,
            groupId: RESULT_GROUP_ID,
            request: { ...request, actorPrincipalId: 'owner', actorSessionId: 'owner-session' }
        }),
        harness.sessions.owner
    );
    return { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
}

async function readResultInput(harness: AuthorityHarness, command: GroupStateMutationCommand): Promise<ComputeGroupStateInboxMutationInput> {
    return {
        currentSnapshot: await harness.repository.readSnapshot(RESULT_GROUP_REF),
        command,
        read: await harness.groupStateService.read(command),
        recordedEvent: undefined
    };
}

function requireWrittenResult(computed: GroupStateInboxMutationComputed): GroupStateWritten | GroupJoinCodeWritten {
    if (!computed.durableResult || !('result' in computed.durableResult)) {
        throw new TypeError('Expected a group mutation result.');
    }
    return computed.durableResult;
}

async function writeComputed(harness: AuthorityHarness, computed: GroupStateInboxMutationComputed): Promise<void> {
    if (computed.mutation.outcome !== 'write') {
        throw new TypeError('Expected a state-changing mutation.');
    }
    const mutation = computed.mutation;
    await harness.database.begin(async (transaction) => {
        await harness.groupStateService.write(transaction, mutation);
    });
}

async function seedOnlineOwner(harness: AuthorityHarness): Promise<void> {
    const session: GroupPresenceSession = {
        ...RESULT_GROUP_REF,
        principalId: 'owner',
        sessionId: 'owner-session',
        generationId: 'original-generation',
        generationVersion: harness.nowEpochMs,
        connectedAtEpochMs: harness.nowEpochMs,
        lastHeartbeatAtEpochMs: harness.nowEpochMs,
        expiresAtEpochMs: harness.nowEpochMs + 60_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
    await harness.repository.putPresenceSession(session);
    const summary = await harness.repository.findPresenceSummaryEntry(RESULT_GROUP_REF);
    if (!summary) {
        throw new TypeError('Expected the initial presence summary.');
    }
    await harness.repository.updatePresenceSummary({
        ...summary.value,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        activeSessions: [session],
        activeSessionIds: ['owner-session'],
        activePrincipalIds: ['owner'],
        activeSessionCount: 1,
        activePrincipalCount: 1
    }, summary.entry.revision);
}

function requireComputedResult(
    computation: Either<GroupStateInboxResultReadConflictError, GroupStateInboxMutationComputed>
): GroupStateInboxMutationComputed {
    if (computation.right === undefined) {
        throw computation.left;
    }
    return computation.right;
}
