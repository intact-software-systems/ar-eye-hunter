import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { createApiV1WsReceiptObserver } from '../../../apps/api-v1/src/composition/create-api-v1-ws-receipt-observer.ts';
import { createConsoleRallarTimingSink } from '../../shared-server/rallar-system/observability/timing.ts';
import { installQueueBoxPubSubBridge } from '../../shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import { AL_WS_SERVER_CAPABILITIES, toALCarrierQosInputProvider } from '../../shared/al-contracts/al-carrier-capabilities.ts';
import { isRoomScopedALMessage, type ALMessage } from '../../shared/al-contracts/al-contract.ts';
import { decodeALControlMessage, newALAckControlMessage } from '../../shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '../../shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../../shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '../../shared/alm/ALStoreRetention.ts';
import { createDefaultALInboundRuntimeResources } from '../../shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '../../shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { AL_OUTBOUND_COMMIT_ATTEMPTS } from '../../shared/alm/outbound/control/al-outbound-control-admission.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '../../shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from '../../shared/alm/outbound/to-al-outbound-effect-id.ts';
import { createInMemoryALReceiptRecordStores } from '../../shared/alm/receipt-record/al-receipt-record-stores.ts';
import { decodeALReceiptRecordWorkEntry } from '../../shared/alm/receipt-record/al-receipt-record-work-entry.ts';
import { EnqueuedType } from '../../shared/api/api-config.ts';
import type {
    ResourceInboxReservationObservationRequest,
    ResourceInboxReservationObservationResult,
    ResourceInboxReservationRequest
} from '../../shared/queuebox/queue-box-types.ts';
import type { Key, ResourceEntry } from '../../shared/queuebox/ResourceEntry.ts';
import { Either } from '../../shared/resilience/Either.ts';
import { createDefaultBackgroundTimers } from '../../shared/resilience/timers.ts';
import { toError } from '../../shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '../../shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '../../shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '../../shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '../../shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import type {
    WsQueueBoxServerReceiptObservation,
    WsQueueBoxServerReceiptObserver
} from '../../shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';
import { WsQueueBoxServerService } from '../../shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '../../shared/websocket/json-web-socket-server.ts';
import { SimulatedWebSocket } from '../shared/native-websocket-fixture.ts';

import { reserveNoResourceEntries } from '../shared/reserve-no-resource-entries.ts';

import { toTestALAckPayload } from '../al-control-test-payloads.ts';
import { toCompetingOutboundMessageCommit } from '../shared/alm/outbound-competing-message-commit.ts';
import { attachTestWebSocket } from '../shared/websocket/attach-test-web-socket.ts';

export type ReceiptOwnerScenario = 'native-return' | 'later-throw' | 'closed' | 'native-throw' | 'publish-return' | 'publish-throw' | 'direct-failure';

export type ReceiptOwnerSink = 'collecting' | 'mutating' | 'throwing' | 'disabled' | 'unsafe' | 'unsafe-transport' | 'unsafe-publication' | 'clock-mutating';

interface ReceiptOwnerSocket {
    readonly socket: JsonWebSocketServer;
    readonly origin: SimulatedWebSocket;
}

const scope = { applicationId: 'app', workspaceId: 'workspace' };
/** Each wait is inside the child's 15 s spawn limit, and so are the two drains' waits together. */
const AWAITED_FACT_TIMEOUT_MS = 5_000;
/** A pass that claims nothing returns at once, so a dequeue no pass hands out within this many fails the run. */
const MAX_DEQUEUE_PASSES = 1_000;

export async function writePendingReceiptOwnerEvidence(
    evidencePath: string,
    scenario: ReceiptOwnerScenario = 'native-return',
    sink: ReceiptOwnerSink = 'collecting'
): Promise<void> {
    const actualNow = Date.now;
    const clock: ReceiptOwnerFixture.Clock = { nowMs: 1700000000000, reads: 0 };
    Date.now = () => clock.nowMs;
    try {
        const fixture = new ReceiptOwnerFixture(await createSocket(), clock, sink);
        let bodyFailed = false;
        try {
            await fixture.run(evidencePath, scenario);
        }
        catch (caught) {
            bodyFailed = true;
            throw toError(caught);
        }
        finally {
            await fixture.dispose().catch((caught) => {
                const cleanupError = toError(caught);
                if (!bodyFailed) {
                    throw cleanupError;
                }
                try {
                    console.error('Receipt owner cleanup failed after body failure:', cleanupError);
                }
                catch { /* Diagnostic failure cannot replace the original body error. */ }
            });
        }
    }
    finally {
        Date.now = actualNow;
    }
}

namespace ReceiptOwnerFixture {
    export interface Clock {
        nowMs: number;
        reads: number;
    }

    export interface Effects {
        conflicted: boolean;
        receiptControlMsgId: string;
        nativeCalls: number;
        publications: number;
        receiptKey: string;
        clockReads: number;
        /** The engine passes the run made after the restore, the last of them the one that claimed the dequeue. */
        enginePasses: number;
        releases: number;
        lastReceiptReleaseAtMs: number;
        readonly receiptReleaseStatuses: string[];
        readonly mutationResults: boolean[];
    }
}

/** Owns only test ports and independent effects; production owns every admission, claim and send. */
class ReceiptOwnerFixture {
    readonly backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    readonly store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'receipt-owner',
        namespace: 'receipt-owner',
        backend: this.backend,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    readonly effects: ReceiptOwnerFixture.Effects = {
        conflicted: false,
        receiptControlMsgId: '',
        nativeCalls: 0,
        publications: 0,
        receiptKey: '',
        clockReads: 0,
        enginePasses: 0,
        releases: 0,
        lastReceiptReleaseAtMs: 0,
        receiptReleaseStatuses: [],
        mutationResults: []
    };
    readonly observations: WsQueueBoxServerReceiptObservation[] = [];
    readonly engine = new InboxOutboxEngine();
    readonly receiptRecordStores = createInMemoryALReceiptRecordStores('server', () => this.clock.nowMs);
    /** Resolved by the record's first ended-work release; its own batch, which no engine pass awaits, makes it. */
    readonly endedWorkReleased = Promise.withResolvers<void>();
    /** Resolved by the complete receipt's transport: its transport observation, or for a sink that observes nothing, its native send. */
    readonly receiptTransported = Promise.withResolvers<void>();
    /** Resolved by the release of the complete receipt's own send work, which follows its transport in every scenario. */
    readonly receiptSendReleased = Promise.withResolvers<void>();
    /** Resolved by the first release of the complete receipt's work after the restore: its retained admission's. */
    readonly receiptAdmissionReleased = Promise.withResolvers<void>();
    readonly service: WsQueueBoxServerService;
    readonly socket: JsonWebSocketServer;
    readonly origin: SimulatedWebSocket;
    readonly clock: ReceiptOwnerFixture.Clock;
    readonly sink: ReceiptOwnerSink;
    readonly reserve = toObservedReserveEntries(this.backend, (entries) => this.observeReservation(entries));
    /** Set by the first release of the complete receipt's work after the restore, as `receiptAdmissionReleased` resolves. */
    receiptAdmissionWasReleased = false;
    /** Set when a claim hands out the complete receipt's work after its retained admission was released: its dequeue. */
    receiptDequeueClaimed = false;
    readonly recover = this.backend.workQueue.reserveTimeoutEntries.bind(this.backend.workQueue);
    readonly observer: WsQueueBoxServerReceiptObserver | undefined;
    readonly observe: ((event: WsQueueBoxServerReceiptObservation) => void) | undefined;

    constructor(sockets: ReceiptOwnerSocket, clock: ReceiptOwnerFixture.Clock, sink: ReceiptOwnerSink) {
        this.socket = sockets.socket;
        this.origin = sockets.origin;
        this.clock = clock;
        this.sink = sink;
        this.observer = createApiV1WsReceiptObserver({
            enabled: sink !== 'disabled',
            timing: createConsoleRallarTimingSink({ enabled: true }),
            serviceId: 'api-process',
            publisherId: 'publisher-1'
        });
        this.observe = sink === 'disabled' ? undefined : (event) => this.recordObservation(event);
        this.holdClaims();
        this.observeEndedWorkRelease();
        installReceiptConflict(this.store, this.effects);
        this.service = this.createServer();
        this.service.authorizeInboundMessagesWith({
            authorize: async (message) =>
                isRoomScopedALMessage(message)
                    ? ({ authorized: true, roomAudience: { recipientPeerIds: ['recipient'], snapshotVersion: 7 } })
                    : ({ authorized: true }),
            sendNacks: false
        });
    }

    private createServer(): WsQueueBoxServerService {
        return new WsQueueBoxServerService({
            creationNow: Temporal.Now.instant,
            name: 'server',
            socket: this.socket,
            qosProvider: toALCarrierQosInputProvider(AL_WS_SERVER_CAPABILITIES, undefined),
            inboundRuntime: createDefaultALInboundRuntimeResources({
                queueEngine: this.engine,
                selfPeerId: 'server',
                toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX, Temporal.Now.instant())
            }),
            outboundRuntime: createDefaultALOutboundRuntimeResources({
                queueEngine: this.engine,
                stores: { admissionStore: this.store, workQueue: this.backend.workQueue },
                decodePrepared: decodeWsQueueBoxServerPreparedMessage,
                nowMs: () => {
                    this.clock.reads += 1;
                    return this.clock.nowMs;
                }
            }),
            receiptRecordStores: this.receiptRecordStores,
            dequeueResilience: createDefaultALOutboundDequeueResilience(),
            receiptObserver: this.observe,
            readAuthenticatedConnectionScope: () => ({ scope, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }),
            targetResolver: {
                requiresFrozenAudience: () => false,
                resolveBroadcastRecipients: () => [{ peerId: 'recipient', connectionId: 'recipient' }],
                resolvePeerRecipients: (peerId) => this.socket.connections.get(peerId)?.isOpen ? [{ peerId, connectionId: peerId }] : []
            },
            readProducerProvenance: undefined,
            capturedRecipientEligibilityFilters: undefined,
            timers: createDefaultBackgroundTimers(),
            outboundDiagnostics: undefined,
            outboundSettlements: undefined,
            inboundDiagnostics: undefined,
            outboundDeliveryOutcome: undefined,
            deliveryDiagnostics: undefined,
            authorizeInboundMessage: Either.ofRight,
            forwardsRoomScopedMessages: true
        });
    }

    async run(evidencePath: string, scenario: ReceiptOwnerScenario): Promise<void> {
        await generateCompleteReceipt(this.service);
        // The record's ended work delivers the complete receipt, whose first commit conflicts and is retained as work.
        // The conflict is set inside that commit. The ended work runs in the batch its end's commit started
        // (`#worker.committed`), which no engine pass awaits: the fixture awaits that work's own release, after which
        // the work has observed what it issued, and runs no engine pass meanwhile, so every sink's run reads the clock
        // alike.
        await awaitFact(this.endedWorkReleased.promise, 'The receipt record\'s ended work was never released');
        const pending = this.observations.find((event) => event.kind === 'receipt-outbox' && event.receipt.phase === 'complete');
        if (this.sink !== 'disabled') {
            assert.equal(pending?.kind === 'receipt-outbox' && pending.verdict.kind, 'pending');
        }
        assert.equal(this.effects.conflicted, true);
        assert.equal(await this.store.readSentMessage(this.effects.receiptControlMsgId), undefined);
        // The origin is connected here, so its admitted receipt was written to its socket at admission; the complete
        // receipt's send has not run.
        assert.deepEqual(this.origin.sent.map(toReceiptPhase), ['admitted']);
        this.configureNative(scenario);
        if (scenario.startsWith('publish') || scenario === 'direct-failure') {
            await this.installPublication(scenario);
        }
        this.backend.workQueue.reserveEntries = this.reserve;
        this.backend.workQueue.reserveTimeoutEntries = this.recover;
        // The clock stands still, so the retained receipt is ready and the first engine pass after the restore claims its
        // admission work, alone: the admitted receipt went to the origin's socket and left no row. The dequeue that
        // admission makes claimable waits for a pass, and the engine runs none of its own here, so the fixture awaits
        // the admission's release and then runs passes until one hands out the dequeue (a pass while the admission's
        // batch still runs answers no work). The send follows in a batch the dequeue starts, which the pass does not
        // await. The fixture awaits the send's transport and release and runs no further pass; it states the number of
        // passes, which every sink's run must match, as it does the clock reads they make.
        await this.engine.executeOnce();
        await awaitFact(this.receiptAdmissionReleased.promise, 'The complete receipt\'s retained admission was never released');
        this.effects.enginePasses = 1 + await this.runPassesUntilDequeueClaimed();
        await Promise.all([
            awaitFact(this.receiptTransported.promise, 'The actual generated complete receipt did not reach its transport owner'),
            awaitFact(this.receiptSendReleased.promise, 'The complete receipt\'s send work was never released')
        ]);
        this.assertTransportEffects(scenario);
        this.clock.nowMs = 1700000000000;
        assert.ok(await this.store.readSentMessage(this.effects.receiptControlMsgId));
        this.effects.clockReads = this.clock.reads;
        await writeFile(evidencePath, JSON.stringify(this.effects));
    }

    async dispose(): Promise<void> {
        const outcomes = await Promise.allSettled([this.service.dispose(), this.engine.stop()]);
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    }

    private holdClaims(): void {
        this.backend.workQueue.reserveEntries = reserveNoResourceEntries;
        this.backend.workQueue.reserveTimeoutEntries = async () => new Map();
        const release = this.backend.workQueue.releaseEntries.bind(this.backend.workQueue);
        this.backend.workQueue.releaseEntries = async (releases) => {
            const releasesReceipt = releases.some((value) => value.entry.resource.includes(this.effects.receiptControlMsgId));
            if (releasesReceipt) {
                this.effects.lastReceiptReleaseAtMs = Date.now();
            }
            const result = await release(releases);
            this.effects.releases += releases.length;
            for (const entry of result.values()) {
                if (entry.resource.includes(this.effects.receiptControlMsgId)) {
                    this.effects.receiptReleaseStatuses.push(entry.status);
                }
            }
            if (releases.some((value) => isSendWorkOf(value.entry, this.effects.receiptControlMsgId))) {
                this.receiptSendReleased.resolve();
            }
            if (releasesReceipt && this.backend.workQueue.reserveEntries === this.reserve) {
                this.receiptAdmissionWasReleased = true;
                this.receiptAdmissionReleased.resolve();
            }
            return result;
        };
    }

    /** The passes run until one hands out the complete receipt's dequeue; a bound that passes fails the run loudly. */
    private async runPassesUntilDequeueClaimed(): Promise<number> {
        for (let passes = 1; passes <= MAX_DEQUEUE_PASSES; passes += 1) {
            await this.engine.executeOnce();
            if (this.receiptDequeueClaimed) {
                return passes;
            }
        }
        throw new Error(`No engine pass of ${MAX_DEQUEUE_PASSES} claimed the complete receipt's dequeue`);
    }

    private observeReservation(entries: readonly ResourceEntry[]): void {
        if (this.receiptAdmissionWasReleased && entries.some((entry) => entry.resource.includes(this.effects.receiptControlMsgId))) {
            this.receiptDequeueClaimed = true;
        }
    }

    private observeEndedWorkRelease(): void {
        const { backend: { workQueue }, namespace } = this.receiptRecordStores;
        const release = workQueue.releaseEntries.bind(workQueue);
        workQueue.releaseEntries = async (releases) => {
            const result = await release(releases);
            if (releases.some((value) => decodeALReceiptRecordWorkEntry(value.entry, namespace).kind === 'ended')) {
                this.endedWorkReleased.resolve();
            }
            return result;
        };
    }

    private recordObservation(event: WsQueueBoxServerReceiptObservation): void {
        this.observations.push(event);
        if (event.kind === 'receipt-transport' && event.receiptControlMsgId === this.effects.receiptControlMsgId) {
            this.receiptTransported.resolve();
        }
        this.observer?.(this.toCapturedObservation(event));
        // Every observation that carries a receipt, the live admitted's transport first.
        if ('receipt' in event && this.sink === 'mutating') {
            this.effects.mutationResults.push(Reflect.set(event.receipt.confirmedRecipientPeerIds, '0', 'forged'));
            this.effects.mutationResults.push(Reflect.set(event, 'receiptControlMsgId', 'forged'));
        }
        if (this.sink === 'clock-mutating' && event.kind === 'receipt-transport' && event.receiptControlMsgId === this.effects.receiptControlMsgId) {
            this.clock.nowMs += 90_000;
        }
        if (this.sink === 'throwing') {
            throw new Error('observer failure');
        }
    }

    private toCapturedObservation(event: WsQueueBoxServerReceiptObservation): WsQueueBoxServerReceiptObservation {
        if (this.sink === 'unsafe' && event.kind === 'receipt-work') {
            return { ...event, workLocator: 'unsafe identity sentinel' };
        }
        // Every control's transport, so the live admitted's first and the complete control's after it.
        if (this.sink === 'unsafe-transport' && event.kind === 'receipt-transport') {
            return { ...event, connectionId: 'unsafe identity sentinel' };
        }
        if (this.sink === 'unsafe-publication' && event.kind === 'receipt-publication') {
            return { ...event, publisherId: 'unsafe identity sentinel' };
        }
        return event;
    }

    private configureNative(scenario: ReceiptOwnerScenario): void {
        const nativeSend = this.origin.send.bind(this.origin);
        this.origin.send = (data) => {
            this.effects.nativeCalls += 1;
            // An observing sink's run waits for the transport observation instead, which its batch publishes after
            // the release: returning at the send would leave that observation to land after the run reset the clock.
            if (this.observe === undefined && typeof data === 'string' && data.includes(this.effects.receiptControlMsgId)) {
                this.receiptTransported.resolve();
            }
            if (scenario === 'native-throw' || scenario === 'direct-failure') {
                throw new Error('native fixture failure');
            }
            return nativeSend(data);
        };
        if (scenario === 'later-throw') {
            const encode = this.socket.encode.bind(this.socket);
            this.socket.encode = (value) => {
                const encoded = encode(value);
                let reads = 0;
                return {
                    get text() {
                        reads += 1;
                        if (reads > 1) {
                            throw new Error('after native return');
                        }
                        return encoded.text;
                    }
                };
            };
        }
        if (scenario === 'closed') {
            const encode = this.socket.encode.bind(this.socket);
            this.socket.encode = (value) => {
                this.origin.close();
                return encode(value);
            };
        }
    }

    private async installPublication(scenario: ReceiptOwnerScenario): Promise<void> {
        this.socket.connections.delete('origin');
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: this.service,
            channel: 'receipt-test',
            publisherId: 'publisher-1',
            receiptObserver: this.observe,
            bridge: {
                subscribe: async () => {},
                publish: async (_channel, message) => {
                    this.effects.publications += 1;
                    if (scenario === 'publish-throw') {
                        throw new Error('publisher fixture failure');
                    }
                    if (scenario === 'direct-failure' && JSON.stringify(message.key) === this.effects.receiptKey) {
                        attachTestWebSocket(this.socket, new ConnectionContext({ id: 'origin', socket: this.origin }));
                    }
                }
            }
        });
    }

    private assertTransportEffects(scenario: ReceiptOwnerScenario): void {
        if (scenario === 'native-return') {
            assert.ok(this.origin.sent.some((text) => text.includes(this.effects.receiptControlMsgId)));
        }
        if (scenario === 'native-throw' || scenario === 'direct-failure') {
            assert.ok(this.effects.nativeCalls > 0);
        }
        if (scenario === 'closed' || scenario === 'publish-return' || scenario === 'publish-throw') {
            assert.equal(this.effects.nativeCalls, 0);
        }
        if (scenario.startsWith('publish') || scenario === 'direct-failure') {
            assert.ok(this.effects.publications > 0);
        }
    }
}

function installReceiptConflict(
    store: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>,
    effects: Pick<ReceiptOwnerFixture.Effects, 'conflicted' | 'receiptControlMsgId' | 'receiptKey'>
): void {
    const commit = store.commitBundle.bind(store);
    let lostAttempts = 0;
    // Another commit of the complete receipt's own control lands before each of its attempts, so it loses every one on
    // that control's version and is retained.
    const commitWithConflict: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>['commitBundle'] = async (bundle) => {
        const message = bundle.canonicalEntry === undefined ? undefined : decodePersistedALMessage(bundle.canonicalEntry.resource);
        const control = message && decodeALControlMessage(message).right;
        if (
            lostAttempts < AL_OUTBOUND_COMMIT_ATTEMPTS && bundle.pendingAdmission === undefined && message &&
            control?.type === 'receipt' && control.payload.phase === 'complete'
        ) {
            lostAttempts += 1;
            effects.conflicted = true;
            effects.receiptControlMsgId = message.id.msgId;
            effects.receiptKey = JSON.stringify(bundle.canonicalEntry?.key);
            assert.equal(await commit(toCompetingOutboundMessageCommit(bundle)), 'committed');
            const result = await commit(bundle);
            assert.equal(result, 'conflict');
            return result;
        }
        return await commit(bundle);
    };
    assert.equal(Reflect.set(store, 'commitBundle', commitWithConflict), true);
}

async function generateCompleteReceipt(service: WsQueueBoxServerService): Promise<void> {
    assert.equal((await service.acceptIncomingMessage(createReceiptSubject(), 'origin')).right?.kind, 'admitted');
    const ack = newALAckControlMessage(
        { v: 4, msgId: 'ack-1', senderId: 'recipient', ts: Date.now(), traceId: 'trace-full-stack-api-receipt-owner-fixture' },
        toTestALAckPayload({
            ackedMsgId: 'subject',
            originPeerId: 'origin',
            fromPeerId: 'recipient',
            toPeerId: 'origin',
            logicalRecipientPeerId: 'recipient',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        })
    );
    assert.equal((await service.acceptIncomingMessage(ack, 'recipient')).right?.kind, 'control');
}

/** The phase of a receipt frame written to a socket. */
function toReceiptPhase(frame: string): string | undefined {
    const control = decodeALControlMessage(decodePersistedALMessage(frame)).right;
    return control?.type === 'receipt' ? control.payload.phase : undefined;
}

/** The backend's own claim, which hands every entry it reserves to `onReserved` before it answers. */
function toObservedReserveEntries(
    backend: InMemoryAdmissionBackend,
    onReserved: (entries: readonly ResourceEntry[]) => void
): InMemoryAdmissionBackend['workQueue']['reserveEntries'] {
    const reserve = backend.workQueue.reserveEntries.bind(backend.workQueue);
    function observed(request: ResourceInboxReservationObservationRequest): Promise<ResourceInboxReservationObservationResult>;
    function observed(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>>;
    async function observed(
        request: ResourceInboxReservationRequest | ResourceInboxReservationObservationRequest
    ): Promise<Map<Key, ResourceEntry> | ResourceInboxReservationObservationResult> {
        if ('reservationObservation' in request) {
            const result = await reserve(request);
            onReserved([...result.entries.values()]);
            return result;
        }
        const reserved = await reserve(request);
        onReserved([...reserved.values()]);
        return reserved;
    }
    return observed;
}

/** A work row names its effect, a send's beginning with the message it sends; a canonical message row names none. */
function isSendWorkOf(entry: ResourceEntry, msgId: string): boolean {
    return decodeWorkEffectId(JSON.parse(entry.resource))?.startsWith(`${toALOutboundEffectId(['send', msgId])}:`) === true;
}

function decodeWorkEffectId(stored: unknown): string | undefined {
    if (typeof stored !== 'object' || stored === null) {
        return undefined;
    }
    const effectId = Reflect.get(stored, 'effectId');
    return typeof effectId === 'string' ? effectId : undefined;
}

/** A bounded wait: a fact that never happens fails the run loudly, naming it, instead of hanging it. */
async function awaitFact(fact: Promise<void>, missing: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(missing)), AWAITED_FACT_TIMEOUT_MS);
    });
    try {
        await Promise.race([fact, timedOut]);
    }
    finally {
        clearTimeout(timer);
    }
}

function createReceiptSubject(): ALMessage {
    return {
        id: { v: 4, msgId: 'subject', senderId: 'origin', ts: Date.now(), traceId: 'trace-full-stack-api-receipt-owner-fixture' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: 'room' },
        targets: { mode: 'broadcast', scope: 'room', groupRef: { ...scope, groupId: 'room' } },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

async function createSocket(): Promise<ReceiptOwnerSocket> {
    const socket = new JsonWebSocketServer();
    const origin = new SimulatedWebSocket('ws://origin');
    const recipient = new SimulatedWebSocket('ws://recipient');
    await origin.open();
    await recipient.open();
    attachTestWebSocket(socket, new ConnectionContext({ id: 'origin', socket: origin }));
    attachTestWebSocket(socket, new ConnectionContext({ id: 'recipient', socket: recipient }));
    return { socket, origin };
}
