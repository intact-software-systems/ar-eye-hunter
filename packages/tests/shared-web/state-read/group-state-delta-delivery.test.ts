import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { computeClientStateSyncEntries, computeGroupStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
    BrowserStateCacheLifecycle,
    type StateCacheInboxSource
} from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import {
    createDeltaEnvelopeFixture,
    createDeltaEnvelopeFixtureGroupSnapshot
} from '../../shared-server/rallar-system/group-state/presence/group-state-delta-envelope-fixtures.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };

beforeEach(() => {
    configureTestCacheRepositories();
    configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    vi.stubGlobal('localStorage', { getItem: () => null });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('produced group delta delivery through durable AL admission', () => {
    it.each(['fresh', 'continuing'] as const)('adopts a new group revision with %s admission stores', async (history) => {
        const receiver = new GroupDeltaReceiver();
        const predecessor = toSnapshot(7, 4, 4);
        const resulting = toSnapshot(8, 4, 5);
        await receiver.hydrate(history === 'fresh' ? predecessor : toSnapshot(7, 0, 4));
        if (history === 'continuing') {
            for (let presence = 1; presence <= 4; presence += 1) {
                const next = toSnapshot(7, presence, 4);
                await receiver.receive(toProducedMessage(toSnapshot(7, presence - 1, 4), next));
                await expect.poll(() => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(next.group)).toEqual(next);
            }
        }
        const earlierDeliveries = receiver.delivered.length;

        const message = toProducedMessage(predecessor, resulting);
        const admitted = await receiver.receive(message);

        expect(admitted.right).toEqual({ kind: 'admitted' });
        await expect.poll(() => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group), {
            timeout: 500
        }).toEqual(resulting);
        expect(receiver.delivered.slice(earlierDeliveries)).toEqual([message.id.msgId]);
        // Canonical causal deltas must not request nonexistent AL sequence predecessors.
        for (const message of receiver.controls) {
            const control = decodeALControlMessage(message).fold((rejection) => {
                throw new Error(rejection.message);
            }, (parsed) => parsed);
            if (control.type !== 'ack') {
                expect(control.payload.reason).not.toBe('gap');
                expect(control.payload.reason).not.toBe('missing-seq');
            }
        }
    });

    it('repairs a genuine causal gap at its resulting floor, then ignores stale and equal deltas', async () => {
        const receiver = new GroupDeltaReceiver();
        const cached = toSnapshot(7, 4, 4);
        const missing = toSnapshot(8, 4, 5);
        const newest = toSnapshot(9, 5, 6);
        await receiver.hydrate(cached);
        const requests: string[] = [];
        vi.stubGlobal('fetch', async (url: string | URL | Request) => {
            requests.push(String(url));
            return new Response(JSON.stringify(newest), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': '9',
                    'rallar-presence-revision': '5'
                }
            });
        });

        await receiver.receive(toProducedMessage(missing, newest));
        await expect.poll(() => receiver.delivered.length).toBe(1);
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(newest.group)).toEqual(newest);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain('/groups/room-1?minGroupRevision=9&minPresenceRevision=5');

        await receiver.receive(toProducedMessage(cached, missing));
        const equal = toProducedMessage(newest, newest);
        await receiver.receive({ ...equal, id: { ...equal.id, msgId: 'equal-summary' } });
        await expect.poll(() => receiver.delivered.length).toBe(3);
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(newest.group)).toEqual(newest);
        // Stale/equal causal input must not trigger another authority acquisition.
        expect(requests).toHaveLength(1);
    });

    it('keeps a valid foreign-scope delta out of the current browser cache', async () => {
        const receiver = new GroupDeltaReceiver();
        const cached = toSnapshot(7, 4, 4);
        await receiver.hydrate(cached);
        const foreign = toForeignScope(toSnapshot(8, 4, 5));
        const message = toProducedMessage(toForeignScope(cached), foreign);

        await receiver.receive(message);
        await expect.poll(() => receiver.delivered).toEqual([message.id.msgId]);

        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(cached.group)).toEqual(cached);
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(foreign.group)).toBeUndefined();
    });

    it('rejects a peer claiming server provenance before cache delivery', async () => {
        const receiver = new GroupDeltaReceiver();
        const cached = toSnapshot(7, 4, 4);
        await receiver.hydrate(cached);

        const result = await receiver.receive(toProducedMessage(cached, toSnapshot(8, 4, 5)), {
            kind: 'ws-client',
            peerId: 'untrusted-peer'
        });

        expect(result.left?.code).toBe('unauthorized');
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(cached.group)).toEqual(cached);
    });

    it('keeps client scalar events buffered until their actual contiguous predecessor arrives', async () => {
        const receiver = new GroupDeltaReceiver();
        const second = toProducedClientMessage(2);
        const first = toProducedClientMessage(1);

        expect(second.ordering).toMatchObject({ epoch: 0, seq: 2 });
        const accepted = await receiver.receive(second);
        expect(accepted.right).toEqual({ kind: 'admitted' });
        await receiver.receive(first);

        await expect.poll(() => receiver.delivered).toEqual([first.id.msgId, second.id.msgId]);
    });
});

function toForeignScope(snapshot: GroupSnapshot): GroupSnapshot {
    const scope = { applicationId: 'foreign-app', workspaceId: 'foreign-workspace' };
    return {
        ...snapshot,
        group: { ...snapshot.group, ...scope },
        members: snapshot.members.map((member) => ({ ...member, ...scope })),
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, ...scope }))
    };
}

function toProducedClientMessage(revision: number): ALMessage {
    const nowMs = Date.now();
    const entries = computeClientStateSyncEntries({
        commandId: `client-${revision}`,
        aggregateRef: { ...SCOPE, principalId: 'alice' },
        acceptedCausalRevision: revision,
        audience: { kind: 'principal', ...SCOPE, resourceId: 'alice' },
        createdAtEpochMs: nowMs,
        expireAtEpochMs: nowMs + 30_000,
        effects: [{
            effectKind: 'principal-state',
            payloadKind: 'event',
            payload: {
                ...SCOPE,
                principalId: 'alice',
                eventId: `client-event-${revision}`,
                eventType: 'principal-updated',
                snapshotVersion: revision,
                occurredAtEpochMs: nowMs,
                actor: { kind: 'service', serviceId: 'test' },
                reason: null,
                traceId: null,
                requestId: null,
                clientInstanceId: null,
                sessionId: null,
                payload: {}
            }
        }]
    }, 'server-1');
    const entry = entries[0];
    if (!entry) {
        throw new Error('Client event did not produce an envelope');
    }
    return decodePersistedALMessage(entry.resource);
}

/** Actual durable admission dispatches into the callback installed by the browser cache owner. */
class GroupDeltaReceiver implements StateCacheInboxSource {
    readonly delivered: string[] = [];
    readonly controls: ALMessage[] = [];
    private readonly cache = new BrowserStateCacheLifecycle();
    private readonly manager: BrowserStateCacheLifecycle.RtcGroupPort = {
        notifyClientPresenceChanged: async () => {},
        notifyOverlayTopologyChanged: async () => {},
        acceptGroupUpdate: async () => {},
        ensureAllGroupsConnected: async () => {},
        delete: async () => false,
        has: () => false
    };
    private readonly clientData = { clientId: 'alice', sessionId: 'alice-session', isOnline: true };
    private callback: OnMessageCallback | undefined;
    private readonly inbound: ALInboundMessageRuntime;

    constructor() {
        this.cache.initialise({
            inbox: this,
            webRtcGroupManager: this.manager,
            clientData: this.clientData,
            options: { scope: SCOPE }
        });
        this.inbound = new ALInboundMessageRuntime({
            carrier: 'ws',
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'alice-session',
                toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'group-delta-inbox')
            }),
            planIncomingMessage: (message, source, observations) =>
                planALMessageHandling(message, {
                    ...observations,
                    selfPeerId: 'alice-session',
                    fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                    groupMemberPeerIds: ['alice-session', 'bob-session']
                }),
            dispatchInboxEntry: async (entry) => {
                if (!this.callback) {
                    throw new Error('Browser cache subscription was not installed');
                }
                const message = decodePersistedALMessage(entry.resource);
                await this.callback.onMessage(message, entry);
                this.delivered.push(message.id.msgId);
            },
            sendControlMessages: async (messages) => {
                this.controls.push(...messages);
            },
            diagnostics: undefined
        });
        onTestFinished(() => this.inbound.dispose());
    }

    onAllInboxMessagesDo(callback: OnMessageCallback): void {
        this.callback = callback;
    }

    async hydrate(snapshot: GroupSnapshot): Promise<void> {
        await this.cache.hydrate({
            webRtcGroupManager: this.manager,
            clientData: this.clientData,
            clientSnapshots: [],
            groupSnapshots: [snapshot],
            options: { scope: SCOPE }
        });
    }

    async receive(message: ALMessage, source: ALInboundMessageRuntime.Source = { kind: 'trusted-server' }) {
        await this.inbound.ready();
        return await this.inbound.admitIncomingMessage(message, source);
    }
}

function toSnapshot(groupRevision: number, presenceRevision: number, layoutVersion: number): GroupSnapshot {
    const snapshot = createDeltaEnvelopeFixtureGroupSnapshot();
    return {
        ...snapshot,
        causalRevision: { groupRevision, presenceRevision },
        group: {
            ...snapshot.group,
            snapshotVersion: groupRevision,
            presenceVersion: presenceRevision,
            acceptedLayoutIdentity: {
                groupRevision: groupRevision - 1,
                presenceRevision,
                version: layoutVersion,
                state: 'active'
            }
        }
    };
}

function toProducedMessage(predecessor: GroupSnapshot, resulting: GroupSnapshot): ALMessage {
    const initial = createDeltaEnvelopeFixture({ audienceSessionIds: ['alice-session', 'bob-session'] });
    const envelope: GroupStateDeltaEnvelope = {
        ...initial,
        event: {
            ...initial.event,
            applicationId: resulting.group.applicationId,
            workspaceId: resulting.group.workspaceId,
            eventId: `event-${resulting.causalRevision.groupRevision}-${resulting.causalRevision.presenceRevision}`,
            eventType: 'group-updated',
            snapshotVersion: resulting.group.snapshotVersion,
            causalRevision: resulting.causalRevision
        },
        predecessorCausalRevision: predecessor.causalRevision,
        resultingCausalRevision: resulting.causalRevision,
        group: resulting.group,
        sessions: resulting.activeSessions
    };
    const nowMs = Date.now();
    const entries = computeGroupStateSyncEntries({
        commandId: envelope.event.eventId,
        aggregateRef: resulting.group,
        acceptedCausalRevision: resulting.causalRevision,
        audience: {
            kind: 'group',
            applicationId: resulting.group.applicationId,
            workspaceId: resulting.group.workspaceId,
            resourceId: resulting.group.groupId
        },
        createdAtEpochMs: nowMs,
        expireAtEpochMs: nowMs + 30_000,
        effects: [{ effectKind: 'member-state', payloadKind: 'delta-envelope', payload: envelope }]
    }, 'server-1');
    const entry = entries[0];
    if (!entry || entries.length !== 1) {
        throw new Error('Group delta must produce one envelope');
    }
    return decodePersistedALMessage(entry.resource);
}
