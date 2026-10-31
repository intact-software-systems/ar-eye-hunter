// @vitest-environment happy-dom

import {
    beforeEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    createBrowserALVolatileInboundRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import {
    newALBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { createPassThroughALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    configureGroupStateSnapshotRepository,
    removeGroupStateSnapshotByRef,
    setGroupStateSnapshot
} from '@shared/repository/group-state-snapshots-repository.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type WsQueueBoxClientService from '@shared/services/ws-queue-box-client-service.ts';
import { createScriptedTransportFaultPort, type ScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';
import { GroupBarrierRepository } from '../../shared-server/rallar-system/group-state/group-state-concurrency-test-runtime.ts';
import { createTestAuthSession, createTestGroupStateRuntime } from '../../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import { convergeSummaryForTest } from '../../shared-server/rallar-system/group-state/presence/group-presence-test-runtime.ts';
import { captureOutboundWorkRunnable } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { createDefaultVolatileSessionBudget } from '../default-volatile-session-budget.ts';

interface OpenRecoveryOwnerInput {
    readonly sessionId: string;
    readonly principalId: string;
    readonly faults: ScriptedTransportFaultPort;
    readonly beforeOpenDelayMs: number;
}

interface RecoveryOwner {
    readonly engine: InboxOutboxEngine;
    readonly native: TestWebSocket;
    readonly service: WsQueueBoxClientService;
    readonly settlements: readonly ALDeliverySettlement[];
    drain(): Promise<void>;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    // Advancing retry/TTL timers must advance epoch reads without replacing native Date values.
    vi.spyOn(Date, 'now').mockImplementation(() => vi.getMockedSystemTime()!.getTime());
    vi.stubGlobal('localStorage', new TestAuthStorage());
    configureGroupStateSnapshotRepository({ ttlMs: 60_000 });

    onTestFinished(() => {
        clearSession();
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });
});

it('a fresh WS owner recovers the same pending IndexedDB original with a fresh fault map and no second enqueue', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const sessionId = crypto.randomUUID();
    const oldFaults = createScriptedTransportFaultPort();
    oldFaults.inject({
        faultId: 'until-document-ends',
        carrier: 'ws',
        action: 'not-ready',
        remaining: 'until-cleared',
        match: { typeId: 'reload.original', msgId: undefined, controlType: undefined }
    });
    const old = await openRecoveryOwner({ sessionId, principalId: sessionId, faults: oldFaults, beforeOpenDelayMs: 0 });
    const original = {
        ...newALUnicastMessage(sessionId, { topicId: 'reload', contextId: 'room', resourceId: 'one' }, 'receiver', 'reload.original', { original: true }, {
            ttlMs: 30_000,
            qos: { durability: { algo: 'local-outbox' } }
        }),
        delivery: { reliability: 'at-least-once', ack: 'none' }
    } as const;
    expect((await old.service.enqueueOutboxIfAbsent(original)).verdict).toMatchObject({ kind: 'admitted', durable: true });
    await old.drain();
    expect(old.native.sent).toEqual([]);
    const retained = await Promise.all((await old.service.outbox.getAllKeys()).map((key) => old.service.outbox.getItem(key)));
    expect(retained.some((entry) => entry && (entry.status === EntityStatus.NEW || entry.status === EntityStatus.RETRY))).toBe(true);
    const retiring = await Promise.allSettled([old.service.close(), old.engine.stop()]);
    const retirementFailure = retiring.find((outcome) => outcome.status === 'rejected');
    if (retirementFailure?.status === 'rejected') {
        throw retirementFailure.reason;
    }

    // Recreate both runtime store wrappers and transport owners while keeping the same real IndexedDB namespace/session.
    const freshFaults = createScriptedTransportFaultPort();
    const fresh = await openRecoveryOwner({ sessionId, principalId: sessionId, faults: freshFaults, beforeOpenDelayMs: 100 });
    await fresh.drain();
    await fresh.drain();
    expect(old.native.sent).toEqual([]);
    expect(fresh.native.sent.map((frame) => decodePersistedALMessage(frame).id.msgId)).toEqual([original.id.msgId]);
    expect(fresh.native.sent.map((frame) => decodePersistedALMessage(frame).id.senderId)).toEqual([sessionId]);
});

it('retains the restored room original until actual scoped presence authorizes its sender', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const sessionId = crypto.randomUUID();
    const principalId = 'reload-sender';
    const scope = { applicationId: 'reload-app', workspaceId: 'reload-workspace' };
    const roomRef = { ...scope, groupId: crypto.randomUUID() };
    writeSession(createTestAuthSession(principalId, sessionId));
    configureGroupStateSnapshotRepository({ ttlMs: 60_000 });
    const runtimeRepository = new GroupBarrierRepository();
    const authority = createTestGroupStateRuntime({
        runtimeRepository,
        now: () => Date.now(),
        serviceId: 'reload-authority'
    });
    const created = await authority.service.createGroup(scope, {
        groupId: roomRef.groupId,
        displayName: 'Reload room',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: principalId,
        actorSessionId: sessionId,
        requestId: 'create-reload-room'
    });
    if (!created.result) {
        throw new Error('Room creation must return its real snapshot');
    }
    let snapshot = created.result.snapshot;
    validateAuthoritativeGroupSnapshot(snapshot);
    setGroupStateSnapshot(snapshot);
    const authorize = createGroupRoomWsAuthorizer({
        readPublicationAuthority: () => Promise.reject(new Error('A members topic reads no publication authority.')),
        readGroupSnapshot: () => snapshot,
        readPreActivationAppData: () => 'allowed',
        nowEpochMs: () => Date.now()
    });
    const oldFaults = createScriptedTransportFaultPort();
    oldFaults.inject({
        faultId: 'old-document',
        carrier: 'ws',
        action: 'not-ready',
        remaining: 'until-cleared',
        match: { typeId: 'reload.room-original', msgId: undefined, controlType: undefined }
    });
    const old = await openRecoveryOwner({ sessionId, principalId, faults: oldFaults, beforeOpenDelayMs: 0 });
    const original: ALMessage = {
        ...newALBroadcastMessage(sessionId, { topicId: 'room.reload', contextId: roomRef.groupId, resourceId: 'one' }, 'room', 'reload.room-original', {
            original: true
        }, { groupRef: roomRef, ttlMs: 30_000, qos: { durability: { algo: 'local-outbox' } } }),
        delivery: { reliability: 'at-least-once', ack: 'none' }
    };
    expect((await old.service.enqueueOutboxIfAbsent(original)).verdict).toMatchObject({ kind: 'admitted', durable: true });
    await old.drain();
    expect(old.native.sent).toEqual([]);
    const retiring = await Promise.allSettled([old.service.close(), old.engine.stop()]);
    const retirementFailure = retiring.find((outcome) => outcome.status === 'rejected');
    if (retirementFailure?.status === 'rejected') {
        throw retirementFailure.reason;
    }
    const fresh = await openRecoveryOwner({ sessionId, principalId, faults: createScriptedTransportFaultPort(), beforeOpenDelayMs: 0 });
    const authorizationInput = {
        message: original,
        topic: { participation: 'members' } as const,
        roomId: roomRef.groupId,
        roomRef,
        senderId: sessionId,
        topicId: original.route.topicId,
        typeId: original.payload.typeId
    };
    expect(await authorize(authorizationInput)).toMatchObject({
        authorized: false,
        reason: 'membership-fenced',
        logMessage: expect.stringContaining('member-not-active')
    });
    await vi.advanceTimersByTimeAsync(100);
    await fresh.drain();
    expect(fresh.native.sent).toEqual([]);
    const retained = await Promise.all((await fresh.service.outbox.getAllKeys()).map((key) => fresh.service.outbox.getItem(key)));
    expect(retained.some((entry) => entry && (entry.status === EntityStatus.NEW || entry.status === EntityStatus.RETRY))).toBe(true);
    const joined = await authority.service.connectPresenceSession(scope, roomRef.groupId, sessionId, {
        principalId,
        generationId: 'fresh-document',
        connectionGenerationId: 'ws-fresh-document',
        connectedAtEpochMs: Date.now(),
        lastHeartbeatAtEpochMs: Date.now(),
        expiresAtEpochMs: Date.now() + 60_000,
        actorPrincipalId: principalId,
        actorSessionId: sessionId,
        requestId: 'join-reload-presence'
    });
    if (!joined.result) {
        throw new Error('Presence mutation must return its real snapshot');
    }
    await convergeSummaryForTest({
        work: new GroupPresenceSummaryWork({
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            recomputeMaxWaitMs: 0,
            runtimeRepository,
            now: () => Date.now(),
            serviceId: 'reload-presence',
            senderPeerId: 'ws-server'
        }),
        runtime: runtimeRepository,
        ref: roomRef,
        commandId: 'reload-presence',
        nowEpochMs: Date.now()
    });
    const refreshed = await authority.durable.readSnapshot(roomRef);
    if (!refreshed) {
        throw new Error('Presence materialization must preserve the group');
    }
    snapshot = refreshed;
    validateAuthoritativeGroupSnapshot(snapshot);
    setGroupStateSnapshot(snapshot);
    expect(await authorize(authorizationInput)).toEqual(expect.objectContaining({ authorized: true }));
    await vi.advanceTimersByTimeAsync(2_000);
    await fresh.drain();
    await fresh.drain();
    expect(fresh.native.sent.map((frame) => decodePersistedALMessage(frame))).toEqual([
        expect.objectContaining({
            id: original.id,
            targets: original.targets,
            payload: original.payload,
            constraints: original.constraints,
            delivery: original.delivery
        })
    ]);
    expect(old.native.sent).toEqual([]);
});

it('keeps another scoped room and canonical bootstrap/control traffic moving while one room waits', async () => {
    vi.setSystemTime(1_000);
    vi.stubGlobal('WebSocket', TestWebSocket);
    const sessionId = crypto.randomUUID();
    writeSession(createTestAuthSession(sessionId, sessionId));
    const roomA = { applicationId: 'app', workspaceId: 'A', groupId: 'same-id' };
    const roomB = { ...roomA, workspaceId: 'B' };
    setGroupStateSnapshot(createGroupSnapshotFixture({ ...roomB, sessionIds: [sessionId] }));
    const owner = await openRecoveryOwner({ sessionId, principalId: sessionId, faults: createScriptedTransportFaultPort(), beforeOpenDelayMs: 0 });
    const held = createRoomOriginal(sessionId, roomA);
    const ready = createRoomOriginal(sessionId, roomB);
    const signaling = newALUnicastMessage(sessionId, { topicId: AppTopics.rtcSignaling, contextId: 'bootstrap', resourceId: 'signal' }, 'peer', 'signal', {});
    const control = newALNackControlMessage({
        v: 4,
        msgId: crypto.randomUUID(),
        senderId: sessionId,
        ts: Date.now(),
        traceId: 'trace-ws-durable-owner-recovery'
    }, {
        fromPeerId: sessionId,
        toPeerId: 'peer',
        msgId: 'missing',
        reason: 'not-yet-in-sync',
        observedAtEpochMs: Date.now()
    });
    const roomControl: ALMessage = { ...control, route: held.route, targets: held.targets };
    for (const message of [held, ready, signaling, roomControl]) {
        await owner.service.enqueueOutboxIfAbsent(message);
    }
    await owner.drain();
    const sentIds = owner.native.sent.map((frame) => decodePersistedALMessage(frame).id.msgId);
    expect(sentIds).not.toContain(held.id.msgId);
    expect(sentIds).toEqual(expect.arrayContaining([ready.id.msgId, signaling.id.msgId, roomControl.id.msgId]));
    setGroupStateSnapshot(createGroupSnapshotFixture({ ...roomA, sessionIds: [sessionId] }));
    await vi.advanceTimersByTimeAsync(2_000);
    await owner.drain();
    expect(owner.native.sent.map((frame) => decodePersistedALMessage(frame).id.msgId).filter((id) => id === held.id.msgId)).toEqual([held.id.msgId]);
});

it('rechecks current room presence and auth after same-document reopen without latching old readiness', async () => {
    vi.setSystemTime(1_000);
    vi.stubGlobal('WebSocket', TestWebSocket);
    const sessionId = crypto.randomUUID();
    const auth = createTestAuthSession(sessionId, sessionId);
    writeSession(auth);
    const ref = { applicationId: 'app', workspaceId: 'A', groupId: 'reopen' };
    const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: [sessionId] });
    setGroupStateSnapshot(snapshot);
    const faults = createScriptedTransportFaultPort();
    const fault = {
        faultId: 'held',
        carrier: 'ws',
        action: 'not-ready',
        remaining: 'until-cleared',
        match: { typeId: 'reload.original', msgId: undefined, controlType: undefined }
    } as const;
    faults.inject(fault);
    const owner = await openRecoveryOwner({ sessionId, principalId: sessionId, faults, beforeOpenDelayMs: 0 });
    const original = createRoomOriginal(sessionId, ref);
    await owner.service.enqueueOutboxIfAbsent(original);
    await owner.drain();
    expect(owner.native.sent).toEqual([]);
    owner.service.disableReconnect();
    owner.native.disconnect(1006, 'network-loss');
    removeGroupStateSnapshotByRef(ref);
    const connecting = owner.service.socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    const reopened = TestWebSocket.instances.at(-1);
    if (!reopened || reopened === owner.native) {
        throw new Error('Reconnect must open a new native socket');
    }
    reopened.open();
    await connecting;
    faults.inject({ ...fault, remaining: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    await owner.drain();
    expect(reopened.sent).toEqual([]);
    setGroupStateSnapshot(snapshot);
    writeSession(createTestAuthSession(sessionId, 'successor-session'));
    await vi.advanceTimersByTimeAsync(2_000);
    await owner.drain();
    expect(reopened.sent).toEqual([]);
    writeSession(auth);
    await vi.advanceTimersByTimeAsync(2_000);
    await owner.drain();
    expect(reopened.sent.map((frame) => decodePersistedALMessage(frame).id.msgId)).toEqual([original.id.msgId]);
});

it.each(['expiry', 'cancel', 'dispose'] as const)('never resurrects room work after %s while authority is missing', async (ending) => {
    vi.setSystemTime(1_000);
    vi.stubGlobal('WebSocket', TestWebSocket);
    const sessionId = crypto.randomUUID();
    writeSession(createTestAuthSession(sessionId, sessionId));
    const ref = { applicationId: 'app', workspaceId: 'A', groupId: ending };
    const owner = await openRecoveryOwner({ sessionId, principalId: sessionId, faults: createScriptedTransportFaultPort(), beforeOpenDelayMs: 0 });
    const original = createRoomOriginal(sessionId, ref);
    await owner.service.enqueueOutboxIfAbsent(original);
    await owner.drain();
    expect(owner.native.sent).toEqual([]);
    if (ending === 'cancel') {
        owner.service.cancelOutbox(original.id.msgId, original.id.traceId);
    }
    if (ending === 'dispose') {
        await owner.service.close();
    }
    await vi.advanceTimersByTimeAsync(ending === 'expiry' ? 30_001 : 2_000);
    setGroupStateSnapshot(createGroupSnapshotFixture({ ...ref, sessionIds: [sessionId] }));
    await owner.drain();
    expect(owner.native.sent).toEqual([]);
    if (ending === 'expiry') {
        expect(original.constraints?.expiresAtMs).toBeLessThan(Date.now());
    }
});

it('does not invent an unsubmitted refusal after the default callback writes and a later observer removes authority', async () => {
    vi.setSystemTime(1_000);
    vi.stubGlobal('WebSocket', TestWebSocket);
    const sessionId = crypto.randomUUID();
    writeSession(createTestAuthSession(sessionId, sessionId));
    const ref = { applicationId: 'app', workspaceId: 'A', groupId: 'callbacks' };
    setGroupStateSnapshot(createGroupSnapshotFixture({ ...ref, sessionIds: [sessionId] }));
    const owner = await openRecoveryOwner({ sessionId, principalId: sessionId, faults: createScriptedTransportFaultPort(), beforeOpenDelayMs: 0 });
    const observed: string[] = [];
    owner.service.onOutboxMessageDo('remove-authority', {
        onMessage: async () => {
            removeGroupStateSnapshotByRef(ref);
            await Promise.resolve();
            observed.push('removed');
        }
    });
    owner.service.onOutboxMessageDo('second-observer', {
        onMessage: async () => {
            observed.push('second');
        }
    });
    const original = createRoomOriginal(sessionId, ref);
    await owner.service.enqueueOutboxIfAbsent(original);
    await owner.drain();
    await vi.advanceTimersByTimeAsync(2_000);
    await owner.drain();
    expect(observed).toEqual(['removed', 'second']);
    expect(owner.native.sent.map((frame) => decodePersistedALMessage(frame).id.msgId)).toEqual([original.id.msgId]);
    expect(owner.settlements.filter((event) => event.kind === 'attempt-settled')).toEqual([
        expect.objectContaining({ outcome: 'sent', submissionAttempted: true, willRetry: false })
    ]);
});

function createRoomOriginal(sessionId: string, ref: GroupRef): ALMessage {
    return {
        ...newALBroadcastMessage(
            sessionId,
            { topicId: 'room.reload', contextId: ref.groupId, resourceId: crypto.randomUUID() },
            'room',
            'reload.original',
            {},
            { groupRef: ref, ttlMs: 30_000 }
        ),
        delivery: { reliability: 'at-least-once', ack: 'none' }
    };
}

async function openRecoveryOwner({
    sessionId,
    principalId,
    faults,
    beforeOpenDelayMs
}: OpenRecoveryOwnerInput): Promise<RecoveryOwner> {
    configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
    const engine = new InboxOutboxEngine();
    const drain = captureOutboundWorkRunnable(engine);
    const settlements: ALDeliverySettlement[] = [];
    const connecting = createBrowserWebSocketQueueBox({
        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
        qosProvider: undefined,
        submissionReadinessFaultPort: faults,
        outboundSettlements: (event) => settlements.push(event),
        newConnectionRequestId: undefined,
        qboxEngine: engine,
        socket: new JsonWebSocketClient('ws://test', faults),
        clientData: { clientId: principalId, sessionId, isOnline: true },
        serverPeerId: 'server',
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(sessionId),
        inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(sessionId),
            createDefaultVolatileSessionBudget(),
            createPassThroughALStorageEventSink()
        ),
        volatileBudget: createDefaultVolatileSessionBudget(),
        checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
        connectTimeoutMs: 0
    });
    await vi.advanceTimersByTimeAsync(beforeOpenDelayMs);
    const native = TestWebSocket.instances.at(-1);
    if (!native) {
        throw new Error('Connection must create a native socket');
    }
    native.open();
    const service = await connecting;
    onTestFinished(async () => {
        const outcomes = await Promise.allSettled([service.close(), engine.stop()]);
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    });
    return { engine, drain, native, service, settlements };
}

class TestAuthStorage implements Storage {
    private readonly entries = new Map<string, string>();
    get length(): number {
        return this.entries.size;
    }
    clear(): void {
        this.entries.clear();
    }
    getItem(key: string): string | null {
        return this.entries.get(key) ?? null;
    }
    key(index: number): string | null {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string): void {
        this.entries.delete(key);
    }
    setItem(key: string, value: string): void {
        this.entries.set(key, value);
    }
}
