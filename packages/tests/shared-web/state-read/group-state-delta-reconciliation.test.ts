import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { computeGroupStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { browserStateCacheLifecycle, type BrowserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { setBrowserStateReadDiagnosticsSink, type BrowserStateReadDiagnosticEvent } from '@shared-web/browser/state-read/diagnostics.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics, type ClientInfo } from '@shared/api/api-config.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    AuditStamp,
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createTestGroup } from '../../create-test-group.ts';

describe('browser group-state delta reconciliation', () => {
    const diagnostics: BrowserStateReadDiagnosticEvent[] = [];

    beforeEach(() => {
        configureTestCacheRepositories();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
        vi.stubGlobal('localStorage', { getItem: () => null });
        diagnostics.length = 0;
        setBrowserStateReadDiagnosticsSink((event) => diagnostics.push(event));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setBrowserStateReadDiagnosticsSink(undefined);
    });

    it('applies a delta at the cached predecessor and materializes the server-canonical snapshot', async () => {
        const runtime = new StateCacheRuntime();
        const predecessor = createDeltaGroupSnapshot({
            groupId: 'room-delta-apply',
            memberPrincipalIds: ['m-alpha', 'm-charlie'],
            activePrincipalIds: ['m-alpha', 'm-charlie'],
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        const resulting = createDeltaGroupSnapshot({
            groupId: 'room-delta-apply',
            memberPrincipalIds: ['m-alpha', 'm-bravo', 'm-charlie'],
            activePrincipalIds: ['m-alpha', 'm-charlie'],
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        const joinedMember = resulting.members.find(
            (member) => member.principalId === 'm-bravo'
        );
        const envelope = createDeltaEnvelope({
            resulting,
            predecessorCausalRevision: predecessor.causalRevision,
            members: joinedMember ? [joinedMember] : []
        });
        await runtime.hydrate([predecessor]);
        runtime.manager.acceptGroupUpdate.mockClear();
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(envelope);

        // The joined member lands mid-roster: canonical storage-key order, not
        // append order, and the whole snapshot equals the server assembly.
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group)
        ).toEqual(resulting);
        expect(runtime.manager.acceptGroupUpdate).toHaveBeenCalledWith(resulting);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deltaApplyResults()).toEqual(['applied']);

        // A trailing equal-tuple snapshot must decide as a duplicate against
        // the materialized delta result.
        await expect(runtime.receiveSnapshotMessage(resulting)).resolves.toBeUndefined();
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group)
        ).toEqual(resulting);
    });

    it('resolves equal-resulting and summary no-op envelopes as typed no-ops before the apply rule', async () => {
        const runtime = new StateCacheRuntime();
        const cached = createDeltaGroupSnapshot({
            groupId: 'room-delta-noop',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        const duplicate = createDeltaEnvelope({
            resulting: cached,
            predecessorCausalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        const summaryNoOp = createDeltaEnvelope({
            resulting: cached,
            predecessorCausalRevision: cached.causalRevision
        });
        await runtime.hydrate([cached]);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(duplicate);
        await runtime.receiveDeltaMessage(summaryNoOp);

        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(cached.group)
        ).toEqual(cached);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deltaApplyResults()).toEqual(['no-op', 'no-op']);
    });

    it.each(
        [
            ['newer event first', ['group-updated', 'member-role-changed']],
            ['older event first', ['member-role-changed', 'group-updated']]
        ] as const
    )(
        'converges when delayed summary envelopes share a resulting revision: %s',
        async (_description, deliveryOrder) => {
            const runtime = new StateCacheRuntime();
            const predecessor = createDeltaGroupSnapshot({
                groupId: 'room-delayed-summary',
                memberPrincipalIds: ['m-alpha', 'm-bravo'],
                activePrincipalIds: ['m-alpha', 'm-bravo'],
                causalRevision: { groupRevision: 2, presenceRevision: 3 }
            });
            const resultingWithoutRole = createDeltaGroupSnapshot({
                groupId: 'room-delayed-summary',
                memberPrincipalIds: ['m-alpha', 'm-bravo'],
                activePrincipalIds: ['m-alpha', 'm-bravo'],
                causalRevision: { groupRevision: 4, presenceRevision: 4 }
            });
            const adminMember = {
                ...resultingWithoutRole.members[1]!,
                role: 'admin' as const
            };
            const resulting = {
                ...resultingWithoutRole,
                members: [resultingWithoutRole.members[0]!, adminMember]
            };
            const envelopes = {
                'group-updated': createDeltaEnvelope({
                    resulting,
                    predecessorCausalRevision: predecessor.causalRevision,
                    eventCausalRevision: { groupRevision: 4, presenceRevision: 3 },
                    eventType: 'group-updated'
                }),
                'member-role-changed': createDeltaEnvelope({
                    resulting,
                    predecessorCausalRevision: resulting.causalRevision,
                    eventCausalRevision: { groupRevision: 3, presenceRevision: 3 },
                    eventType: 'member-role-changed',
                    members: [adminMember]
                })
            } as const;
            await runtime.hydrate([predecessor]);
            const fetchMock = vi.fn<typeof fetch>(
                async () => groupSnapshotResponse(resulting)
            );
            vi.stubGlobal('fetch', fetchMock);

            for (const eventType of deliveryOrder) {
                await runtime.receiveDeltaMessage(envelopes[eventType]);
            }

            expect(
                groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group)
            ).toEqual(resulting);
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(deltaApplyResults()).toContain('gap-pull');
        }
    );

    it('applies a coalesced batch through its first delta and takes the sibling deltas as applied', async () => {
        const runtime = new StateCacheRuntime();
        const batch = createCoalescedBatch('room-coalesced-batch');
        await runtime.hydrate([batch.predecessor]);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        for (const envelope of batch.envelopes) {
            await runtime.receiveDeltaMessage(envelope);
        }

        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(batch.resulting.group)
        ).toEqual(batch.resulting);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deltaApplyResults()).toEqual(['applied', 'no-op', 'no-op', 'no-op']);
    });

    it('pulls at the floor for a coalesced batch when the cache is behind its predecessor', async () => {
        const runtime = new StateCacheRuntime();
        const batch = createCoalescedBatch('room-coalesced-stale');
        const stale = createDeltaGroupSnapshot({
            groupId: 'room-coalesced-stale',
            memberPrincipalIds: ['m-alpha', 'm-bravo'],
            activePrincipalIds: [],
            causalRevision: { groupRevision: 5, presenceRevision: 0 }
        });
        await runtime.hydrate([stale]);
        const fetchMock = vi.fn<typeof fetch>(
            async () => groupSnapshotResponse(batch.resulting)
        );
        vi.stubGlobal('fetch', fetchMock);

        for (const envelope of batch.envelopes) {
            await runtime.receiveDeltaMessage(envelope);
        }

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            '/groups/room-coalesced-stale?minGroupRevision=6&minPresenceRevision=4'
        );
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(batch.resulting.group)
        ).toEqual(batch.resulting);
        expect(deltaApplyResults()).toEqual(['gap-pull', 'no-op', 'no-op', 'no-op']);
    });

    it('pulls at the resulting floor when the cached snapshot is dominated but not the predecessor', async () => {
        const runtime = new StateCacheRuntime();
        const stale = createDeltaGroupSnapshot({
            groupId: 'room-delta-gap',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        const resulting = createDeltaGroupSnapshot({
            groupId: 'room-delta-gap',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 3 }
        });
        const envelope = createDeltaEnvelope({
            resulting,
            predecessorCausalRevision: { groupRevision: 2, presenceRevision: 2 }
        });
        await runtime.hydrate([stale]);
        const fetchMock = vi.fn<typeof fetch>(
            async () => groupSnapshotResponse(resulting)
        );
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(envelope);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            '/groups/room-delta-gap?minGroupRevision=2&minPresenceRevision=3'
        );
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group)
        ).toEqual(resulting);
        expect(deltaApplyResults()).toEqual(['gap-pull']);
    });

    it('resolves an out-of-order envelope after a newer snapshot as a no-op', async () => {
        const runtime = new StateCacheRuntime();
        const newer = createDeltaGroupSnapshot({
            groupId: 'room-delta-order',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 3 }
        });
        const older = createDeltaGroupSnapshot({
            groupId: 'room-delta-order',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 2 }
        });
        const outOfOrder = createDeltaEnvelope({
            resulting: older,
            predecessorCausalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        await runtime.hydrate([newer]);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(outOfOrder);

        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(newer.group)
        ).toEqual(newer);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deltaApplyResults()).toEqual(['no-op']);
    });

    it('pulls at the floor when an active session record is missing from the delta and the cache', async () => {
        const runtime = new StateCacheRuntime();
        const cached = createDeltaGroupSnapshot({
            groupId: 'room-delta-session',
            memberPrincipalIds: ['m-alpha', 'm-bravo'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        const resulting = createDeltaGroupSnapshot({
            groupId: 'room-delta-session',
            memberPrincipalIds: ['m-alpha', 'm-bravo'],
            activePrincipalIds: ['m-alpha', 'm-bravo'],
            causalRevision: { groupRevision: 1, presenceRevision: 2 }
        });
        // Service-driven transition: complete identity set, no session slice.
        const envelope = createDeltaEnvelope({
            resulting,
            predecessorCausalRevision: cached.causalRevision,
            eventType: 'session-connected',
            sessions: []
        });
        await runtime.hydrate([cached]);
        const fetchMock = vi.fn<typeof fetch>(
            async () => groupSnapshotResponse(resulting)
        );
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(envelope);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            '/groups/room-delta-session?minGroupRevision=1&minPresenceRevision=2'
        );
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group)
        ).toEqual(resulting);
        expect(deltaApplyResults()).toEqual(['gap-pull']);
    });

    function deltaApplyResults(): readonly string[] {
        return diagnostics
            .filter((event) => event.operation === 'delta-apply')
            .map((event) => event.result);
    }
});

class StateCacheRuntime {
    readonly manager = {
        notifyClientPresenceChanged: vi.fn(async () => undefined),
        notifyOverlayTopologyChanged: vi.fn(async () => undefined),
        acceptGroupUpdate: vi.fn(async () => undefined),
        ensureAllGroupsConnected: vi.fn(async () => undefined),
        delete: vi.fn(async () => false),
        has: vi.fn(() => false)
    } satisfies BrowserStateCacheLifecycle.RtcGroupPort;
    private readonly clientData: ClientInfo = {
        clientId: 'm-alpha',
        sessionId: 'session-m-alpha',
        isOnline: true
    };
    private onInboxMessage: ((message: ALMessage) => Promise<void>) | undefined;
    constructor() {
        browserStateCacheLifecycle.initialise({
            inbox: {
                onAllInboxMessagesDo: (callback) => {
                    this.onInboxMessage = async (message) => {
                        await callback.onMessage(message, QueueBoxUtilities.toResourceEntryFromMsg(message, 'TEST_INBOX', Temporal.Now.instant()));
                    };
                }
            },
            webRtcGroupManager: this.manager,
            clientData: this.clientData
        });
    }
    private async receiveMessage(message: ALMessage): Promise<void> {
        if (!this.onInboxMessage) {
            throw new Error('Fixture inbox subscription was not installed.');
        }
        await this.onInboxMessage(message);
    }
    hydrate = async (snapshots: readonly GroupSnapshot[]): Promise<void> => {
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: this.manager,
            clientData: this.clientData,
            clientSnapshots: [],
            groupSnapshots: snapshots
        });
    };
    receiveDeltaMessage = async (envelope: GroupStateDeltaEnvelope): Promise<void> => {
        await this.receiveMessage(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(
                    AppTopics.groupStateEvent,
                    envelope.event.groupId,
                    envelope.event.eventId
                ),
                'all',
                AppTopics.groupStateEvent,
                envelope
            )
        );
    };
    receiveSnapshotMessage = async (snapshot: GroupSnapshot): Promise<void> => {
        const createdAtEpochMs = Date.now();
        const entries = computeGroupStateSyncEntries({
            traceId: 'trace-group-state-delta-reconciliation',
            commandId: `snapshot-${snapshot.group.groupId}`,
            aggregateRef: snapshot.group,
            acceptedCausalRevision: snapshot.causalRevision,
            audience: {
                kind: 'group',
                applicationId: snapshot.group.applicationId,
                workspaceId: snapshot.group.workspaceId,
                resourceId: snapshot.group.groupId
            },
            createdAtEpochMs,
            expireAtEpochMs: createdAtEpochMs + 30_000,
            effects: [{ effectKind: 'member-state', payloadKind: 'snapshot', payload: snapshot }]
        }, 'server-1');
        for (const entry of entries) {
            await this.receiveMessage(decodePersistedALMessage(entry.resource));
        }
    };
}

interface CoalescedBatch {
    readonly predecessor: GroupSnapshot;
    readonly resulting: GroupSnapshot;
    readonly envelopes: readonly GroupStateDeltaEnvelope[];
}

/**
 * One presence-summary expansion of four pending events: two connects at the
 * cached group revision, a join that bumps it, and the joiner's connect. Every
 * delta is stamped predecessor -> resulting; the first carries the batch's
 * merged slice and the later ones their own event's slice.
 */
function createCoalescedBatch(groupId: string): CoalescedBatch {
    const predecessor = createDeltaGroupSnapshot({
        groupId,
        memberPrincipalIds: ['m-alpha', 'm-bravo'],
        activePrincipalIds: [],
        causalRevision: { groupRevision: 5, presenceRevision: 1 }
    });
    const resulting = createDeltaGroupSnapshot({
        groupId,
        memberPrincipalIds: ['m-alpha', 'm-bravo', 'm-charlie'],
        activePrincipalIds: ['m-alpha', 'm-bravo', 'm-charlie'],
        causalRevision: { groupRevision: 6, presenceRevision: 4 }
    });
    const joined = resulting.members.filter((member) => member.principalId === 'm-charlie');
    const sessionOf = (principalId: string) => resulting.activeSessions.filter((session) => session.principalId === principalId);
    const shared = { resulting, predecessorCausalRevision: predecessor.causalRevision };
    return {
        predecessor,
        resulting,
        envelopes: [
            createDeltaEnvelope({
                ...shared,
                eventId: 'connect-alpha',
                eventType: 'session-connected',
                eventCausalRevision: { groupRevision: 5, presenceRevision: 2 },
                members: joined,
                sessions: resulting.activeSessions
            }),
            createDeltaEnvelope({
                ...shared,
                eventId: 'connect-bravo',
                eventType: 'session-connected',
                eventCausalRevision: { groupRevision: 5, presenceRevision: 3 },
                sessions: sessionOf('m-bravo')
            }),
            createDeltaEnvelope({
                ...shared,
                eventId: 'join-charlie',
                eventType: 'member-joined',
                eventCausalRevision: { groupRevision: 6, presenceRevision: 3 },
                members: joined
            }),
            createDeltaEnvelope({
                ...shared,
                eventId: 'connect-charlie',
                eventType: 'session-connected',
                eventCausalRevision: { groupRevision: 6, presenceRevision: 4 },
                sessions: sessionOf('m-charlie')
            })
        ]
    };
}

interface DeltaGroupSnapshotInput {
    readonly groupId: string;
    // Both principal lists are given in the server's canonical order: members
    // in storage-key (encoded principal id) order, sessions in the summary's
    // identity-set order.
    readonly memberPrincipalIds: readonly string[];
    readonly activePrincipalIds: readonly string[];
    readonly causalRevision: GroupStateCausalRevision;
}

function createDeltaGroupSnapshot(input: DeltaGroupSnapshotInput): GroupSnapshot {
    const ownerPrincipalId = input.memberPrincipalIds[0];
    if (!ownerPrincipalId) {
        throw new TypeError('Delta group fixture requires an owner');
    }
    return {
        causalRevision: input.causalRevision,
        group: createTestGroup({
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            groupId: input.groupId,
            displayName: input.groupId,
            snapshotVersion: input.causalRevision.groupRevision,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: input.causalRevision.presenceRevision,
            created: deltaAuditStamp(),
            updated: deltaAuditStamp(),
            activeMemberCount: input.memberPrincipalIds.length,
            ownerPrincipalId
        }),
        members: input.memberPrincipalIds.map((principalId) => createDeltaGroupMember(input.groupId, principalId, principalId === ownerPrincipalId)),
        activeSessions: input.activePrincipalIds.map((principalId) => createDeltaGroupSession(input.groupId, principalId)),
        memberCount: input.memberPrincipalIds.length,
        onlineMemberCount: input.activePrincipalIds.length
    };
}

interface DeltaEnvelopeInput {
    readonly resulting: GroupSnapshot;
    readonly predecessorCausalRevision: GroupStateCausalRevision;
    readonly eventId?: string;
    readonly eventCausalRevision?: GroupStateCausalRevision;
    readonly eventType?: GroupEvent['eventType'];
    readonly members?: readonly GroupMember[];
    readonly sessions?: readonly GroupPresenceSession[];
}

function createDeltaEnvelope(input: DeltaEnvelopeInput): GroupStateDeltaEnvelope {
    const { resulting } = input;
    const activeSessionIds = resulting.activeSessions.map((session) => session.sessionId);
    const envelope: GroupStateDeltaEnvelope = {
        event: {
            applicationId: resulting.group.applicationId,
            workspaceId: resulting.group.workspaceId,
            groupId: resulting.group.groupId,
            eventId: input.eventId ??
                `event-${resulting.group.groupId}-g${resulting.causalRevision.groupRevision}-p${resulting.causalRevision.presenceRevision}`,
            eventType: input.eventType ?? 'member-joined',
            snapshotVersion: resulting.group.snapshotVersion,
            causalRevision: input.eventCausalRevision ?? resulting.causalRevision,
            occurredAtEpochMs: 1,
            actor: { kind: 'service', serviceId: 'summary-worker' },
            reason: null,
            traceId: null,
            requestId: 'request-delta',
            payload: {}
        },
        predecessorCausalRevision: input.predecessorCausalRevision,
        resultingCausalRevision: resulting.causalRevision,
        members: input.members ?? [],
        removedMemberPrincipalIds: [],
        sessions: input.sessions ?? [],
        removedSessionIds: [],
        activeSessionIds,
        group: resulting.group,
        memberCount: resulting.memberCount,
        onlineMemberCount: resulting.onlineMemberCount,
        audienceSessionIds: activeSessionIds
    };
    // Fixture self-check: hand-built envelopes must satisfy the landed wire
    // validator so the tests mirror the server's emission semantics.
    validateGroupStateDeltaEnvelope(envelope);
    return envelope;
}

function createDeltaGroupMember(
    groupId: string,
    principalId: string,
    isOwner: boolean
): GroupMember {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId,
        principalId,
        role: isOwner ? 'owner' : 'member',
        status: 'active',
        joined: deltaAuditStamp(),
        updated: deltaAuditStamp(),
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

function createDeltaGroupSession(
    groupId: string,
    principalId: string
): GroupPresenceSession {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId,
        sessionId: `session-${principalId}`,
        principalId,
        generationId: `generation-${principalId}`,
        connectionGenerationId: `ws-generation-${principalId}`,
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function deltaAuditStamp(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function groupSnapshotResponse(snapshot: GroupSnapshot): Response {
    return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(snapshot.causalRevision.groupRevision),
            'rallar-presence-revision': String(snapshot.causalRevision.presenceRevision)
        }
    });
}
