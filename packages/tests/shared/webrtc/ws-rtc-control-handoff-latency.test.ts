import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import {
    newALEventRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import { ALInboundMessageAdmission } from '@shared/alm/inbound/al-inbound-message-admission.ts';
import type {
    ALInboundMessageRuntime,
    ALInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundPendingAdmissionId } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type {
    QueueBoxResourceEntryRepository,
    ResourceInboxReleaseDisposition,
    ResourceInboxReservationRequest
} from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY } from '@shared/services/web-rtc-connection-service.ts';
import {
    createDefaultWsQueueBoxClientService,
    type WsQueueBoxClientService
} from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingType
} from '@shared/webrtc/QRtcSignalingContracts.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import '../../setup-browser-indexeddb.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

const BATCH_STARTED_AT_MS = 1_800_000_000_000;
const BACKGROUND_CONTROL_COUNT = 31;

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    TestWebSocket.instances.length = 0;
});

it('hands RTC admission past a full control page before held outbound locks can consume the peer lifetime', async () => {
    const fixture = await RtcControlHandoffFixture.create();

    const firstReservation = await fixture.seedFullInboundControlPage();
    expect(firstReservation).toHaveLength(16);
    expect(new Set(firstReservation.map((event) => event.kind))).toEqual(new Set(['send-control']));
    expect(firstReservation.every((event) => event.atMs === BATCH_STARTED_AT_MS)).toBe(true);

    const admission = await fixture.admitRtcSignalThroughRealConflict();
    await fixture.expectRtcDeliveryBeforeControlLocks(admission);
    await fixture.releaseControlLocksAndExpectExactDrain();
}, 30_000);

interface InboundClaimTrace {
    readonly phase: 'reserved' | 'released';
    readonly batch: number;
    readonly atMs: number;
    readonly effectId: string;
    readonly kind: string;
    readonly status: EntityStatus | undefined;
}

class HeldOutboundControlLocks {
    private readonly releaseGate = Promise.withResolvers<void>();
    private currentNowMs = BATCH_STARTED_AT_MS;
    private requests = 0;

    constructor() {
        vi.spyOn(Date, 'now').mockImplementation(() => this.currentNowMs);
        vi.stubGlobal('navigator', { locks: { request: this.request.bind(this) } });
    }

    count(): number {
        return this.requests;
    }

    setNowMs(value: number): void {
        this.currentNowMs = value;
    }

    release(): void {
        this.releaseGate.resolve();
    }

    private async request<T>(
        _name: string,
        _options: Readonly<{ mode: 'exclusive'; }>,
        callback: () => Promise<T>
    ): Promise<T> {
        await this.releaseGate.promise;
        this.requests += 1;
        return await callback();
    }
}

namespace RtcControlHandoffFixture {
    export interface Observations {
        controlSendCount: number;
        readonly controlStatuses: string[];
        rtcDeliveredAtMs: number | undefined;
    }

    export interface Dependencies {
        readonly locks: HeldOutboundControlLocks;
        readonly inboundStores: ALInboundRuntimeStores;
        readonly queueEngine: InboxOutboxEngine;
        readonly service: WsQueueBoxClientService;
        readonly socket: TestWebSocket;
        readonly claimTrace: InboundClaimTrace[];
        readonly waitForFirstBatch: () => Promise<readonly InboundClaimTrace[]>;
        readonly releaseFirstBatch: () => void;
        readonly observations: Observations;
    }

    export interface ConflictedAdmission {
        readonly signal: ALMessage;
        readonly peerStartedAtMs: number;
    }
}

class RtcControlHandoffFixture {
    private readonly dependencies: RtcControlHandoffFixture.Dependencies;

    private constructor(dependencies: RtcControlHandoffFixture.Dependencies) {
        this.dependencies = dependencies;
    }

    static async create(): Promise<RtcControlHandoffFixture> {
        const locks = new HeldOutboundControlLocks();
        vi.stubGlobal('WebSocket', TestWebSocket);
        const stores = await createRtcAdmissionStores();
        const claimTrace: InboundClaimTrace[] = [];
        const firstBatchSelected = Promise.withResolvers<readonly InboundClaimTrace[]>();
        const releaseFirstBatch = Promise.withResolvers<void>();
        traceInboundClaims({
            queue: stores.inbound.workQueue,
            namespace: stores.inbound.admissionStore.namespace,
            trace: claimTrace,
            onFirstBatch: async (claims) => {
                firstBatchSelected.resolve(claims);
                await releaseFirstBatch.promise;
            }
        });
        const queueEngine = new InboxOutboxEngine();
        const connected = await connectWsQueueBoxService({ ...stores, queueEngine });
        const observations: RtcControlHandoffFixture.Observations = {
            controlSendCount: 0,
            controlStatuses: [],
            rtcDeliveredAtMs: undefined
        };
        await observeRtcControlTraffic(connected.service, observations);
        onTestFinished(() => {
            connected.service.close();
            queueEngine.stop();
        });
        return new RtcControlHandoffFixture({
            locks,
            inboundStores: stores.inbound,
            queueEngine,
            ...connected,
            claimTrace,
            waitForFirstBatch: () => firstBatchSelected.promise,
            releaseFirstBatch: () => releaseFirstBatch.resolve(),
            observations
        });
    }

    async seedFullInboundControlPage(): Promise<readonly InboundClaimTrace[]> {
        const bootstrap = newALAckControlMessage(
            { v: 2, senderId: 'bootstrap-peer', msgId: 'unknown-control', ts: BATCH_STARTED_AT_MS },
            {
                ackedMsgId: 'unknown',
                fromPeerId: 'bootstrap-peer',
                toPeerId: 'self',
                status: 'delivered',
                observedAtEpochMs: BATCH_STARTED_AT_MS
            }
        );
        expect((await this.dependencies.service.acceptIncomingMessage(bootstrap)).right).toEqual({
            kind: 'control',
            handled: false
        });
        const admission = this.createSeedingAdmission();
        for (const message of createBackgroundMessages()) {
            const admitted = await admission.attempt(message, { kind: 'trusted-server' }, planIncomingMessage);
            if (admitted.right?.kind !== 'completed' || !admitted.right.wroteWork) {
                throw new Error(`Failed to seed background delivery ${message.id.msgId}`);
            }
        }
        this.dependencies.queueEngine.start();
        return await this.dependencies.waitForFirstBatch();
    }

    async admitRtcSignalThroughRealConflict(): Promise<RtcControlHandoffFixture.ConflictedAdmission> {
        const peerStartedAtMs = BATCH_STARTED_AT_MS + 18_539;
        this.dependencies.locks.setNowMs(BATCH_STARTED_AT_MS + 29_947);
        const signal = createRtcSignal();
        const commit = this.dependencies.inboundStores.admissionStore.commitBundle.bind(
            this.dependencies.inboundStores.admissionStore
        );
        const conflict = vi.spyOn(
            this.dependencies.inboundStores.admissionStore,
            'commitBundle'
        ).mockImplementationOnce(async (bundle) => {
            const prior = await commit({
                ...bundle,
                mutations: bundle.mutations.filter((mutation) => mutation.kind === 'set-msg-owner'),
                durableEffects: []
            });
            if (prior !== 'committed' || await commit(bundle) !== 'conflict') {
                throw new Error('Failed to create the real conditional admission conflict');
            }
            return 'conflict';
        });
        const pending = await this.dependencies.service.acceptIncomingMessage(signal);
        conflict.mockRestore();
        expect(pending.right).toEqual({ kind: 'pending-admission' });
        return { signal, peerStartedAtMs };
    }

    async expectRtcDeliveryBeforeControlLocks(
        admission: RtcControlHandoffFixture.ConflictedAdmission
    ): Promise<void> {
        this.dependencies.releaseFirstBatch();
        for (let pass = 0; pass < 20; pass += 1) {
            await this.dependencies.queueEngine.executeOnce();
            await Promise.resolve();
        }
        await expect.poll(
            async () => {
                await this.dependencies.queueEngine.executeOnce();
                return this.hasCompletedAdmission(admission.signal);
            },
            { timeout: 10_000 }
        ).toBe(true);
        await expect.poll(async () => {
            await this.dependencies.queueEngine.executeOnce();
            return this.dependencies.observations.rtcDeliveredAtMs;
        }, { timeout: 10_000 }).toBeDefined();
        await expect.poll(async () => {
            await this.dependencies.queueEngine.executeOnce();
            return this.completedControlCount();
        }, { timeout: 10_000 }).toBe(BACKGROUND_CONTROL_COUNT);
        expect(this.dependencies.observations.controlSendCount).toBe(BACKGROUND_CONTROL_COUNT);
        expect(this.dependencies.observations.controlStatuses).toEqual(
            Array.from({ length: BACKGROUND_CONTROL_COUNT }, () => 'pending-admission')
        );
        expect(this.dependencies.locks.count()).toBe(0);
        expect(this.dependencies.observations.rtcDeliveredAtMs).toBeLessThanOrEqual(
            admission.peerStartedAtMs + DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY.timeoutMs
        );
    }

    async releaseControlLocksAndExpectExactDrain(): Promise<void> {
        this.dependencies.locks.release();
        await expect.poll(async () => {
            await this.dependencies.queueEngine.executeOnce();
            return this.dependencies.locks.count();
        }, { timeout: 10_000 }).toBe(BACKGROUND_CONTROL_COUNT);
        await expect.poll(async () => {
            await this.dependencies.queueEngine.executeOnce();
            return this.dependencies.socket.sent
                .map(decodePersistedALMessage)
                .filter((message) => message.payload.typeId.startsWith('al.control.')).length;
        }, { timeout: 10_000 }).toBe(BACKGROUND_CONTROL_COUNT);
    }

    private createSeedingAdmission(): ALInboundMessageAdmission {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'self',
            stores: this.dependencies.inboundStores,
            queueEngine: this.dependencies.queueEngine,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const admission = new ALInboundMessageAdmission({
            ...resources,
            planIncomingMessage,
            workPort: createTestALInboundWorkPort({
                admissionStore: this.dependencies.inboundStores.admissionStore,
                workQueue: this.dependencies.inboundStores.workQueue,
                nowMs: Date.now
            })
        });
        onTestFinished(() => admission.dispose());
        return admission;
    }

    private hasCompletedAdmission(signal: ALMessage): boolean {
        return this.dependencies.claimTrace.some((event) =>
            event.phase === 'released' && event.kind === 'admit-message' &&
            event.effectId === toALInboundPendingAdmissionId(signal) && event.status === EntityStatus.COMPLETED
        );
    }

    private completedControlCount(): number {
        return this.dependencies.claimTrace.filter((event) =>
            event.phase === 'released' && event.kind === 'send-control' && event.status === EntityStatus.COMPLETED
        ).length;
    }
}

interface RtcAdmissionStores {
    readonly inbound: ALInboundRuntimeStores;
    readonly outbound: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
}

async function createRtcAdmissionStores(): Promise<RtcAdmissionStores> {
    const database = { dbName: `signaling-pending-${crypto.randomUUID()}`, namespace: 'browser-ws' };
    const inbound = createDefaultIndexedDbALInboundRuntimeStores({ ...database, nowMs: Date.now });
    const outbound = createDefaultIndexedDbALOutboundRuntimeStores({
        ...database,
        nowMs: Date.now,
        decodePrepared: decodeALOutboundTransportMessage
    });
    await Promise.all([inbound.admissionStore.ready(), outbound.admissionStore.ready()]);
    return { inbound, outbound };
}

interface ConnectWsQueueBoxServiceInput extends RtcAdmissionStores {
    readonly queueEngine: InboxOutboxEngine;
}

interface ConnectedWsQueueBoxService {
    readonly socket: TestWebSocket;
    readonly service: WsQueueBoxClientService;
}

async function connectWsQueueBoxService(
    input: ConnectWsQueueBoxServiceInput
): Promise<ConnectedWsQueueBoxService> {
    const client = new JsonWebSocketClient('ws://pending-signaling-test', createPassThroughTransportFaultPort());
    const connecting = client.connect();
    await Promise.resolve();
    const socket = TestWebSocket.instances.at(-1);
    if (!socket) {
        throw new Error('Expected the signaling test WebSocket to be created');
    }
    socket.open();
    await connecting;
    const service = createDefaultWsQueueBoxClientService({
        socket: client,
        outbox: new InMemoryQueueBox(),
        sessionId: 'self',
        inboundStores: input.inbound,
        outboundStores: input.outbound,
        queueEngine: input.queueEngine
    }).enableDefaultCallbacks();
    return { socket, service };
}

async function observeRtcControlTraffic(
    service: WsQueueBoxClientService,
    observations: RtcControlHandoffFixture.Observations
): Promise<void> {
    const sendControl = service.enqueueOutboxIfAbsent.bind(service);
    vi.spyOn(service, 'enqueueOutboxIfAbsent').mockImplementation(async (message) => {
        observations.controlSendCount += 1;
        const result = await sendControl(message);
        observations.controlStatuses.push(result.status);
        return result;
    });
    const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc');
    await transport.connect({
        sessionId: 'self',
        token: 'test-token',
        callbacks: {
            onOpen: async () => {},
            onClose: async () => {},
            onError: async () => {},
            onMessage: async () => {
                observations.rtcDeliveredAtMs = Date.now();
            }
        }
    });
}

interface TraceInboundClaimsInput {
    readonly queue: QueueBoxResourceEntryRepository;
    readonly namespace: string;
    readonly trace: InboundClaimTrace[];
    readonly onFirstBatch: (claims: readonly InboundClaimTrace[]) => Promise<void>;
}

function traceInboundClaims(input: TraceInboundClaimsInput): void {
    const reserveEntries = input.queue.reserveEntries.bind(input.queue);
    const releaseEntries = input.queue.releaseEntries.bind(input.queue);
    let reservationBatch = 0;
    vi.spyOn(input.queue, 'reserveEntries').mockImplementation(async (request: ResourceInboxReservationRequest) => {
        const reserved = await reserveEntries(request);
        const inbound = [...reserved.values()].filter((entry) => entry.typeId === toALInboundWorkType(input.namespace));
        if (inbound.length > 0) {
            reservationBatch += 1;
        }
        const claims = inbound.map((entry): InboundClaimTrace => {
            const effect = decodeALInboundWorkEntry(entry, input.namespace);
            return {
                phase: 'reserved',
                batch: reservationBatch,
                atMs: Date.now(),
                effectId: effect.effectId,
                kind: effect.payload.kind,
                status: undefined
            };
        });
        input.trace.push(...claims);
        if (reservationBatch === 1) {
            await input.onFirstBatch(claims);
        }
        return reserved;
    });
    vi.spyOn(input.queue, 'releaseEntries').mockImplementation(async (
        entries: Parameters<QueueBoxResourceEntryRepository['releaseEntries']>[0],
        disposition: ResourceInboxReleaseDisposition
    ) => {
        const released = await releaseEntries(entries, disposition);
        for (const entry of entries.filter((candidate) => candidate.typeId === toALInboundWorkType(input.namespace))) {
            const effect = decodeALInboundWorkEntry(entry, input.namespace);
            input.trace.push({
                phase: 'released',
                batch: reservationBatch,
                atMs: Date.now(),
                effectId: effect.effectId,
                kind: effect.payload.kind,
                status: disposition.status
            });
        }
        return released;
    });
}

const planIncomingMessage: ALInboundMessageRuntime.Dependencies['planIncomingMessage'] = (
    message,
    source,
    observations
) => planALMessageHandling(message, {
    ...observations,
    selfPeerId: 'self',
    fromPeerId: source.kind === 'trusted-server' ? message.id.senderId : source.peerId,
    connectedPeerIds: ['self']
});

function createBackgroundMessages(): readonly ALMessage[] {
    return Array.from({ length: BACKGROUND_CONTROL_COUNT }, (_, index) =>
        newALUnicastMessage(
            `background-peer-${index}`,
            newALEventRoute('background', 'self'),
            'self',
            'background',
            { index },
            { ttlMs: 60_000, qos: { ack: { algo: 'hop' } } }
        ));
}

function createRtcSignal(): ALMessage {
    return newALUnicastMessage(
        'peer-c',
        newALEventRoute('rtc', 'self'),
        'self',
        'rtc',
        {
            channel: QRtcSignalingChannel.RtcSignal,
            type: QRtcSignalingMsgType.Signal,
            fromId: 'peer-c',
            toId: 'self',
            sessionId: 'self',
            token: 'test-token',
            signalType: QRtcSignalingType.IceCandidate,
            payload: { candidate: { candidate: 'test-candidate' } }
        }
    );
}
