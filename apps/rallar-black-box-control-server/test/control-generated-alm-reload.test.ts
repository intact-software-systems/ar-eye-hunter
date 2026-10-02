import { assert, assertEquals } from '@std/assert';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestFaultInjectCommand,
    RallarBlackBoxTestMessagesReplayCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { ALDeliveryCarrierFallback } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import { createAlmConformance2AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertRight,
    toControlServiceInput,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

type MessagesPortKind = 'messages.send' | 'messages.observe' | 'messages.cancel' | 'messages.receipts' | 'messages.received';

type PortCommand<TKind extends RallarBlackBoxTestCommand['kind']> = Extract<RallarBlackBoxTestCommand, Readonly<{ kind: TKind; }>>;

interface PortMessage {
    readonly command: RallarBlackBoxTestMessagesSendCommand;
    readonly msgId: string;
    state: string;
    submitted: boolean;
    attemptCarriers: readonly ('rtc' | 'ws')[];
    attemptOutcomes: readonly ('not-ready' | 'sent')[];
    /** The volatile bound's refusal or a refused durable send under a storage quota; undefined for every send admitted. */
    readonly failure:
        | Readonly<{ kind: 'refused'; reason: 'capacity'; }>
        | Readonly<{ kind: 'storage-unavailable'; cause: 'quota'; }>
        | undefined;
    carrierFallback: ALDeliveryCarrierFallback | undefined;
    /** A durable send a volatile channel admitted volatile while its storage was full. */
    readonly durabilityDowngrade: Readonly<{ requested: string; cause: 'quota'; }> | undefined;
}

interface HandedOverOutcome {
    readonly outcome: 'committed' | 'not-handled';
    readonly reason: 'admitted' | 'duplicate';
    /** The last outcome of each carrier's attempt row: a `not-ready` run ends the RTC leg of a dropped send. */
    readonly attemptOutcomes: readonly ('not-ready' | 'sent')[];
    readonly fallbackReason: 'not-ready' | 'receipt-exhausted';
}

/**
 * D56: the first RTC leg of these sends never completes (its frames are dropped, or the receiver withholds its ACK until
 * the receipt runs out), so each hands over to WS. The receiver admits the WS copy, or refuses it as a duplicate of the
 * RTC copy it already delivered. An addressed `unicast-fallback` hands over the same way.
 */
const HANDED_OVER_WS_OUTCOMES: Readonly<Record<string, HandedOverOutcome>> = {
    'fallback-within-deadline': {
        outcome: 'committed',
        reason: 'admitted',
        attemptOutcomes: ['not-ready', 'sent'],
        fallbackReason: 'not-ready'
    },
    'receipt-exhausted-fallback': {
        outcome: 'not-handled',
        reason: 'duplicate',
        attemptOutcomes: ['sent', 'sent'],
        fallbackReason: 'receipt-exhausted'
    },
    'unicast-fallback': {
        outcome: 'committed',
        reason: 'admitted',
        attemptOutcomes: ['not-ready', 'sent'],
        fallbackReason: 'not-ready'
    }
};

/** Controlled external facts prove recipe/control composition, never native storage or transport behavior. */
class GeneratedAlmPorts {
    now = 1_000;
    senderDocument = 100;
    /** IndexedDB admission writes per page since its last reset: only a send that opts into a durability writes. */
    readonly writes = { sender: 1, receiver: 1 };
    readonly inboxAdmitted = new Set<string>();
    readonly messages: PortMessage[] = [];
    readonly handles = new Map<string, PortMessage>();
    readonly holds = new Map<string, string>();
    /** A held storage fault fails every durable admission of the sender's page with a quota error. */
    storageQuota = false;
    storageFailing = false;
    readonly receiver: RallarBlackBoxTestRuntime;
    sender: RallarBlackBoxTestRuntime;
    private absence: { duration: number; release: () => void; } | undefined;
    private entered = Promise.withResolvers<void>();
    private holdNextSleep = false;
    private readonly replacesDocument: boolean;

    constructor(replacesDocument: boolean) {
        this.replacesDocument = replacesDocument;
        this.receiver = this.createRuntime('receiver');
        this.sender = this.createRuntime('sender');
    }

    beginAbsence(): Promise<void> {
        this.entered = Promise.withResolvers<void>();
        this.holdNextSleep = true;
        return this.entered.promise;
    }

    finishAbsence(): void {
        assert(this.absence);
        assertEquals(this.absence.duration, 17_000, 'the authored absence window is unchanged');
        this.now += this.absence.duration;
        this.absence.release();
        this.absence = undefined;
    }

    replaceSenderDocument(): void {
        if (this.replacesDocument) {
            this.senderDocument += 100;
        }
        this.handles.clear();
        this.holds.clear();
        this.writes.sender = 1;
        this.sender = this.createRuntime('sender');
    }

    private createRuntime(role: 'sender' | 'receiver'): RallarBlackBoxTestRuntime {
        return createRallarBlackBoxTestRuntime({
            now: () => this.now,
            sleep: async (duration) => {
                if (!this.holdNextSleep) {
                    this.now += duration;
                    return;
                }
                this.holdNextSleep = false;
                const pending = Promise.withResolvers<void>();
                this.absence = { duration, release: pending.resolve };
                this.entered.resolve();
                await pending.promise;
            },
            commandExecutor: (command) => this.executePort(role, command)
        });
    }

    private executePort(role: 'sender' | 'receiver', command: RallarBlackBoxTestCommand): RallarBlackBoxTestCommandOutcome | undefined {
        const document = { origin: 'https://fixture.test', timeOrigin: role === 'sender' ? this.senderDocument : 50 };
        const session = { clientId: role, sessionId: `${role}-stored-session` };
        switch (command.kind) {
            case 'http.request':
                return { status: 'ok', value: { status: 200 } };
            case 'rtc.connect':
                this.reportStoreRecoveries(role, session.sessionId);
                this.deliverRecoveredOriginals(role);
                return { status: 'ok', value: { document, ...session } };
            case 'health':
                return { status: 'ok', value: { rallar: { document, session } } };
            case 'storage.counters':
                return this.readStorageCounters(role, command.reset === true);
            case 'fault.inject':
                return this.injectFault(command);
            case 'messages.send':
            case 'messages.observe':
            case 'messages.cancel':
            case 'messages.receipts':
            case 'messages.received':
                return this.executeMessagesPort(command);
            case 'close':
                return { status: 'ok', value: { status: 'closed' } };
            case 'barrier':
                // The replay dispatches paired segments one at a time, so the barrier is a controlled fact here;
                // control-recipe-barrier.test.ts proves its control path.
                return { status: 'ok', value: { barrierId: command.barrierId, outcome: 'released', arrivedAgentIds: [role] } };
            case 'assert':
            case 'wait':
                return undefined; // These acceptance commands execute in the real runtime.
            default:
                throw new Error(`Unexpected external fixture port: ${command.kind}`);
        }
    }

    private executeMessagesPort(command: PortCommand<MessagesPortKind>): RallarBlackBoxTestCommandOutcome {
        switch (command.kind) {
            case 'messages.send':
                return 'replayOnCarrier' in command ? this.replay(command) : this.send(command);
            case 'messages.observe':
                return this.observe(command);
            case 'messages.cancel':
                return this.cancel(command);
            case 'messages.receipts':
                return this.readReceipts(command);
            case 'messages.received':
                return this.readReceived(command);
        }
    }

    private observe(command: PortCommand<'messages.observe'>): RallarBlackBoxTestCommandOutcome {
        const message = this.handles.get(command.handleId);
        if (message && command.state.length === 1 && command.state[0] === 'expired') {
            message.state = 'expired';
        }
        // Only a send that opted into a durability and committed it is enqueued; the default is volatile.
        const enqueued = (message?.command.durability ?? 'volatile') !== 'volatile' &&
            message?.durabilityDowngrade === undefined && message?.state !== 'failed';
        return {
            status: 'ok',
            value: {
                handleId: command.handleId,
                state: message?.state ?? 'unobservable',
                enqueued,
                submitted: message?.submitted ?? false,
                attempts: message?.attemptCarriers.length ?? 0,
                attemptCarriers: message?.attemptCarriers ?? [],
                attemptOutcomes: message?.attemptOutcomes ?? [],
                failure: message?.failure,
                carrierFallback: message?.carrierFallback,
                durabilityDowngrade: message?.durabilityDowngrade,
                ...(message?.command.toPeer !== undefined && message.state === 'acknowledged'
                    ? toAddresseeReceipt(message.command.toPeer)
                    : {})
            }
        };
    }

    private cancel(command: PortCommand<'messages.cancel'>): RallarBlackBoxTestCommandOutcome {
        const message = this.handles.get(command.handleId);
        assert(message);
        if (!message.submitted && message.state !== 'rejected') {
            message.state = 'cancelled';
        }
        return { status: 'ok', value: { handleId: command.handleId, state: message.state, submitted: message.submitted } };
    }

    private readReceipts(command: PortCommand<'messages.receipts'>): RallarBlackBoxTestCommandOutcome {
        const message = this.handles.get(command.handleId);
        assert(message);
        if (message.command.toPeer !== undefined) {
            return { status: 'ok', value: toAddresseeReceipt(message.command.toPeer) };
        }
        // A ws receipt names no hop, so its logical recipient is read from the recipient lists.
        const isWs = message.command.carrier === 'ws';
        const confirmed = isWs ? 'receiver-stored-session' : 'receiver';
        return {
            status: 'ok',
            value: {
                confirmedHopPeerIds: isWs ? [] : [confirmed],
                unconfirmedHopPeerIds: [],
                confirmedRecipientPeerIds: [confirmed],
                unconfirmedRecipientPeerIds: []
            }
        };
    }

    private readReceived(command: PortCommand<'messages.received'>): RallarBlackBoxTestCommandOutcome {
        // A command addressed to the server reaches no member of the room.
        const arrived = this.messages.filter((message) =>
            message.command.typeId === command.typeId && message.submitted &&
            message.command.toPeer !== 'server'
        );
        this.admitReceiverInbox(arrived);
        const count = arrived.length;
        const passed = command.absent ? count < command.count : count >= command.count;
        return { status: passed ? 'ok' : 'failed', value: { count } };
    }

    /** The receiver admits a local-inbox arrival to IndexedDB on its own timeline: when its page reads the arrival. */
    private admitReceiverInbox(arrived: readonly PortMessage[]): void {
        for (const message of arrived) {
            if (message.command.durability === 'local-inbox' && !this.inboxAdmitted.has(message.msgId)) {
                this.inboxAdmitted.add(message.msgId);
                this.writes.receiver += 1;
            }
        }
    }

    private readStorageCounters(role: 'sender' | 'receiver', reset: boolean): RallarBlackBoxTestCommandOutcome {
        const writes = this.writes[role];
        if (reset) {
            this.writes[role] = 0;
        }
        return {
            status: 'ok',
            value: {
                total: writes * 2,
                byOwner: { 'al-admission': writes, 'al-work': writes },
                byKind: writes === 0 ? {} : { write: writes, 'work-read': writes },
                workProbeCount: 0,
                workNonProbeCount: writes,
                reset
            }
        };
    }

    private deliverRecoveredOriginals(role: 'sender' | 'receiver'): void {
        if (role !== 'sender') {
            return;
        }
        for (const message of this.messages) {
            if (isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'delivery-reload' && !message.submitted) {
                this.deliver(message);
            }
        }
    }

    /** Every durable store of the page reports what it restored once its first batch ran; the fixture runs it at connect. */
    private reportStoreRecoveries(role: 'sender' | 'receiver', sessionId: string): void {
        if (role !== 'sender') {
            return;
        }
        for (const prefix of ['browser-session-inbound', 'browser-ws-client', 'browser-rtc-overlay']) {
            this.sender.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.storage',
                payload: {
                    data: {
                        kind: 'recovery',
                        storeId: `${prefix}:${sessionId}`,
                        outcome: { kind: 'restored', claimed: 0, expired: 0 }
                    }
                }
            });
        }
    }

    /** A store's health, stated on its transitions only. */
    private reportStoreHealth(status: 'failing' | 'healthy'): void {
        this.storageFailing = status === 'failing';
        this.sender.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.storage',
            payload: {
                data: {
                    kind: 'health',
                    storeId: 'browser-ws-client:sender-stored-session',
                    status,
                    lastFailure: { cause: 'quota', detail: 'The fixture storage is full.' },
                    lastRecoveryPointAtMs: undefined
                }
            }
        });
    }

    private injectFault(command: RallarBlackBoxTestFaultInjectCommand): RallarBlackBoxTestCommandOutcome {
        if (command.carrier === 'storage') {
            this.storageQuota = command.remaining !== 0;
            return { status: 'ok', value: { faultId: command.faultId } };
        }
        if (command.remaining === 0) {
            this.holds.delete(command.faultId);
        }
        else {
            this.holds.set(command.faultId, String(command.match?.typeId));
        }
        for (const message of this.messages) {
            if (message.state === 'accepted' && !this.isHeld(message.command.typeId)) {
                this.deliver(message);
            }
        }
        return { status: 'ok', value: { faultId: command.faultId } };
    }

    private send(command: RallarBlackBoxTestMessagesSendCommand): RallarBlackBoxTestCommandOutcome {
        assert(isJsonRecordValue(command.payload));
        // The lowered volatile bound refuses the third capacity send at admission (D78): no attempt, nothing delivered.
        const capacityRefused = command.payload.marker === 'capacity' && command.payload.index === 3;
        const durable = (command.durability ?? 'volatile') !== 'volatile';
        const storageRefused = durable && this.storageQuota && command.onStorageUnavailable !== 'volatile';
        const downgraded = durable && this.storageQuota && command.onStorageUnavailable === 'volatile';
        const rejected = command.payload.marker === 'bounded-rejection' || capacityRefused || storageRefused;
        const message: PortMessage = {
            command,
            msgId: `port-message-${this.messages.length + 1}`,
            state: storageRefused ? 'failed' : rejected ? 'rejected' : command.payload.seq === 300 ? 'queued' : 'accepted',
            submitted: false,
            attemptCarriers: [],
            attemptOutcomes: [],
            failure: capacityRefused
                ? { kind: 'refused', reason: 'capacity' }
                : storageRefused
                ? { kind: 'storage-unavailable', cause: 'quota' }
                : undefined,
            carrierFallback: undefined,
            durabilityDowngrade: downgraded ? { requested: String(command.durability), cause: 'quota' } : undefined
        };
        if (storageRefused && !this.storageFailing) {
            this.reportStoreHealth('failing');
        }
        if (durable && !this.storageQuota && this.storageFailing) {
            this.reportStoreHealth('healthy');
        }
        this.messages.push(message);
        assert(command.handleId);
        this.handles.set(command.handleId, message);
        if (durable && !this.storageQuota) {
            this.writes.sender += 1;
        }
        if (command.payload.revision === 'replacement') {
            for (const prior of this.messages) {
                if (prior.command.typeId === command.typeId && isJsonRecordValue(prior.command.payload) && prior.command.payload.revision === 'old') {
                    prior.state = 'superseded';
                }
            }
        }
        this.route(message, rejected);
        return {
            status: 'ok',
            value: {
                msgId: message.msgId,
                handleId: command.handleId,
                carrier: command.carrier,
                status: storageRefused ? 'failed' : rejected ? 'rejected' : 'accepted',
                reason: capacityRefused
                    ? 'The volatile session bound refused the admission.'
                    : rejected
                    ? 'Payload exceeds fixture carrier limit'
                    : undefined
            }
        };
    }

    private route(message: PortMessage, rejected: boolean): void {
        const { command } = message;
        const handedOver = isJsonRecordValue(command.payload)
            ? HANDED_OVER_WS_OUTCOMES[String(command.payload.marker)]
            : undefined;
        if (command.minSnapshotVersion !== undefined) {
            this.refuseNotYetInSync(message);
        }
        else if (isJsonRecordValue(command.payload) && command.payload.seq === 300) {
            this.refuseGappedSend(message);
        }
        else if (handedOver !== undefined) {
            this.handOver(message, handedOver);
        }
        else if (command.toPeer === 'server') {
            this.acknowledgeByServer(message);
        }
        else if (!rejected && !this.isHeld(command.typeId)) {
            this.deliver(message);
        }
    }

    /** Delivered with an attempt on each carrier; the receiver states its verdict on the WS copy. */
    private handOver(message: PortMessage, handedOver: HandedOverOutcome): void {
        this.deliver(message);
        message.attemptCarriers = ['rtc', 'ws'];
        message.attemptOutcomes = handedOver.attemptOutcomes;
        message.carrierFallback = {
            from: 'rtc',
            to: 'ws',
            reason: handedOver.fallbackReason,
            atMs: Date.now(),
            detail: 'The RTC leg handed the send over to WS.'
        };
        this.receiver.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: {
                    kind: 'admission-outcome',
                    workerId: 'receiver-inbound',
                    msgId: message.msgId,
                    typeId: message.command.typeId,
                    carrier: 'ws',
                    outcome: handedOver.outcome,
                    reason: handedOver.reason
                }
            }
        });
    }

    /** The server keeps a command addressed to itself and answers it with its own ACK; no member receives it. */
    private acknowledgeByServer(message: PortMessage): void {
        message.submitted = true;
        message.state = 'acknowledged';
    }

    /** The receiver's snapshot is below the send's floor: it refuses the copy over RTC and writes nothing. */
    private refuseNotYetInSync(message: PortMessage): void {
        this.receiver.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: {
                    kind: 'admission-outcome',
                    workerId: 'receiver-inbound',
                    msgId: message.msgId,
                    typeId: message.command.typeId,
                    carrier: 'rtc',
                    outcome: 'rejected',
                    reason: 'not-yet-in-sync: Awaiting the required room snapshot version'
                }
            }
        });
    }

    /**
     * The first hop refuses a send past the repair window: over WS the relay NACKs the sender, which commits it as the
     * word of its trusted server (R-S2c-ii-5); over RTC the receiver refuses it.
     */
    private refuseGappedSend(message: PortMessage): void {
        if (message.command.carrier === 'ws') {
            this.sender.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                payload: {
                    data: {
                        kind: 'control-admission',
                        msgId: `${message.msgId}-nack`,
                        typeId: 'al.control.nack.v1',
                        targetMsgId: message.msgId,
                        outcome: 'committed',
                        reason: 'none'
                    }
                }
            });
            return;
        }
        this.receiver.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: {
                    kind: 'admission-outcome',
                    workerId: 'receiver-inbound',
                    msgId: message.msgId,
                    typeId: message.command.typeId,
                    carrier: 'rtc',
                    outcome: 'not-handled',
                    reason: 'resync-required'
                }
            }
        });
    }

    /** The receiver's one inbound identity refuses the replayed copy as a duplicate, so nothing more is delivered. */
    private replay({ replayOnCarrier: replay }: RallarBlackBoxTestMessagesReplayCommand): RallarBlackBoxTestCommandOutcome {
        const original = this.handles.get(replay.handleId);
        assert(original);
        this.receiver.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: {
                    kind: 'admission-outcome',
                    workerId: 'receiver-inbound',
                    msgId: original.msgId,
                    typeId: original.command.typeId,
                    carrier: replay.carrier,
                    outcome: 'not-handled',
                    reason: 'duplicate'
                }
            }
        });
        return {
            status: 'ok',
            value: { handleId: replay.handleId, msgId: original.msgId, carrier: replay.carrier, verdict: 'admitted' }
        };
    }

    /** Over RTC the receiver's hop ACK reaches the sender, whose outbound owner commits it as the product does. */
    private admitReceiverAck(message: PortMessage): void {
        this.sender.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.outbound_diagnostics',
            payload: {
                data: {
                    kind: 'control-admission',
                    msgId: `${message.msgId}-ack`,
                    typeId: 'al.control.ack.v2',
                    targetMsgId: message.msgId,
                    outcome: 'committed',
                    reason: 'none'
                }
            }
        });
    }

    /** Over WS the server answers a receipted send with its admitted receipt, then the complete one (R-S3a-9). */
    private admitServerReceipts(message: PortMessage): void {
        for (const phase of ['admitted', 'complete'] as const) {
            this.sender.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                payload: {
                    data: {
                        kind: 'control-admission',
                        msgId: `${message.msgId}-receipt-${phase}`,
                        typeId: 'al.control.receipt.v1',
                        targetMsgId: message.msgId,
                        outcome: 'committed',
                        reason: 'none',
                        phase
                    }
                }
            });
        }
    }

    private isHeld(typeId: string): boolean {
        return [...this.holds.values()].includes(typeId);
    }

    private deliver(message: PortMessage): void {
        // S3a: a send that names no ack is receipted by default; only an explicit `none` ends at transport acceptance.
        const receipted = message.command.ack !== 'none';
        message.submitted = true;
        message.state = message.command.carrier === 'ws' && !receipted ? 'transport-accepted' : 'acknowledged';
        if (message.command.carrier !== 'ws') {
            this.admitReceiverAck(message);
        }
        else if (receipted) {
            this.admitServerReceipts(message);
        }
        this.receiver.recordEvent({
            kind: 'message',
            connection: 'almConformanceReceiver',
            topic: 'typed',
            payload: {
                data: {
                    msgId: message.msgId,
                    typeId: message.command.typeId,
                    transport: message.command.carrier === 'ws' ? 'ws' : 'rtc',
                    payload: message.command.payload
                }
            }
        });
    }
}

/** An addressed send's receipt names its one addressee: the server itself, or the receiver's stored session. */
function toAddresseeReceipt(toPeer: 'server' | 'receiver') {
    const addressee = toPeer === 'server' ? 'server-peer' : 'receiver-stored-session';
    return {
        receiptMode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: [addressee],
        confirmedRecipientPeerIds: [addressee],
        unconfirmedRecipientPeerIds: []
    };
}

for (const replacesDocument of [true, false]) {
    Deno.test(`unmodified combined ALM runs every checkpoint and trailing scenario through restored runtime evidence (fresh document=${replacesDocument})`, async () => {
        const manifest = createAlmConformance2AgentEntry().manifest;
        const ports = new GeneratedAlmPorts(replacesDocument);
        const input = toControlServiceInput({ now: () => ports.now, runtimeRetentionBounds: { commands: 1, results: 1 } });
        let service = createRallarBlackBoxControlService(input);
        const runId = manifest.controlRunId;
        const agents = ['controller-01', 'controller-02'];
        const register = (): void => {
            for (const agentId of agents) {
                service.receiveClientEnvelope(toRegisterEnvelope({ runId, agentId, identity: toFleetIdentity(agentId, manifest.group) }));
            }
        };
        register();
        assertRight(service.createDistributedRun(manifest));
        assertRight(service.stageDistributedRun(manifest.distributedRunId));
        for (const _phase of ['stage', 'barrier']) {
            for (const [index, agentId] of agents.entries()) {
                for (const command of service.takeDispatchableCommands(runId, agentId)) {
                    await executeSegment(service, index === 0 ? ports.sender : ports.receiver, command);
                }
            }
        }
        const started = assertRight(service.startDistributedRun(manifest.distributedRunId));
        const senderRoot = started.commandLinks.find((link) => link.phase === 'start' && link.role === 'sender')!.commandId;
        const root = service.snapshotRun(runId)!.commands.find((command) => command.envelope.commandId === senderRoot)!.envelope;
        const pair = toAlmReloadPair(root.command)!;
        assertEquals(pair.checkpoints.length, 3);
        for (const checkpoint of pair.checkpoints) {
            const [prefix] = service.takeDispatchableCommands(runId, agents[0]);
            const [ready] = service.takeDispatchableCommands(runId, agents[1]);
            await executeSegment(service, ports.receiver, ready);
            await executeSegment(service, ports.sender, prefix);
            const entered = ports.beginAbsence();
            const [absence] = service.takeDispatchableCommands(runId, agents[1]);
            const pending = executeSegment(service, ports.receiver, absence);
            await entered;
            try {
                assertEquals(service.takeDispatchableCommands(runId, agents[0]), [], 'an unfinished real absence wait cannot authorize page replacement');
            }
            finally {
                ports.finishAbsence();
                await pending;
            }
            const snapshot = service.snapshotForPersistence({ commands: 1, results: 1 });
            assert(snapshot.runs[0].results.some((result) => result.commandId === prefix.commandId), 'pending actual prefix evidence survives low bounds');
            const [reload] = service.takeDispatchableCommands(runId, agents[0]);
            assertEquals(reload.command.kind, 'agent.reload');
            assert(reload.command.kind === 'agent.reload');
            const result = toAgentReloadResult({
                commandId: reload.commandId,
                readyTimeoutMs: reload.command.readyTimeoutMs!,
                written: 'written',
                atEpochMs: ports.now
            });
            recordResult(service, reload, result);
            service.markAgentDisconnected(runId, agents[0]);
            ports.replaceSenderDocument();
            service.receiveClientEnvelope(
                toRegisterEnvelope({ runId, agentId: agents[0], completedCommandIds: [reload.commandId], identity: toFleetIdentity(agents[0], manifest.group) })
            );
            const [suffix] = service.takeDispatchableCommands(runId, agents[0]);
            assert(suffix.command.kind === 'recipe.run');
            assertEquals(suffix.command.recipe?.commands.at(-1)?.commandId, checkpoint.senderSuffixEnd);
            await executeSegment(service, ports.sender, suffix);
            const [recovery] = service.takeDispatchableCommands(runId, agents[1]);
            await executeSegment(service, ports.receiver, recovery);
        }
        // The receiver's original generation is fenced until all recovery checkpoints have completed.
        const pending = service.snapshotForPersistence({ commands: 1, results: 1 });
        service = createRallarBlackBoxControlService(input);
        service.restoreSnapshot(pending);
        register();
        const [senderTrailing] = service.takeDispatchableCommands(runId, agents[0]);
        await executeSegment(service, ports.sender, senderTrailing);
        const senderCompleted = service.snapshotForPersistence({ commands: 1, results: 1 });
        assert(senderCompleted.runs[0].results.some((result) => result.commandId === senderRoot), 'real sender root survives until receiver assessment');
        const senderValue = senderCompleted.runs[0].results.find((entry) => entry.commandId === senderRoot)?.result?.value;
        assert(isJsonRecordValue(senderValue) && Array.isArray(senderValue.results));
        assertEquals(
            senderValue.results.map((entry) => isJsonRecordValue(entry) ? entry.commandId : undefined),
            manifest.recipes.find((entry) => entry.role === 'sender')!.recipe!.commands.map((command) => command.commandId),
            'logical aggregation preserves every actual authored child identity'
        );
        service = createRallarBlackBoxControlService(input);
        service.restoreSnapshot(senderCompleted);
        register();
        const [receiverTrailing] = service.takeDispatchableCommands(runId, agents[1]);
        await executeSegment(service, ports.receiver, receiverTrailing);
        const completed = service.snapshotDistributedRun(manifest.distributedRunId);
        assertEquals(completed?.state, replacesDocument ? 'passed' : 'failed', JSON.stringify(completed?.rollup));
        if (!replacesDocument) {
            assert(
                completed?.rollup.failures.some((failure) => failure.error?.code === 'RALLAR_BB_ALM_IDENTITY_FAILED'),
                'the actual hosted rollup must reject unchanged document facts despite successful command results'
            );
        }
        assertEquals(
            ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'delivery-reload').length,
            3,
            'restored suffixes and roots never resend an original'
        );
        assertEquals(
            service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.length,
            1,
            'terminal evidence returns to the configured finite bounds'
        );
    });
}

async function executeSegment(service: RallarBlackBoxControlService, runtime: RallarBlackBoxTestRuntime, envelope: ControlCommandEnvelope): Promise<void> {
    assert(envelope, 'expected an actual control dispatch');
    const result = await runtime.execute({ ...envelope.command, deadlineEpochMs: envelope.deadlineEpochMs });
    assertEquals(result.ok, true, JSON.stringify(result));
    recordResult(service, envelope, result);
}

function recordResult(service: RallarBlackBoxControlService, envelope: ControlCommandEnvelope, result: RallarBlackBoxTestResult): void {
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: envelope.runId,
            agentId: envelope.agentId!,
            commandId: envelope.commandId,
            ok: result.ok,
            result
        }).accepted,
        true
    );
}
