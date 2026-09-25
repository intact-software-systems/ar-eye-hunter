import { BlackBoxRallarRuntimeDiagnostics } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import { blackBoxRallarScopeDiagnosticsOf } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-policy.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarTransport
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-policy.ts';
import { requireBlackBoxRallarInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import { BlackBoxRallarDeliveryLedger } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts';
import { BlackBoxRallarTypedChannels } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts';
import { createBlackBoxRallarMessagingResourceController } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/create-black-box-rallar-messaging-resource-controller.ts';
import { decodeBlackBoxRallarMessageSendInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts';
import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { browserDeliveryComposition } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { assembleGroupStateSnapshot } from '@shared-server/rallar-system/group-state/persistence/assemble-group-state-snapshot.ts';
import { computeAlmConformanceQosDefaults } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/compute-alm-conformance-qos-defaults.ts';
import * as browserMiddleware from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliverySettlement, ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import * as auth from '@shared/api/auth.ts';
import { configureClientStateSnapshotRepository } from '@shared/repository/client-state-snapshots-repository.ts';
import { configureOverlayRepositories } from '@shared/repository/overlays-repository.ts';

import { acceptAuthoritativeGroupStateSnapshot } from '@shared-web/browser/state-cache/state-cache-snapshot-adoption.ts';
import { readStateGroupSnapshot } from '@shared-web/browser/state-read/point-read.ts';
import { RtcGroupSnapshotRefresh } from '@shared-web/browser/state-read/rtc-group-snapshot-refresh.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import {
    configureGroupStateSnapshotRepository,
    findGroupStateSnapshotByRef,
    readableGroupStateSnapshotCache,
    setGroupStateSnapshot
} from '@shared/repository/group-state-snapshots-repository.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { createDefaultWebRtcRxStreamerService, WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import {
    createPassThroughTransportFaultPort,
    createScriptedTransportFaultPort,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcRuntime,
    type SimulatedNativeRtcDataChannel
} from '../../shared/native-rtc-connection-fixture.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('RTC room authority recovery', () => {
    it.each(
        [
            'acknowledged',
            'no-ack',
            'sender-missing',
            'duplicate',
            'racing-repair',
            'unchanged-authority',
            'newer-authority',
            'coalesced-higher-floor',
            'refresh-failed',
            'disposed',
            'peer-removed',
            'peer-replaced',
            'expired',
            'wrong-scope',
            'insufficient-floor',
            'removed-member'
        ] as const
    )('rechecks the exact original after deferred authority refresh: %s', async (scenario) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const nativeRuntime = installNativeRtcRuntime();
        const receiverRepository = configureGroupStateSnapshotRepository({ ttlMs: 60_000 });
        const senderGroups = new LatestRepository<string, GroupSnapshot>();
        const snapshot = createGroupSnapshotFixture({ ...room, sessionIds: ['sender', 'receiver'] });
        senderGroups.set(toScopedOverlayId(room), snapshot);
        const response = Promise.withResolvers<Response>();
        const reads: string[] = [];
        vi.stubGlobal('fetch', (url: string | URL | Request) => {
            reads.push(String(url));
            return response.promise;
        });
        const refresh = new RtcGroupSnapshotRefresh({
            refreshGroupSnapshot: async (roomRef, minSnapshotVersion, signal) => {
                const read = await readStateGroupSnapshot(roomRef.groupId, roomRef, {
                    authSession: {
                        clientId: 'receiver',
                        username: 'receiver',
                        sessionId: 'receiver',
                        accessToken: 'fixture-token',
                        expiresAtEpochMs: 60_000
                    },
                    signal,
                    minCausalRevision: { groupRevision: minSnapshotVersion, presenceRevision: 0 }
                });
                signal.throwIfAborted();
                await acceptAuthoritativeGroupStateSnapshot(read.snapshot, roomRef);
            }
        });
        const sender = new NativeAuthorityEndpoint({
            sessionId: 'sender',
            peerId: 'receiver',
            nativeRuntime,
            groups: senderGroups,
            refresh: undefined
        });
        const receiver = new NativeAuthorityEndpoint({
            sessionId: 'receiver',
            peerId: 'sender',
            nativeRuntime,
            groups: readableGroupStateSnapshotCache(),
            refresh
        });
        onTestFinished(() => {
            response.resolve(new Response('', { status: 503 }));
            receiver.close();
            sender.close();
            receiverRepository.dispose();
            senderGroups.dispose();
            nativeRuntime.dispose();
            vi.restoreAllMocks();
            vi.useRealTimers();
        });
        await sender.native.open();
        await receiver.native.open();
        const ack = scenario === 'no-ack' ? 'none' : 'hop';
        const message = newALMulticastMessage(
            'sender',
            {
                topicId: 'room.messages',
                contextId: 'room',
                resourceId: 'recovery'
            },
            room,
            'recovery.message',
            { value: 1 },
            {
                ttlMs: 30_000,
                reliability: 'at-least-once',
                minSnapshotVersion: scenario === 'insufficient-floor' ? 2 : undefined,
                ack: ack === 'hop' ? 'all-logical-recipients' : 'none',
                qos: { durability: { algo: 'volatile' }, ack: { algo: ack, opts: { timeoutMs: 5_000 } } }
            }
        );

        expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
        expect(await sender.multicast.enqueueIfAbsent(message)).toMatchObject({ verdict: { kind: 'admitted' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(sender.messages().map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
        const receiving = sender.transferTo(receiver);
        await vi.advanceTimersByTimeAsync(0);
        expect(receiver.delivered).toEqual([]);
        expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
        expect(receiver.admissions).toContainEqual(expect.objectContaining({
            kind: 'admission-outcome',
            msgId: message.id.msgId,
            outcome: 'rejected',
            reason: 'not-yet-in-sync: Awaiting a room authority observation'
        }));
        expect(reads).toHaveLength(1);
        expect(reads[0]).toBe(
            '/api/state/apps/app/workspaces/workspace/groups/room?minGroupRevision=' +
                (scenario === 'insufficient-floor' ? '2' : '0') + '&minPresenceRevision=0'
        );
        expect(receiver.messages().map(parseALControlMessage)).toContainEqual({
            type: 'nack',
            payload: expect.objectContaining({ msgId: message.id.msgId, reason: 'not-yet-in-sync' })
        });
        if (scenario === 'sender-missing') {
            senderGroups.clearAll();
        }
        await receiver.transferTo(sender);
        const duplicateAdmissions: Promise<void>[] = [];
        let higherFloorMessage: ALMessage | undefined;
        if (scenario === 'duplicate') {
            duplicateAdmissions.push(receiver.native.receive(sender.native.sent[0]));
        }
        if (scenario === 'racing-repair') {
            await vi.advanceTimersByTimeAsync(100);
            expect(sender.messages().filter((sent) => sent.id.msgId === message.id.msgId)).toHaveLength(2);
            duplicateAdmissions.push(sender.transferTo(receiver));
        }
        if (scenario === 'coalesced-higher-floor') {
            higherFloorMessage = newALMulticastMessage(
                'sender',
                { topicId: 'room.messages', contextId: 'room', resourceId: 'higher-floor' },
                room,
                'recovery.message',
                { value: 2 },
                { ttlMs: 30_000, minSnapshotVersion: 2 }
            );
            expect(await sender.multicast.enqueueIfAbsent(higherFloorMessage)).toMatchObject({ verdict: { kind: 'admitted' } });
            await vi.advanceTimersByTimeAsync(0);
            expect(sender.messages().map((sent) => sent.id.msgId)).toContain(higherFloorMessage.id.msgId);
            duplicateAdmissions.push(sender.transferTo(receiver));
        }
        const currentSnapshot = scenario === 'newer-authority'
            ? {
                ...snapshot,
                group: { ...snapshot.group, snapshotVersion: 2 },
                causalRevision: { ...snapshot.causalRevision, groupRevision: 2 }
            }
            : snapshot;
        if (scenario === 'unchanged-authority' || scenario === 'newer-authority') {
            await acceptAuthoritativeGroupStateSnapshot(currentSnapshot, room);
        }
        if (scenario === 'disposed') {
            receiver.streamer.dispose();
        }
        if (scenario === 'peer-removed' || scenario === 'peer-replaced') {
            await receiver.removePeer(scenario === 'peer-replaced');
        }
        if (scenario === 'expired') {
            vi.setSystemTime(31_000);
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(receiver.delivered).toEqual([]);
        response.resolve(
            scenario === 'refresh-failed'
                ? new Response('', { status: 503 })
                : snapshotResponse(snapshot, scenario)
        );
        await Promise.all([receiving, ...duplicateAdmissions]);
        await vi.advanceTimersByTimeAsync(0);

        const shouldDeliver = [
            'acknowledged',
            'no-ack',
            'sender-missing',
            'duplicate',
            'racing-repair',
            'unchanged-authority',
            'newer-authority',
            'coalesced-higher-floor'
        ].includes(scenario);
        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual(shouldDeliver ? [message.id.msgId] : []);
        expect(reads).toHaveLength(1);
        if (higherFloorMessage !== undefined) {
            expect(receiver.admissions).toContainEqual(expect.objectContaining({
                kind: 'admission-outcome',
                msgId: higherFloorMessage.id.msgId,
                outcome: 'rejected',
                reason: 'not-yet-in-sync: Awaiting the required room snapshot version'
            }));
        }
        if (shouldDeliver) {
            expect(receiver.delivered[0]).toMatchObject({
                id: message.id,
                targets: { mode: 'multicast', groupRef: room },
                payload: message.payload,
                constraints: { expiresAtMs: 31_000 }
            });
            expect(findGroupStateSnapshotByRef(room)).toEqual(currentSnapshot);
        }
    });
});

describe('latest-wins receiver delivery and independent ordering', () => {
    it.each(['ordered-latest', 'unsequenced-latest', 'ordinary-ordered'] as const)(
        'preserves independent latest-wins and ordered delivery contracts: %s',
        async (scenario) => {
            vi.useFakeTimers();
            vi.setSystemTime(1_000);
            const nativeRuntime = installNativeRtcRuntime();
            const groups = new LatestRepository<string, GroupSnapshot>();
            groups.set(toScopedOverlayId(room), createGroupSnapshotFixture({ ...room, sessionIds: ['sender', 'receiver'] }));
            const faults = createScriptedTransportFaultPort();
            const hold = {
                faultId: 'latest-wins-hold',
                carrier: 'rtc',
                action: 'drop',
                remaining: 'until-cleared',
                match: { typeId: 'lifecycle.message', msgId: undefined, controlType: undefined }
            } as const;
            faults.inject(hold);
            const sender = new NativeAuthorityEndpoint({
                sessionId: 'sender',
                peerId: 'receiver',
                nativeRuntime,
                groups,
                refresh: undefined,
                faultPort: faults,
                qosProvider: scenario === 'ordinary-ordered' ? undefined : { defaultsForMessage: computeAlmConformanceQosDefaults }
            });
            const receiver = new NativeAuthorityEndpoint({
                sessionId: 'receiver',
                peerId: 'sender',
                nativeRuntime,
                groups,
                refresh: undefined
            });
            onTestFinished(() => {
                receiver.close();
                sender.close();
                groups.dispose();
                nativeRuntime.dispose();
                vi.useRealTimers();
            });
            await sender.native.open();
            await receiver.native.open();
            const old = newALMulticastMessage(
                'sender',
                { topicId: 'room.messages', contextId: 'room', resourceId: 'old' },
                room,
                'lifecycle.message',
                { marker: 'delivery-lifecycle', specimen: 'supersedence', revision: 'old' },
                {
                    ttlMs: 30_000,
                    reliability: 'at-least-once',
                    ack: 'receiver',
                    seq: scenario === 'unsequenced-latest' ? undefined : 1,
                    qos: { ack: { algo: 'hop' } }
                }
            );
            expect(await sender.multicast.enqueueIfAbsent(old)).toMatchObject({ verdict: { kind: 'admitted' } });
            await vi.advanceTimersByTimeAsync(100);
            expect(sender.messages()).toEqual([]);
            const replacement = newALMulticastMessage(
                'sender',
                { topicId: 'room.messages', contextId: 'room', resourceId: 'replacement' },
                room,
                'lifecycle.message',
                { marker: 'delivery-lifecycle', specimen: 'supersedence', revision: 'replacement' },
                {
                    ttlMs: 30_000,
                    reliability: 'at-least-once',
                    ack: 'receiver',
                    seq: scenario === 'unsequenced-latest' ? undefined : 2,
                    qos: { ack: { algo: 'hop' } }
                }
            );
            expect(await sender.multicast.enqueueIfAbsent(replacement)).toMatchObject({ verdict: { kind: 'admitted' } });
            await vi.advanceTimersByTimeAsync(100);
            expect(sender.messages()).toEqual([]);
            if (scenario !== 'ordinary-ordered') {
                expect(sender.settlements).toContainEqual(expect.objectContaining({
                    kind: 'attempt-settled',
                    msgId: old.id.msgId,
                    outcome: 'superseded',
                    submissionAttempted: false
                }));
            }
            faults.inject({ ...hold, remaining: 0 });
            await vi.advanceTimersByTimeAsync(100);
            expect(sender.messages().map((message) => message.id.msgId))
                .toEqual(scenario === 'ordinary-ordered' ? [old.id.msgId, replacement.id.msgId] : [replacement.id.msgId]);
            await sender.transferTo(receiver);
            const controls = receiver.messages().map(parseALControlMessage);
            if (scenario === 'ordered-latest') {
                expect(receiver.delivered).toEqual([]);
                expect(controls).toContainEqual({
                    type: 'nack',
                    payload: expect.objectContaining({
                        msgId: replacement.id.msgId,
                        reason: 'gap',
                        orderingKey: '["app","workspace","room"]:sender:0',
                        expectedSeq: 1,
                        missingSeqs: [1]
                    })
                });
                expect(controls).toContainEqual({
                    type: 'repair',
                    payload: expect.objectContaining({
                        msgId: replacement.id.msgId,
                        orderingKey: '["app","workspace","room"]:sender:0',
                        expectedSeq: 1,
                        missingSeqs: [1]
                    })
                });
            }
            const settlementsBeforeRepair = sender.settlements.length;
            await receiver.transferTo(sender);
            await vi.advanceTimersByTimeAsync(100);
            await sender.transferTo(receiver);
            if (scenario === 'ordered-latest') {
                expect(sender.outboundDiagnostics).toContainEqual(expect.objectContaining({
                    kind: 'commit-phases',
                    msgId: old.id.msgId,
                    origin: 'repair',
                    commitOutcome: 'committed'
                }));
                expect(sender.messages().map((message) => message.id.msgId)).toEqual([replacement.id.msgId]);
                expect(sender.settlements.slice(settlementsBeforeRepair)).toContainEqual(expect.objectContaining({
                    kind: 'attempt-settled',
                    msgId: old.id.msgId,
                    outcome: 'superseded',
                    submissionAttempted: false,
                    willRetry: false
                }));
            }
            if (scenario === 'ordered-latest') {
                expect(receiver.delivered).toEqual([]);
                return;
            }
            expect(receiver.delivered.map((message) => message.id.msgId))
                .toEqual(scenario === 'ordinary-ordered' ? [old.id.msgId, replacement.id.msgId] : [replacement.id.msgId]);
            expect(receiver.delivered.at(-1)).toMatchObject({
                id: replacement.id,
                payload: replacement.payload,
                constraints: { expiresAtMs: 31_100 }
            });
        }
    );
});

it('delivers the canonical generated supersedence specimen through the page decoder and native receiver', async () => {
    vi.useFakeTimers();
    const nativeRuntime = installNativeRtcRuntime();
    const groups = configureGroupStateSnapshotRepository({ ttlMs: 60_000 });
    const snapshot = createGroupSnapshotFixture({ ...room, sessionIds: ['sender', 'receiver'] });
    setGroupStateSnapshot({
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            lastHeartbeatAtEpochMs: Date.now(),
            expiresAtEpochMs: Date.now() + 60_000
        }))
    });
    const faults = createScriptedTransportFaultPort();
    const hold = {
        faultId: 'generated-hold',
        carrier: 'rtc',
        action: 'drop',
        remaining: 'until-cleared',
        match: { typeId: 'generated.rtc.delivery-lifecycle', msgId: undefined, controlType: undefined }
    } as const;
    faults.inject(hold);
    const sender = new NativeAuthorityEndpoint({
        sessionId: 'sender',
        peerId: 'receiver',
        nativeRuntime,
        groups: readableGroupStateSnapshotCache(),
        refresh: undefined,
        faultPort: faults,
        qosProvider: { defaultsForMessage: computeAlmConformanceQosDefaults },
        outboundSettlements: (event) => browserDeliveryComposition.deliveries.record(event)
    });
    const receiver = new NativeAuthorityEndpoint({
        sessionId: 'receiver',
        peerId: 'sender',
        nativeRuntime,
        groups: readableGroupStateSnapshotCache(),
        refresh: undefined
    });
    onTestFinished(() => {
        receiver.close();
        sender.close();
        groups.dispose();
        nativeRuntime.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    await sender.native.open();
    await receiver.native.open();
    const ledger = createGeneratedSendLedger(sender);
    const scenario = createAlmConformanceRecipes({
        group: room,
        carrier: 'rtc',
        typeId: 'generated',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 30_000
    })
        .find((scenario) => scenario.scenarioId === 'delivery-lifecycle')!;
    const sends = scenario.sender.commands.filter(isRallarBlackBoxTestMessagesSendCommand).filter((command) =>
        command.payload !== null && typeof command.payload === 'object' && !Array.isArray(command.payload) && 'specimen' in command.payload &&
        command.payload.specimen === 'supersedence'
    );
    expect(sends).toHaveLength(2);
    // The generated type is part of the selected fault; no sequence or delivery option is rewritten.
    expect(sends.map((command) => command.typeId)).toEqual(['generated.rtc.delivery-lifecycle', 'generated.rtc.delivery-lifecycle']);
    const old = await ledger.sendMessage(requireBlackBoxRallarInput(decodeBlackBoxRallarMessageSendInput(sends[0])));
    await vi.advanceTimersByTimeAsync(100);
    expect(sender.messages()).toEqual([]);
    const replacement = await ledger.sendMessage(requireBlackBoxRallarInput(decodeBlackBoxRallarMessageSendInput(sends[1])));
    await vi.advanceTimersByTimeAsync(100);
    expect(await ledger.readReceipts({ connection: 'sender', handleId: old.handleId })).toMatchObject({ state: 'superseded', submitted: false });
    expect(sender.messages()).toEqual([]);
    faults.inject({ ...hold, remaining: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(sender.messages().map((message) => message.id.msgId)).toEqual([replacement.msgId]);
    await sender.transferTo(receiver);
    await receiver.transferTo(sender);
    await vi.advanceTimersByTimeAsync(100);
    await sender.transferTo(receiver);
    expect(sender.messages().map((message) => message.id.msgId)).toEqual([replacement.msgId]);
    expect(receiver.delivered.map((message) => message.id.msgId)).toEqual([replacement.msgId]);
    expect(receiver.delivered[0].payload.resource).toBe(JSON.stringify(sends[1].payload));
});

function createGeneratedSendLedger(sender: NativeAuthorityEndpoint): BlackBoxRallarDeliveryLedger {
    const bootstrap = createDefaultApiMiddlewareTestDouble({
        session: { clientId: 'sender', sessionId: 'sender', username: 'sender', expiresAtEpochMs: Date.now() + 300_000 }
    });
    const context = {
        ...bootstrap,
        middleware: {
            ...bootstrap.middleware,
            rtcRxStreamer: sender.streamer,
            webRtcConnectionService: sender.connection.service,
            webRtcOverlayMulticastManager: sender.multicast
        }
    };
    vi.spyOn(auth, 'readSession').mockReturnValue(context.session);
    vi.spyOn(auth, 'isLoggedIn').mockReturnValue(true);
    vi.spyOn(browserMiddleware, 'initialiseMiddleware').mockResolvedValue(context.middleware);
    const facade = createRallarFacade();
    const resources = createBlackBoxRallarMessagingResourceController({ generation: () => 1, isCurrent: (generation) => generation === 1 });
    onTestFinished(() => {
        resources.cleanupWsSubscriptions();
    });
    const diagnostics = new BlackBoxRallarRuntimeDiagnostics({
        now: Date.now,
        publish: () => {},
        onPublishError: (error) => {
            throw error;
        },
        transportOf: resolveBlackBoxRallarTransport,
        laneIdOf: resolveBlackBoxRallarLaneId,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf
    });
    return new BlackBoxRallarDeliveryLedger({
        deliveries: {
            getHandle: (msgId) => browserDeliveryComposition.deliveries.getHandle(msgId),
            replayCapturedMessage: () => Promise.reject(new Error('This fixture never replays a message.')),
            resolveRoomMinSnapshotVersion: () => {
                throw new Error('This fixture never states a snapshot floor.');
            }
        },
        typedChannels: new BlackBoxRallarTypedChannels({ messages: facade.messages, resources, diagnostics }),
        resources,
        diagnostics,
        requireConfig: () => ({
            connection: 'sender',
            roomId: room.groupId,
            roomRef: room,
            rallar: {
                apiBaseUrl: 'http://fixture.invalid',
                applicationId: room.applicationId,
                workspaceId: room.workspaceId,
                transport: 'messages.rtc',
                typeId: 'generated.rtc.delivery-lifecycle'
            }
        })
    });
}

describe('authoritative room observation freshness', () => {
    it.each(
        [
            'authoritative-refresh',
            'first-authoritative-read',
            'expired-session',
            'expired-original',
            'no-refresh',
            'untrusted-duplicate',
            'normal-authoritative-equal',
            'normal-authoritative-lease-advance',
            'normal-authoritative-first-read',
            'normal-authoritative-expired-previous-lease',
            'normal-authoritative-expired-acquired-lease',
            'normal-authoritative-expired-original'
        ] as const
    )(
        'preserves the original cache expiry unless a current authoritative read renews it: %s',
        async (scenario) => {
            vi.useFakeTimers();
            vi.setSystemTime(1_000);
            const nativeRuntime = installNativeRtcRuntime();
            const senderRepository = configureGroupStateSnapshotRepository({ ttlMs: 60_000 });
            const receiverGroups = new LatestRepository<string, GroupSnapshot>();
            const initial = createGroupSnapshotFixture({ ...room, sessionIds: ['sender', 'receiver'] });
            const snapshot: GroupSnapshot = {
                ...initial,
                activeSessions: initial.activeSessions.map((session) => ({
                    ...session,
                    expiresAtEpochMs: scenario === 'normal-authoritative-expired-previous-lease'
                        ? 30_000
                        : scenario === 'expired-session' || scenario === 'normal-authoritative-expired-acquired-lease'
                        ? 60_000
                        : 300_000
                }))
            };
            if (scenario !== 'first-authoritative-read' && scenario !== 'normal-authoritative-first-read') {
                setGroupStateSnapshot(snapshot);
            }
            const acquired = scenario.startsWith('normal-authoritative')
                ? assembleLeaseObservation(
                    snapshot,
                    scenario === 'normal-authoritative-equal' ? 1 : 50_000,
                    scenario === 'normal-authoritative-expired-acquired-lease' ? 61_000 : scenario === 'normal-authoritative-equal' ? 300_000 : 350_000
                )
                : snapshot;
            expect(acquired.causalRevision).toEqual({ groupRevision: 1, presenceRevision: 2 });
            receiverGroups.set(toScopedOverlayId(room), acquired);
            const reads: string[] = [];
            vi.stubGlobal('fetch', (url: string | URL | Request) => {
                reads.push(String(url));
                if (String(url).endsWith('/topology')) {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                groupRef: room,
                                overlayId: toScopedOverlayId(room),
                                snapshot: null,
                                acceptedSnapshot: null
                            }),
                            { headers: { 'content-type': 'application/json' } }
                        )
                    );
                }
                return Promise.resolve(snapshotResponse(acquired, 'valid'));
            });
            onTestFinished(() => {
                senderRepository.dispose();
                receiverGroups.dispose();
                nativeRuntime.dispose();
                vi.restoreAllMocks();
                vi.useRealTimers();
            });

            vi.setSystemTime(51_000);
            if (scenario.startsWith('normal-authoritative')) {
                expect(acquired.activeSessions.map((session) => session.lastHeartbeatAtEpochMs))
                    .toEqual(scenario === 'normal-authoritative-equal' ? [1, 1] : [50_000, 50_000]);
                await refreshNormalRoom();
            }
            else if (scenario !== 'no-refresh' && scenario !== 'untrusted-duplicate') {
                const controller = new AbortController();
                const response = await readStateGroupSnapshot(room.groupId, room, {
                    authSession: {
                        clientId: 'sender',
                        username: 'sender',
                        sessionId: 'sender',
                        accessToken: 'fixture-token',
                        expiresAtEpochMs: 300_000
                    },
                    signal: controller.signal
                });
                controller.signal.throwIfAborted();
                expect(response.snapshot).toEqual(snapshot);
                expect(await acceptAuthoritativeGroupStateSnapshot(response.snapshot, room)).toBe(scenario === 'first-authoritative-read');
            }
            else if (scenario === 'untrusted-duplicate') {
                expect(setGroupStateSnapshot(snapshot)).toBe(false);
            }
            expect(findGroupStateSnapshotByRef(room)).toEqual(scenario.startsWith('normal-authoritative') ? acquired : snapshot);
            expect(reads.filter((url) => !url.endsWith('/topology'))).toHaveLength(scenario !== 'no-refresh' && scenario !== 'untrusted-duplicate' ? 1 : 0);

            vi.setSystemTime(62_000);
            const sender = new NativeAuthorityEndpoint({
                sessionId: 'sender',
                peerId: 'receiver',
                nativeRuntime,
                groups: readableGroupStateSnapshotCache(),
                refresh: undefined
            });
            const receiver = new NativeAuthorityEndpoint({
                sessionId: 'receiver',
                peerId: 'sender',
                nativeRuntime,
                groups: receiverGroups,
                refresh: undefined
            });
            onTestFinished(() => {
                receiver.close();
                sender.close();
            });
            await sender.native.open();
            await receiver.native.open();
            const message = newALMulticastMessage(
                'sender',
                { topicId: 'room.messages', contextId: 'room', resourceId: 'freshness' },
                room,
                'freshness.message',
                { value: 1 },
                { ttlMs: 30_000, reliability: 'at-least-once', ack: 'none' }
            );
            if (scenario === 'expired-original' || scenario === 'normal-authoritative-expired-original') {
                vi.setSystemTime(92_000);
            }
            const admission = await sender.multicast.enqueueIfAbsent(message);
            await vi.advanceTimersByTimeAsync(0);
            await sender.transferTo(receiver);

            const permitsNativeSend = scenario === 'authoritative-refresh' || scenario === 'first-authoritative-read' ||
                [
                    'normal-authoritative-equal',
                    'normal-authoritative-lease-advance',
                    'normal-authoritative-first-read',
                    'normal-authoritative-expired-previous-lease'
                ].includes(scenario);
            if (permitsNativeSend) {
                expect(admission.verdict).toMatchObject({ kind: 'admitted' });
                expect(sender.messages().map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
                expect(receiver.delivered.map((received) => received.id.msgId)).toEqual([message.id.msgId]);
                expect(findGroupStateSnapshotByRef(room)).toEqual(acquired);
                expect(receiver.delivered[0]).toMatchObject({
                    id: message.id,
                    targets: { mode: 'multicast', groupRef: room },
                    payload: message.payload,
                    constraints: { expiresAtMs: 92_000 }
                });
            }
            else {
                if (scenario === 'no-refresh' || scenario === 'untrusted-duplicate') {
                    expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
                }
                else {
                    expect(findGroupStateSnapshotByRef(room)).toEqual(scenario.startsWith('normal-authoritative') ? acquired : snapshot);
                }
                expect(sender.messages()).toEqual([]);
                expect(receiver.delivered).toEqual([]);
            }
        }
    );
});

function assembleLeaseObservation(snapshot: GroupSnapshot, lastHeartbeatAtEpochMs: number, expiresAtEpochMs: number): GroupSnapshot {
    return assembleGroupStateSnapshot({
        group: snapshot.group,
        members: snapshot.members,
        summary: {
            ...room,
            causalRevision: snapshot.causalRevision,
            activePrincipalIds: ['sender', 'receiver'],
            activeSessionIds: ['sender', 'receiver'],
            activeSessions: snapshot.activeSessions,
            activePrincipalCount: 2,
            activeSessionCount: 2,
            computedAtEpochMs: 1
        },
        authoritativeSessions: snapshot.activeSessions.map((session) => ({ ...session, lastHeartbeatAtEpochMs, expiresAtEpochMs })),
        groupRevision: 1,
        observedAtEpochMs: 51_000,
        sessionLeaseFields: 'authoritative'
    }, (key, message) => new Error(`${key}: ${message}`));
}

async function refreshNormalRoom(): Promise<void> {
    const clients = configureClientStateSnapshotRepository({ ttlMs: 60_000 });
    onTestFinished(() => clients.dispose());
    configureOverlayRepositories({ plannedOverlays: { ttlMs: 60_000 }, acceptedOverlays: { ttlMs: 60_000 } });
    const context = createDefaultApiMiddlewareTestDouble({
        session: { clientId: 'sender', sessionId: 'sender', username: 'sender', expiresAtEpochMs: 300_000 },
        middleware: {
            webRtcGroupManager: {
                notifyOverlayTopologyChanged: async () => undefined,
                ensureAllGroupsConnected: async () => undefined
            }
        }
    });
    vi.spyOn(auth, 'readSession').mockReturnValue(context.session);
    vi.spyOn(auth, 'isLoggedIn').mockReturnValue(true);
    vi.spyOn(browserMiddleware, 'initialiseMiddleware').mockResolvedValue(context.middleware);
    const facade = createRallarFacade();
    await facade.rooms.session(room).refresh();
}

function snapshotResponse(snapshot: GroupSnapshot, scenario: string): Response {
    const authority = scenario === 'wrong-scope'
        ? createGroupSnapshotFixture({ ...room, workspaceId: 'wrong', sessionIds: ['sender', 'receiver'] })
        : scenario === 'removed-member'
        ? {
            ...snapshot,
            members: snapshot.members.map((member) =>
                member.principalId === 'sender'
                    ? { ...member, status: 'removed' as const, removed: member.updated }
                    : member
            )
        }
        : snapshot;
    return new Response(JSON.stringify(authority), {
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': '1',
            'rallar-presence-revision': '2'
        }
    });
}

namespace NativeAuthorityEndpoint {
    export interface Input {
        readonly sessionId: string;
        readonly peerId: string;
        readonly nativeRuntime: NativeRtcRuntime;
        readonly groups: ReadableKeyedValues<string, GroupSnapshot>;
        readonly refresh: RtcGroupSnapshotRefresh | undefined;
        readonly faultPort?: TransportFaultPort;
        readonly qosProvider?: ALQosInputProvider;
        readonly outboundSettlements?: ALDeliverySettlementSink;
    }
}

class NativeAuthorityEndpoint {
    readonly resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
    readonly multicast: WebRtcOverlayMulticastManager;
    readonly streamer: WebRtcRxStreamerService;
    readonly native: SimulatedNativeRtcDataChannel;
    readonly delivered: ALMessage[] = [];
    readonly admissions: ALInboundRuntimeDiagnosticsEvent[] = [];
    readonly settlements: ALDeliverySettlement[] = [];
    readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    readonly connection;
    private readonly overlays = new LatestRepository<string, OverlayInfo>();
    private transferredCount = 0;
    private readonly peerId: string;

    constructor(input: NativeAuthorityEndpoint.Input) {
        this.peerId = input.peerId;
        this.connection = createNativeRtcConnectionFixture({
            sessionId: input.sessionId,
            token: 'fixture-token',
            faultPort: input.faultPort ?? createPassThroughTransportFaultPort(),
            rtcSignalingTopicId: 'rtc',
            dataChannelName: 'reliable',
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 }
        }, input.nativeRuntime);
        this.connection.service.ensurePeerConnectionStarted(input.peerId, true);
        this.native = this.connection.nativePeer(input.peerId).channels[0];
        this.overlays.set(toScopedOverlayId(room), createOverlay(input.peerId));
        this.multicast = new WebRtcOverlayMulticastManager({
            connectionService: this.connection.service,
            groupCache: input.groups,
            overlayCache: this.overlays,
            multicasterFactory: (id) => new WebRtcOverlayMulticastService(id, this.connection.service),
            qosProvider: input.qosProvider,
            outboundDiagnostics: (event) => this.outboundDiagnostics.push(event),
            outboundSettlements: (event) => {
                this.settlements.push(event);
                input.outboundSettlements?.(event);
            },
            outboundRuntime: this.resources,
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        this.streamer = createDefaultWebRtcRxStreamerService({
            multicast: this.multicast,
            sessionId: input.sessionId,
            inboundStores: createDefaultInMemoryALInboundRuntimeStores(),
            roomAuthorityRefresh: input.refresh,
            inboundDiagnostics: (event) => this.admissions.push(event)
        });
        this.streamer.setRttReportingPeerIds([]);
        this.streamer.onAllInboxMessagesDo({
            onMessage: async (message) => {
                this.delivered.push(message);
            }
        });
        this.streamer.addPeer(this.connection.service.readPeer(input.peerId)!);
    }

    messages(): readonly ALMessage[] {
        return this.native.sent.map((frame) => decodePersistedALMessage(String(frame)));
    }

    async transferTo(receiver: NativeAuthorityEndpoint): Promise<void> {
        for (const frame of this.native.sent.slice(this.transferredCount)) {
            this.transferredCount += 1;
            await receiver.native.receive(frame);
            await vi.advanceTimersByTimeAsync(0);
        }
    }

    async removePeer(replace: boolean): Promise<void> {
        const peer = this.connection.service.readPeer(this.peerId)!;
        this.streamer.removePeer(peer);
        this.connection.service.removePeerIfPresent(this.peerId);
        if (replace) {
            this.connection.service.ensurePeerConnectionStarted(this.peerId, true);
            this.streamer.addPeer(this.connection.service.readPeer(this.peerId)!);
            await this.connection.nativePeer(this.peerId).channels[0].open();
        }
    }

    close(): void {
        this.streamer.dispose();
        this.multicast.dispose();
        this.connection.dispose();
        this.overlays.dispose();
    }
}

function createOverlay(peerId: string): OverlayInfo {
    return {
        overlayId: toScopedOverlayId(room),
        groupRef: room,
        provenance: 'server',
        state: 'active',
        topology: 'tree',
        name: 'Room',
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 2 },
        nextHopSessionIds: [peerId],
        degreeLimit: 2,
        overlayVersion: 1,
        createdByClientId: 'sender',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
}
