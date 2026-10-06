import { assert, assertEquals } from '@std/assert';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import {
    ALM_CONFORMANCE_CARRIERS,
    ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toAlmReloadCheckpoints, toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestFaultInjectCommand,
    RallarBlackBoxTestMessagesReplayCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { AL_CHECKPOINT_DEFAULT_SETTINGS } from '@shared/alm/checkpoint/al-checkpoint-default-settings.ts';
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

/** A `local-checkpoint` row: in memory until a checkpoint saves it, lost if its page ends first. */
type PortCheckpoint = 'unsaved' | 'saved' | 'lost';

type PortCheckpointHealth = 'healthy' | 'delayed' | 'failing';

interface PortMessage {
    readonly command: RallarBlackBoxTestMessagesSendCommand;
    readonly msgId: string;
    readonly admittedAtMs: number;
    /** Undefined for every send that is not an admitted `local-checkpoint` one. */
    checkpoint: PortCheckpoint | undefined;
    state: string;
    submitted: boolean;
    /** An ordered send the receiver holds back behind a gap: submitted, but handed to no channel yet. */
    buffered: boolean;
    /** The order the receiver's channel saw it in; undefined until it did. */
    deliveredIndex: number | undefined;
    /** The retransmits a gap report has charged to this message; the budget is one. */
    repairAttempts: number;
    attemptCarriers: readonly ('rtc' | 'ws')[];
    attemptOutcomes: readonly ('not-ready' | 'sent')[];
    /**
     * The volatile bound's refusal, a refused durable send under a storage quota, or a repair budget spent while the
     * message stayed held; undefined for every send admitted and delivered.
     */
    failure:
        | Readonly<{ kind: 'refused'; reason: 'capacity'; }>
        | Readonly<{ kind: 'storage-unavailable'; cause: 'quota' | 'checkpoint-lag'; }>
        | Readonly<{ kind: 'skipped'; reason: 'repair-exhausted'; }>
        | undefined;
    carrierFallback: ALDeliveryCarrierFallback | undefined;
    /** A durable send a volatile channel admitted volatile while its storage was full. */
    readonly durabilityDowngrade: Readonly<{ requested: string; cause: 'quota' | 'checkpoint-lag'; }> | undefined;
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

/**
 * A transport hold the sender's page keeps: every frame of a type, the one message a send returned, or a control
 * type, which holds no data frame of the fixture's.
 */
type PortHold =
    | Readonly<{ kind: 'type'; typeId: string; }>
    | Readonly<{ kind: 'message'; msgId: string; }>
    | Readonly<{ kind: 'control'; }>;

const HOLD_MSG_ID_REFERENCE = /^\{resultCache\.(.+)\.value\.msgId\}$/u;

/** Controlled external facts prove recipe/control composition, never native storage or transport behavior. */
class GeneratedAlmPorts {
    now = 1_000;
    senderDocument = 100;
    /** IndexedDB admission writes per page since its last reset: only a send that opts into a durability writes. */
    readonly writes = { sender: 1, receiver: 1 };
    readonly inboxAdmitted = new Set<string>();
    readonly messages: PortMessage[] = [];
    readonly handles = new Map<string, PortMessage>();
    readonly holds = new Map<string, PortHold>();
    /** Whether the receiver's connect installed the recording recovery owner on its channel. */
    recoveryOwnerInstalled = false;
    private deliveries = 0;
    /** A held admission quota fault fails every durable admission of the sender's page; its id names the failure. */
    storageQuotaFaultId: string | undefined = undefined;
    storageFailing = false;
    /** The page's checkpoint store health, stated on its transitions only. */
    checkpointHealth: PortCheckpointHealth = 'healthy';
    /** Whether a held fallback send's RTC leg hands it to WS at all. */
    handsOverHeldFallback = true;
    lastQuotaFaultId = '';
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

    /** The page's lifecycle flush: every unsaved checkpoint row is written at once, unless the quota fault fails it. */
    flushCheckpoints(): void {
        this.writeCheckpoints(this.messages.filter(isUnsavedCheckpoint));
    }

    replaceSenderDocument(): void {
        if (this.replacesDocument) {
            this.senderDocument += 100;
        }
        this.handles.clear();
        this.holds.clear();
        this.writes.sender = 1;
        for (const message of this.messages.filter(isUnsavedCheckpoint)) {
            message.checkpoint = 'lost';
        }
        this.checkpointHealth = 'healthy';
        this.sender = this.createRuntime('sender');
    }

    private createRuntime(role: 'sender' | 'receiver'): RallarBlackBoxTestRuntime {
        return createRallarBlackBoxTestRuntime({
            now: () => this.now,
            sleep: async (duration) => {
                if (!this.holdNextSleep) {
                    this.now += duration;
                    this.settleCheckpoints();
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
        this.settleCheckpoints();
        const document = { origin: 'https://fixture.test', timeOrigin: role === 'sender' ? this.senderDocument : 50 };
        const session = { clientId: role, sessionId: `${role}-stored-session` };
        switch (command.kind) {
            case 'http.request':
                return { status: 'ok', value: { status: 200 } };
            case 'rtc.connect':
                if (role === 'receiver') {
                    this.recoveryOwnerInstalled = command.rallar?.recoveryOwner === 'record';
                }
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
            case 'loop':
                return undefined; // These acceptance and composite commands execute in the real runtime.
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
        const value = {
            confirmedHopPeerIds: isWs ? [] : [confirmed],
            unconfirmedHopPeerIds: [],
            confirmedRecipientPeerIds: [confirmed],
            unconfirmedRecipientPeerIds: [],
            carrierFallback: message.carrierFallback,
            attemptCarriers: message.attemptCarriers
        };
        this.advanceHeldFallback(message);
        return { status: 'ok', value };
    }

    /**
     * A held fallback send's RTC attempts hand it to WS a moment after admission, and its held WS attempt follows once
     * the WS row commits, a moment later again: each read precedes the next step.
     */
    private advanceHeldFallback(message: PortMessage): void {
        if (
            !this.handsOverHeldFallback || message.command.carrier !== 'rtc-with-ws-fallback' || message.submitted ||
            !this.isHeld(message)
        ) {
            return;
        }
        if (message.carrierFallback === undefined) {
            message.carrierFallback = {
                from: 'rtc',
                to: 'ws',
                reason: 'not-ready',
                atMs: this.now,
                detail: 'The held RTC leg handed the send over to WS.'
            };
            return;
        }
        message.attemptCarriers = ['rtc', 'ws'];
        message.attemptOutcomes = ['not-ready', 'not-ready'];
    }

    private readReceived(command: PortCommand<'messages.received'>): RallarBlackBoxTestCommandOutcome {
        // A command addressed to the server reaches no member of the room; a buffered one has not reached its channel.
        const arrived = this.messages.filter((message) =>
            message.command.typeId === command.typeId && message.submitted && !message.buffered &&
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

    /** The next page of the sender's session, a reloaded document or a successor page, sends what the last one held. */
    private deliverRecoveredOriginals(role: 'sender' | 'receiver'): void {
        if (role !== 'sender') {
            return;
        }
        for (const message of this.messages.filter(isHeldOriginal)) {
            this.deliver(message);
        }
    }

    /**
     * Every durable store of the page reports what it restored once its first batch ran, the session inbound store once
     * per carrier lane; the fixture runs it at connect. An outbound store claims the originals the last page held in it.
     */
    private reportStoreRecoveries(role: 'sender' | 'receiver', sessionId: string): void {
        if (role !== 'sender') {
            return;
        }
        const held = this.messages.filter(isHeldOriginal);
        const durable = held.filter((message) => message.checkpoint === undefined);
        const checkpointed = held.filter((message) => message.checkpoint === 'saved');
        const overRtc = (message: PortMessage) => message.command.carrier === 'rtc';
        const stores = [
            { storeId: `browser-session-inbound:${sessionId}/ws`, claimed: 0 },
            { storeId: `browser-session-inbound:${sessionId}/rtc`, claimed: 0 },
            { storeId: `browser-ws-client:${sessionId}`, claimed: durable.filter((message) => !overRtc(message)).length },
            { storeId: `browser-rtc-overlay:${sessionId}`, claimed: durable.filter(overRtc).length },
            { storeId: `browser-ws-client-checkpoint:${sessionId}`, claimed: checkpointed.filter((message) => !overRtc(message)).length },
            { storeId: `browser-rtc-overlay-checkpoint:${sessionId}`, claimed: checkpointed.filter(overRtc).length }
        ];
        for (const { storeId, claimed } of stores) {
            this.sender.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.storage',
                payload: {
                    data: {
                        kind: 'recovery',
                        storeId,
                        outcome: { kind: 'restored', claimed, expired: 0 }
                    }
                }
            });
        }
    }

    /** The checkpoint timer, run on every fixture step and sleep: a row unsaved for one interval is written. */
    private settleCheckpoints(): void {
        this.writeCheckpoints(
            this.messages.filter((message) => isUnsavedCheckpoint(message) && this.now - message.admittedAtMs >= AL_CHECKPOINT_DEFAULT_SETTINGS.intervalMs)
        );
    }

    /**
     * A positive wait runs on the real clock, so the fixture states the lag at once: a row admitted while the quota
     * fault fails every write reads its store `delayed`, then `failing` past the bound.
     */
    private reportCheckpointLag(row: PortMessage): void {
        this.reportCheckpointHealth(row, 'delayed');
        this.reportCheckpointHealth(row, 'failing');
    }

    /** One readwrite saves every row it captured, counted as one admission write of the page. */
    private writeCheckpoints(rows: readonly PortMessage[]): void {
        if (rows.length === 0 || this.storageQuotaFaultId !== undefined) {
            return;
        }
        for (const message of rows) {
            message.checkpoint = 'saved';
        }
        this.writes.sender += 1;
        this.reportCheckpointHealth(rows[0], 'healthy');
    }

    /** The checkpoint store of the lane holding the row: a held fallback send has moved to WS, an unheld one has not. */
    private reportCheckpointHealth(row: PortMessage, status: PortCheckpointHealth): void {
        if (status === this.checkpointHealth) {
            return;
        }
        this.checkpointHealth = status;
        const overRtc = row.command.carrier === 'rtc' ||
            (row.command.carrier === 'rtc-with-ws-fallback' && !this.isHeld(row));
        this.sender.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.storage',
            payload: {
                data: {
                    kind: 'health',
                    storeId: `${overRtc ? 'browser-rtc-overlay-checkpoint' : 'browser-ws-client-checkpoint'}:sender-stored-session`,
                    status,
                    lastFailure: status === 'delayed'
                        ? undefined
                        : { cause: 'checkpoint-lag', detail: `The oldest unsaved change passed ${AL_CHECKPOINT_DEFAULT_SETTINGS.lagBoundMs} ms.` },
                    lastRecoveryPointAtMs: undefined
                }
            }
        });
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
                    lastFailure: {
                        cause: 'quota',
                        detail: `QuotaExceededError: Scripted storage quota fault ${this.lastQuotaFaultId}`
                    },
                    lastRecoveryPointAtMs: undefined
                }
            }
        });
    }

    private injectFault(command: RallarBlackBoxTestFaultInjectCommand): RallarBlackBoxTestCommandOutcome {
        if (command.carrier === 'storage') {
            if (command.match.owner === 'al-admission') {
                this.storageQuotaFaultId = command.remaining === 0 ? undefined : command.faultId;
                this.lastQuotaFaultId = command.faultId;
                this.writeCheckpoints(this.messages.filter(isUnsavedCheckpoint));
            }
            return { status: 'ok', value: { faultId: command.faultId } };
        }
        if (command.remaining === 0) {
            this.holds.delete(command.faultId);
        }
        else {
            this.holds.set(command.faultId, this.toPortHold(command.match));
        }
        for (const message of this.messages) {
            if (message.state === 'accepted') {
                this.routeAdmitted(message);
            }
        }
        return { status: 'ok', value: { faultId: command.faultId } };
    }

    private send(command: RallarBlackBoxTestMessagesSendCommand): RallarBlackBoxTestCommandOutcome {
        assert(isJsonRecordValue(command.payload));
        // The lowered volatile bound refuses the third capacity send at admission (D78): no attempt, nothing delivered.
        const capacityRefused = command.payload.marker === 'capacity' && command.payload.index === 3;
        const durable = (command.durability ?? 'volatile') !== 'volatile';
        const checkpointed = command.durability === 'local-checkpoint';
        const quotaHeld = this.storageQuotaFaultId !== undefined;
        // The checkpoint tier's send path stores nothing: only a checkpoint lag past its bound makes it unavailable.
        const unavailable = checkpointed ? this.checkpointHealth === 'failing' : quotaHeld;
        const storageRefused = durable && unavailable && command.onStorageUnavailable !== 'volatile';
        const downgraded = durable && unavailable && command.onStorageUnavailable === 'volatile';
        const cause = checkpointed ? 'checkpoint-lag' : 'quota';
        const rejected = command.payload.marker === 'bounded-rejection' || capacityRefused || storageRefused;
        const message: PortMessage = {
            command,
            msgId: `port-message-${this.messages.length + 1}`,
            admittedAtMs: this.now,
            checkpoint: checkpointed && !storageRefused && !downgraded ? 'unsaved' : undefined,
            state: storageRefused ? 'failed' : rejected ? 'rejected' : command.payload.seq === 300 ? 'queued' : 'accepted',
            submitted: false,
            buffered: false,
            deliveredIndex: undefined,
            repairAttempts: 0,
            attemptCarriers: [],
            attemptOutcomes: [],
            failure: capacityRefused
                ? { kind: 'refused', reason: 'capacity' }
                : storageRefused
                ? { kind: 'storage-unavailable', cause }
                : undefined,
            carrierFallback: undefined,
            durabilityDowngrade: downgraded ? { requested: String(command.durability), cause } : undefined
        };
        if (!checkpointed && storageRefused && !this.storageFailing) {
            this.reportStoreHealth('failing');
        }
        if (durable && !checkpointed && !quotaHeld && this.storageFailing) {
            this.reportStoreHealth('healthy');
        }
        this.messages.push(message);
        assert(command.handleId);
        this.handles.set(command.handleId, message);
        if (durable && !checkpointed && !quotaHeld) {
            this.writes.sender += 1;
        }
        if (message.checkpoint === 'unsaved' && quotaHeld) {
            this.reportCheckpointLag(message);
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
        else if (!rejected) {
            this.routeAdmitted(message);
        }
    }

    /** A held frame stays with its page; an ordered frame behind a held one is buffered at the receiver; the rest deliver. */
    private routeAdmitted(message: PortMessage): void {
        if (this.isHeld(message)) {
            return;
        }
        const held = this.findHeldPredecessor(message);
        if (held !== undefined) {
            this.bufferBehindGap(message, held);
            return;
        }
        this.deliver(message);
    }

    /** The earlier sequence of the message's ordering track that its sender still holds, if any. */
    private findHeldPredecessor(message: PortMessage): PortMessage | undefined {
        const { orderingKey, seq } = message.command;
        if (orderingKey === undefined || seq === undefined) {
            return undefined;
        }
        return this.messages.find((candidate) =>
            candidate.command.orderingKey === orderingKey && candidate.command.seq !== undefined &&
            candidate.command.seq < seq && !candidate.submitted && this.isHeld(candidate)
        );
    }

    /**
     * The hop reads the gap and NACKs the range of the held sequence, which the sender admits as `committed` and answers
     * with one retransmission; a second report of the same gap finds that budget of one spent and settles the held
     * message `skipped` as `repair-exhausted`. The revealing frame waits at the receiver for the gap to close.
     */
    private bufferBehindGap(message: PortMessage, held: PortMessage): void {
        message.submitted = true;
        message.buffered = true;
        message.state = 'transport-accepted';
        this.sender.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.outbound_diagnostics',
            payload: {
                data: {
                    kind: 'control-admission',
                    msgId: `${message.msgId}-nack`,
                    typeId: 'al.control.nack.v2',
                    targetMsgId: message.msgId,
                    outcome: 'committed',
                    reason: 'none',
                    missingRanges: [{ from: held.command.seq, to: held.command.seq }]
                }
            }
        });
        if (held.repairAttempts >= 1) {
            held.state = 'failed';
            held.failure = { kind: 'skipped', reason: 'repair-exhausted' };
            return;
        }
        held.repairAttempts += 1;
    }

    /** The receiver's channel reads the released sequence, then every buffered successor the gap no longer holds back. */
    private releaseBuffered(delivered: PortMessage): void {
        const orderingKey = delivered.command.orderingKey;
        if (orderingKey === undefined) {
            return;
        }
        const successors = this.messages
            .filter((candidate) => candidate.command.orderingKey === orderingKey && candidate.buffered)
            .sort((left, right) => (left.command.seq ?? 0) - (right.command.seq ?? 0));
        for (const successor of successors) {
            if (this.findHeldPredecessor(successor) !== undefined) {
                return;
            }
            successor.buffered = false;
            this.recordReceiverMessage(successor);
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
                        typeId: 'al.control.nack.v2',
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
        if (this.recoveryOwnerInstalled) {
            this.recordRecoveryOwnerInvocation(message);
        }
    }

    /** The receiver's channel owner is invoked once with the track's cursor and the browser states it on the storage port. */
    private recordRecoveryOwnerInvocation(message: PortMessage): void {
        this.receiver.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.storage',
            payload: {
                data: {
                    kind: 'recovery-owner-invoked',
                    orderingKey: message.command.orderingKey,
                    senderId: 'sender',
                    epoch: 0,
                    lastContiguousSeq: 1,
                    expectedSeq: 2,
                    observedSeq: message.command.seq,
                    carrier: 'rtc'
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

    private isHeld(message: PortMessage): boolean {
        return [...this.holds.values()].some((hold) =>
            hold.kind === 'type' ? hold.typeId === message.command.typeId : hold.kind === 'message' && hold.msgId === message.msgId
        );
    }

    /**
     * The browser adapter resolves a `match.msgId` token against the recipe's result cache before it arms the fault;
     * this port reads the same identity from the send the token names.
     */
    private toPortHold(match: RallarBlackBoxTestFaultInjectCommand['match']): PortHold {
        if ('msgId' in match && typeof match.msgId === 'string') {
            const sendCommandId = HOLD_MSG_ID_REFERENCE.exec(match.msgId)?.[1];
            const sent = this.messages.find((message) => message.command.commandId === sendCommandId);
            assert(sent, `the hold names ${match.msgId}, which no send of this run returned`);
            return { kind: 'message', msgId: sent.msgId };
        }
        return 'typeId' in match && typeof match.typeId === 'string' ? { kind: 'type', typeId: match.typeId } : { kind: 'control' };
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
        this.recordReceiverMessage(message);
        this.releaseBuffered(message);
    }

    private recordReceiverMessage(message: PortMessage): void {
        this.deliveries += 1;
        message.deliveredIndex = this.deliveries;
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

const HELD_ORIGINAL_MARKERS = ['delivery-reload', 'durable-takeover', 'checkpoint-recovery', 'flush-on-hide'];

/** A durable original a page held when it ended, a reloaded document's or an ended owner page's, that its page saved. */
function isHeldOriginal(message: PortMessage): boolean {
    const marker = isJsonRecordValue(message.command.payload) ? message.command.payload.marker : undefined;
    return HELD_ORIGINAL_MARKERS.includes(String(marker)) && !message.submitted && message.checkpoint !== 'lost';
}

function isUnsavedCheckpoint(message: PortMessage): boolean {
    return message.checkpoint === 'unsaved';
}

for (const carrier of ALM_CONFORMANCE_CARRIERS) {
    Deno.test(`the ${carrier} takeover's three recipes run end to end against the fixture's takeover model`, async () => {
        const scenario = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            carrier,
            typeId: 'alm.conformance',
            senderConnection: 'almConformanceSender',
            receiverConnection: 'almConformanceReceiver',
            deadlineMs: 18_000
        }).find((candidate) => candidate.scenarioId === 'durable-takeover');
        assert(scenario?.successor);
        const ports = new GeneratedAlmPorts(true);

        const owner = await ports.sender.execute(toRecipeRun(scenario.sender));
        const held = ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'durable-takeover');
        assertEquals(held.map((message) => message.submitted), [false], 'the owner\'s hold keeps its original from the carrier');
        ports.replaceSenderDocument();
        const successor = await ports.sender.execute(toRecipeRun(scenario.successor));
        const receiver = await ports.receiver.execute(toRecipeRun(scenario.receiver));

        for (const [role, result] of [['owner', owner], ['successor', successor], ['receiver', receiver]] as const) {
            assertEquals(result.ok, true, `${role}: ${JSON.stringify(result)}`);
        }
        assertEquals(held.map((message) => message.submitted), [true], 'the successor sends the original once');
        assertEquals(
            held.map((message) => [message.carrierFallback?.to, message.attemptCarriers.includes('ws')]),
            [carrier === 'rtc-with-ws-fallback' ? ['ws', true] : [undefined, false]],
            'only the fallback owner waits for its hand-over and the WS attempt that follows it'
        );
    });
}

Deno.test('the rtc-with-ws-fallback owner fails while its held RTC leg never hands over to WS', async () => {
    const scenario = createAlmConformanceRecipes({
        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
        carrier: 'rtc-with-ws-fallback',
        typeId: 'alm.conformance',
        senderConnection: 'almConformanceSender',
        receiverConnection: 'almConformanceReceiver',
        deadlineMs: 18_000
    }).find((candidate) => candidate.scenarioId === 'durable-takeover');
    assert(scenario);
    const ports = new GeneratedAlmPorts(true);
    ports.handsOverHeldFallback = false;

    const owner = await ports.sender.execute(toRecipeRun(scenario.sender));

    assertEquals(owner.ok, false, JSON.stringify(owner));
});

function toCatalogInput(carrier: AlmConformanceCarrier): CreateAlmConformanceRecipesInput {
    return {
        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
        carrier,
        typeId: 'alm.conformance',
        senderConnection: 'almConformanceSender',
        receiverConnection: 'almConformanceReceiver',
        deadlineMs: 18_000
    };
}

function findCatalogScenario(input: CreateAlmConformanceRecipesInput, scenarioId: string): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(input).find((candidate) => candidate.scenarioId === scenarioId);
    assert(scenario, `${scenarioId} over ${input.carrier}`);
    return scenario;
}

/** The recipe's commands from the one after `after` up to and including `through`; undefined ends at the last. */
function toSegment(recipe: RallarBlackBoxTestRecipe, after: string | undefined, through: string | undefined): RallarBlackBoxTestRecipe {
    const ids = recipe.commands.map((command) => command.commandId);
    const start = after === undefined ? 0 : ids.indexOf(after) + 1;
    const end = through === undefined ? ids.length : ids.indexOf(through) + 1;
    return { ...recipe, recipeId: `${recipe.recipeId}:${start}`, commands: recipe.commands.slice(start, end) };
}

function findMarked(ports: GeneratedAlmPorts, marker: string): readonly PortMessage[] {
    return ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === marker);
}

for (const carrier of ALM_CONFORMANCE_CARRIERS) {
    Deno.test(`the ${carrier} checkpoint-recovery pair restores the interval's checkpoint across the reload`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'checkpoint-recovery');
        const [checkpoint] = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints) ?? [];
        assert(checkpoint);
        const ports = new GeneratedAlmPorts(true);

        const results = [
            await ports.receiver.execute(toRecipeRun(toSegment(receiver, undefined, checkpoint.receiverReadyEnd))),
            await ports.sender.execute(toRecipeRun(toSegment(sender, undefined, checkpoint.senderPrefixEnd))),
            await ports.receiver.execute(toRecipeRun(toSegment(receiver, checkpoint.receiverReadyEnd, checkpoint.receiverAbsenceEnd)))
        ];
        ports.replaceSenderDocument();
        results.push(
            await ports.sender.execute(toRecipeRun(toSegment(sender, checkpoint.senderReload, undefined))),
            await ports.receiver.execute(toRecipeRun(toSegment(receiver, checkpoint.receiverAbsenceEnd, undefined)))
        );

        for (const result of results) {
            assertEquals(result.ok, true, JSON.stringify(result));
        }
        assertEquals(findMarked(ports, 'checkpoint-recovery').map((message) => message.submitted), [true], 'the restored original is sent once');
    });

    Deno.test(`the ${carrier} checkpoint-lag recipes lag, refuse, recover and deliver the admitted sends`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'checkpoint-lag');
        const ports = new GeneratedAlmPorts(true);

        const owner = await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(receiver));

        assertEquals(owner.ok, true, JSON.stringify(owner));
        assertEquals(received.ok, true, JSON.stringify(received));
        assertEquals(
            findMarked(ports, 'checkpoint-lag').map((message) => [message.state, message.failure]),
            [['acknowledged', undefined], ['failed', { kind: 'storage-unavailable', cause: 'checkpoint-lag' }], ['acknowledged', undefined]]
        );
    });
}

for (const carrier of ['ws', 'rtc'] as const) {
    Deno.test(`the ${carrier} flush-on-hide successor restores what the owner's lifecycle flush saved`, async () => {
        const { sender, receiver, successor } = findCatalogScenario(toCatalogInput(carrier), 'flush-on-hide');
        assert(successor);
        const ports = new GeneratedAlmPorts(true);

        const owner = await ports.sender.execute(toRecipeRun(sender));
        ports.flushCheckpoints();
        ports.replaceSenderDocument();
        const restored = await ports.sender.execute(toRecipeRun(successor));
        const received = await ports.receiver.execute(toRecipeRun(receiver));

        for (const [role, result] of [['owner', owner], ['successor', restored], ['receiver', received]] as const) {
            assertEquals(result.ok, true, `${role}: ${JSON.stringify(result)}`);
        }
        assertEquals(findMarked(ports, 'flush-on-hide').map((message) => message.submitted), [true]);
    });

    Deno.test(`the ${carrier} flush-on-hide successor restores nothing when the owner's page ends unflushed inside the interval`, async () => {
        const { sender, successor } = findCatalogScenario(toCatalogInput(carrier), 'flush-on-hide');
        assert(successor);
        const ports = new GeneratedAlmPorts(true);

        await ports.sender.execute(toRecipeRun(sender));
        ports.replaceSenderDocument();
        const restored = await ports.sender.execute(toRecipeRun(successor));

        assertEquals(restored.ok, false, JSON.stringify(restored));
        assertEquals(findMarked(ports, 'flush-on-hide').map((message) => message.submitted), [false], 'the unsaved admission is lost with its page');
    });
}

for (const carrier of ALM_CONFORMANCE_SINGLE_HOP_CARRIERS) {
    Deno.test(`the ${carrier} ordering-gap-repair pair holds the second frame, reads the range NACK and delivers all three in order`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'ordering-gap-repair');
        const ports = new GeneratedAlmPorts(true);

        const sent = await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(receiver));

        assertEquals(sent.ok, true, JSON.stringify(sent));
        assertEquals(received.ok, true, JSON.stringify(received));
        const messages = findMarked(ports, 'ordering-gap-repair');
        assertEquals(messages.map((message) => [message.command.seq, message.buffered, message.failure]), [
            [1, false, undefined],
            [2, false, undefined],
            [3, false, undefined]
        ]);
        assertEquals(
            [...messages].sort((left, right) => left.deliveredIndex! - right.deliveredIndex!).map((message) => message.command.seq),
            [1, 2, 3],
            'the channel read the sequences in order once the gap closed'
        );
        assertEquals(messages[1].repairAttempts, 1, 'the one gap report spent one retransmit');
    });
}

for (const carrier of ALM_CONFORMANCE_CARRIERS) {
    Deno.test(`the ${carrier} repair-exhausted pair keeps the hold, spends the budget and reads the second send skipped`, async () => {
        const { sender, receiver } = findCatalogScenario(toCatalogInput(carrier), 'repair-exhausted');
        const ports = new GeneratedAlmPorts(true);

        const sent = await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(receiver));

        assertEquals(sent.ok, true, JSON.stringify(sent));
        assertEquals(received.ok, true, JSON.stringify(received));
        assertEquals(findMarked(ports, 'repair-exhausted').map((message) => [message.command.seq, message.state, message.buffered, message.failure]), [
            [1, 'acknowledged', false, undefined],
            [2, 'failed', false, { kind: 'skipped', reason: 'repair-exhausted' }],
            [3, 'transport-accepted', true, undefined],
            [4, 'transport-accepted', true, undefined]
        ]);
    });
}

for (const carrier of ['rtc', 'rtc-with-ws-fallback'] as const) {
    // The receiver connects before the sender starts, as the sender's readiness wait orders the lane.
    Deno.test(`the ${carrier} ordering-resync receiver with a recording owner reads the owner's invocation and its cursor`, async () => {
        const { sender, receiver } = findCatalogScenario({ ...toCatalogInput(carrier), recoveryOwner: 'record' }, 'ordering-resync');
        const connectId = `${receiver.recipeId}-connect`;
        const ports = new GeneratedAlmPorts(true);

        const connected = await ports.receiver.execute(toRecipeRun(toSegment(receiver, undefined, connectId)));
        const sent = await ports.sender.execute(toRecipeRun(sender));
        const received = await ports.receiver.execute(toRecipeRun(toSegment(receiver, connectId, undefined)));

        for (const [role, result] of [['receiver connect', connected], ['sender', sent], ['receiver', received]] as const) {
            assertEquals(result.ok, true, `${role}: ${JSON.stringify(result)}`);
        }
        assertEquals(ports.recoveryOwnerInstalled, true);
    });
}

function toRecipeRun(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestCommand {
    return { kind: 'recipe.run', commandId: `${recipe.recipeId}-run`, recipe };
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
