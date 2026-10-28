import { assert, assertEquals } from '@std/assert';

import type { BlackBoxRallarDeliveryObservation } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestFaultInjectCommand,
    RallarBlackBoxTestMessagesReplayCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { ALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import { AL_CHECKPOINT_DEFAULT_SETTINGS } from '@shared/alm/checkpoint/al-checkpoint-default-settings.ts';
import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import {
    createInitialALDeliveryLifecycle,
    isALDeliveryTerminal,
    isALDeliveryTerminalState,
    type ALDeliveryCarrier,
    type ALDeliveryCarrierFallback,
    type ALDeliveryDurabilityDowngrade,
    type ALDeliveryLifecycle,
    type ALDeliveryReceiptEvidence,
    type ALDeliveryRelayRejection,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    computeALDeliveryDeadline,
    computeALDeliveryLifecycle
} from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

type MessagesPortKind =
    | 'messages.send'
    | 'messages.observe'
    | 'messages.cancel'
    | 'messages.receipts'
    | 'messages.received';

/** A page of the run; `recipient-b` is the second recipient of a three-agent cell. */
type PortRole = 'sender' | 'receiver' | 'recipient-b';

type PortCommand<TKind extends RallarBlackBoxTestCommand['kind']> = Extract<
    RallarBlackBoxTestCommand,
    Readonly<{ kind: TKind; }>
>;

/** A `local-checkpoint` row: in memory until a checkpoint saves it, lost if its page ends first. */
type PortCheckpoint = 'unsaved' | 'saved' | 'lost';

type PortCheckpointHealth = 'healthy' | 'delayed' | 'failing';

export interface AlmReloadParticipant {
    readonly role: PortRole;
    readonly sessionId: string;
    readonly principalId: string;
}

export interface PortMessage {
    readonly command: RallarBlackBoxTestMessagesSendCommand;
    readonly msgId: string;
    readonly admittedAtMs: number;
    /** Undefined for every send that is not an admitted `local-checkpoint` one. */
    checkpoint: PortCheckpoint | undefined;
    state: ALDeliveryState;
    submitted: boolean;
    activeCarrier: ALDeliveryCarrier;
    readonly recipientRoles: readonly PortRole[];
    deliveredRecipientRoles: readonly PortRole[];
    receiptEvidence: ALDeliveryReceiptEvidence;
    /** An ordered send the receiver holds back behind a gap: submitted, but handed to no channel yet. */
    buffered: boolean;
    /** The order the receiver's channel saw it in; undefined until it did. */
    deliveredIndex: number | undefined;
    /** The retransmits a gap report has charged to this message; the budget is one. */
    repairAttempts: number;
    /** The roster the sender's room snapshot held when it sent, which its room target carries. */
    readonly rosterVersion: number;
    /** The snapshot floor the send states; undefined for a send that states none. */
    readonly floor: number | undefined;
    attemptCarriers: readonly ('rtc' | 'ws')[];
    attemptOutcomes: readonly ('not-ready' | 'sent')[];
    /**
     * The volatile bound's refusal, a refused durable send under a storage quota, or a repair budget spent while the
     * message stayed held; undefined for every send admitted and delivered.
     */
    failure: ALDeliveryFailure | undefined;
    reason: string | undefined;
    /** The trusted server's refusal of a send from a sender no longer in the group; undefined otherwise. */
    relayRejection: ALDeliveryRelayRejection | undefined;
    carrierFallback: ALDeliveryCarrierFallback | undefined;
    /** A durable send a volatile channel admitted volatile while its storage was full. */
    readonly durabilityDowngrade: ALDeliveryDurabilityDowngrade | undefined;
}

/**
 * The group as the server holds it. A read returns its versions; a member that leaves or rejoins moves the roster and
 * the snapshot by one, as every roster write does.
 */
interface PortGroup {
    snapshotVersion: number;
    rosterVersion: number;
    readonly left: Set<PortRole>;
    /** The group's creator and only owner, whose own leave the server refuses `last-owner`. */
    owner: PortRole;
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
    | Readonly<{ kind: 'control'; controlType: string | undefined; carrier: 'rtc' | 'ws'; }>;

const HELD_ORIGINAL_MARKERS = ['delivery-reload', 'durable-takeover', 'checkpoint-recovery', 'flush-on-hide'];

const HOLD_MSG_ID_REFERENCE = /^\{resultCache\.(.+)\.value\.msgId\}$/u;

interface AlmReloadAdmissionPayload {
    readonly marker: string | undefined;
    readonly index: number | undefined;
    readonly seq: number | undefined;
}

interface AlmReloadSendAdmission {
    readonly message: PortMessage;
    readonly capacityRefused: boolean;
    readonly durable: boolean;
    readonly checkpointed: boolean;
    readonly quotaHeld: boolean;
    readonly storageRefused: boolean;
    readonly rejected: boolean;
}

/** Controlled external facts prove recipe/control composition, never native storage or transport behavior. */
export class AlmReloadPorts {
    now = 1_000;
    senderDocument = 100;
    /** IndexedDB admission writes per page since its last reset: only a send that opts into a durability writes. */
    readonly writes: Record<PortRole, number> = { sender: 1, receiver: 1, 'recipient-b': 1 };
    /** The lane connects the receiver before recipient-b and the sender, so the receiver creates the group. */
    readonly group: PortGroup = { snapshotVersion: 7, rosterVersion: 4, left: new Set(), owner: 'receiver' };
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
    readonly recipientB: RallarBlackBoxTestRuntime;
    sender: RallarBlackBoxTestRuntime;
    private absence: { duration: number; release: () => void; } | undefined;
    private entered = Promise.withResolvers<void>();
    private holdNextSleep = false;
    private readonly replacesDocument: boolean;
    private readonly participants: readonly AlmReloadParticipant[];
    private readonly receiverBarrierFaults = new Map<string, readonly RallarBlackBoxTestFaultInjectCommand[]>();

    constructor(replacesDocument: boolean, participants: readonly AlmReloadParticipant[]) {
        this.participants = [...participants];
        this.replacesDocument = replacesDocument;
        this.receiver = this.createRuntime('receiver');
        this.recipientB = this.createRuntime('recipient-b');
        this.sender = this.createRuntime('sender');
    }

    /** Sequential control replay still arms the recipient's actual faults before its paired sender is released. */
    prepareReceiverBarriers(commands: readonly RallarBlackBoxTestCommand[]): void {
        let faults: RallarBlackBoxTestFaultInjectCommand[] = [];
        for (const command of commands) {
            if (command.kind === 'fault.inject') {
                faults.push(command);
            }
            else if (command.kind === 'barrier') {
                this.receiverBarrierFaults.set(command.barrierId, faults);
                faults = [];
            }
        }
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

    private createRuntime(role: PortRole): RallarBlackBoxTestRuntime {
        return createDefaultRallarBlackBoxTestRuntime({
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

    private executePort(
        role: PortRole,
        command: RallarBlackBoxTestCommand
    ): RallarBlackBoxTestCommandOutcome | Promise<RallarBlackBoxTestCommandOutcome> | undefined {
        this.settleCheckpoints();
        const document = { origin: 'https://fixture.test', timeOrigin: role === 'sender' ? this.senderDocument : 50 };
        const participant = this.participants.find((participant) => participant.role === role);
        assert(participant, `${role} is not a participant of this fixture cell`);
        const session = { clientId: role, sessionId: participant.sessionId };
        switch (command.kind) {
            case 'http.request':
                return this.requestGroup(role, command);
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
                return this.executeMessagesPort(role, command);
            case 'close':
                return { status: 'ok', value: { status: 'closed' } };
            case 'barrier':
                return this.releaseBarrier(role, command.barrierId);
            case 'assert':
            case 'wait':
            case 'loop':
                return undefined; // These acceptance and composite commands execute in the real runtime.
            default:
                throw new Error(`Unexpected external fixture port: ${command.kind}`);
        }
    }

    private async releaseBarrier(role: PortRole, barrierId: string): Promise<RallarBlackBoxTestCommandOutcome> {
        if (role === 'sender') {
            for (const fault of this.receiverBarrierFaults.get(barrierId) ?? []) {
                const result = await this.receiver.execute(fault);
                assert(result.ok, `recipient preparation failed at ${fault.commandId}`);
            }
        }
        // Control-recipe-barrier.test.ts proves the real control barrier; this owner supplies paired external facts.
        return { status: 'ok', value: { barrierId, outcome: 'released', arrivedAgentIds: [role] } };
    }

    private executeMessagesPort(
        role: PortRole,
        command: PortCommand<MessagesPortKind>
    ): RallarBlackBoxTestCommandOutcome {
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
                return this.readReceived(role, command);
        }
    }

    private observe(command: PortCommand<'messages.observe'>): RallarBlackBoxTestCommandOutcome {
        const message = this.handles.get(command.handleId);
        if (message === undefined) {
            return { status: 'ok', value: toPortDeliveryObservation(command.handleId, message) };
        }
        let lifecycle = this.readDeliveryLifecycle(message);
        if (!isALDeliveryTerminal(lifecycle) && !command.state.includes(lifecycle.state)) {
            assert(command.timeoutMs !== undefined, 'an external observation has an authored timeout');
            const budgetMs = Math.min(command.timeoutMs, Math.max(0, (command.deadlineEpochMs ?? Infinity) - this.now));
            this.now += Math.min(budgetMs, Math.max(0, (lifecycle.expiresAtMs ?? Infinity) - this.now));
            this.settleCheckpoints();
            lifecycle = this.readDeliveryLifecycle(message);
        }
        return {
            status: isALDeliveryTerminal(lifecycle) || command.state.includes(lifecycle.state) ? 'ok' : 'failed',
            value: toPortDeliveryObservation(command.handleId, message)
        };
    }

    private cancel(command: PortCommand<'messages.cancel'>): RallarBlackBoxTestCommandOutcome {
        const message = this.handles.get(command.handleId);
        assert(message);
        const lifecycle = this.readDeliveryLifecycle(message);
        if (!message.submitted && !isALDeliveryTerminal(lifecycle)) {
            message.state = 'cancelled';
        }
        return {
            status: 'ok',
            value: { handleId: command.handleId, state: message.state, submitted: message.submitted }
        };
    }

    private readReceipts(command: PortCommand<'messages.receipts'>): RallarBlackBoxTestCommandOutcome {
        const message = this.handles.get(command.handleId);
        assert(message);
        this.readDeliveryLifecycle(message);
        const value = toPortDeliveryObservation(command.handleId, message);
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
            !this.isHeld(message) || isALDeliveryTerminalState(message.state, message.command.ack ?? 'receiver')
        ) {
            return;
        }
        if (message.carrierFallback === undefined) {
            message.activeCarrier = 'ws';
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

    private readReceived(role: PortRole, command: PortCommand<'messages.received'>): RallarBlackBoxTestCommandOutcome {
        // A command addressed to the server reaches no member of the room; a buffered one has not reached its channel.
        const arrived = this.messages.filter((message) =>
            message.command.typeId === command.typeId && message.submitted && !message.buffered &&
            message.deliveredRecipientRoles.includes(role)
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

    private readStorageCounters(role: PortRole, reset: boolean): RallarBlackBoxTestCommandOutcome {
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
    private deliverRecoveredOriginals(role: PortRole): void {
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
    private reportStoreRecoveries(role: PortRole, sessionId: string): void {
        if (role !== 'sender') {
            return;
        }
        for (const message of this.messages) {
            this.readDeliveryLifecycle(message);
        }
        const retained = this.messages.filter(isStoredOriginal);
        const durable = retained.filter((message) => message.checkpoint === undefined);
        const checkpointed = retained.filter((message) => message.checkpoint === 'saved');
        const overRtc = (message: PortMessage) => message.command.carrier === 'rtc';
        const stores = [
            { storeId: `browser-session-inbound:${sessionId}/ws`, rows: [] },
            { storeId: `browser-session-inbound:${sessionId}/rtc`, rows: [] },
            {
                storeId: `browser-ws-client:${sessionId}`,
                rows: durable.filter((message) => !overRtc(message))
            },
            { storeId: `browser-rtc-overlay:${sessionId}`, rows: durable.filter(overRtc) },
            {
                storeId: `browser-ws-client-checkpoint:${sessionId}`,
                rows: checkpointed.filter((message) => !overRtc(message))
            },
            { storeId: `browser-rtc-overlay-checkpoint:${sessionId}`, rows: checkpointed.filter(overRtc) }
        ];
        for (const { storeId, rows } of stores) {
            this.sender.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.storage',
                payload: {
                    data: {
                        kind: 'recovery',
                        storeId,
                        outcome: {
                            kind: 'restored',
                            claimed: rows.filter(isHeldOriginal).length,
                            expired: rows.filter((message) => message.state === 'expired').length
                        }
                    }
                }
            });
        }
    }

    /** The checkpoint timer, run on every fixture step and sleep: a row unsaved for one interval is written. */
    private settleCheckpoints(): void {
        this.writeCheckpoints(
            this.messages.filter((message) =>
                isUnsavedCheckpoint(message) &&
                this.now - message.admittedAtMs >= AL_CHECKPOINT_DEFAULT_SETTINGS.intervalMs
            )
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
                    storeId: `${
                        overRtc ? 'browser-rtc-overlay-checkpoint' : 'browser-ws-client-checkpoint'
                    }:sender-stored-session`,
                    status,
                    lastFailure: status === 'delayed'
                        ? undefined
                        : {
                            cause: 'checkpoint-lag',
                            detail: `The oldest unsaved change passed ${AL_CHECKPOINT_DEFAULT_SETTINGS.lagBoundMs} ms.`
                        },
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
            this.holds.set(command.faultId, this.toPortHold(command));
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
        const { message, capacityRefused, durable, checkpointed, quotaHeld, storageRefused, rejected } = this
            .createSendAdmission(command, toAlmReloadAdmissionPayload(command.payload));
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
                if (
                    prior.command.typeId === command.typeId && isJsonRecordValue(prior.command.payload) &&
                    prior.command.payload.revision === 'old'
                ) {
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

    /** Derive admission from the current page and room facts before publishing any fixture effects. */
    private createSendAdmission(
        command: RallarBlackBoxTestMessagesSendCommand,
        payload: AlmReloadAdmissionPayload
    ): AlmReloadSendAdmission {
        // The lowered volatile bound refuses the third capacity send at admission (D78): no attempt, nothing delivered.
        const capacityRefused = payload.marker === 'capacity' && payload.index === 3;
        const requestedDurability = command.durability ?? 'volatile';
        const durable = requestedDurability !== 'volatile';
        const checkpointed = command.durability === 'local-checkpoint';
        const quotaHeld = this.storageQuotaFaultId !== undefined;
        // The checkpoint tier's send path stores nothing: only a checkpoint lag past its bound makes it unavailable.
        const unavailable = checkpointed ? this.checkpointHealth === 'failing' : quotaHeld;
        const storageRefused = durable && unavailable && command.onStorageUnavailable !== 'volatile';
        const downgraded = durable && unavailable && command.onStorageUnavailable === 'volatile';
        const cause = checkpointed ? 'checkpoint-lag' : 'quota';
        const rejected = payload.marker === 'bounded-rejection' || capacityRefused || storageRefused;
        const recipientRoles = resolvePortRecipientRoles(command, this.participants, this.group);
        const message: PortMessage = {
            command,
            msgId: `port-message-${this.messages.length + 1}`,
            admittedAtMs: this.now,
            checkpoint: checkpointed && !storageRefused && !downgraded ? 'unsaved' : undefined,
            state: storageRefused ? 'failed' : rejected ? 'rejected' : payload.seq === 300 ? 'queued' : 'accepted',
            submitted: false,
            activeCarrier: command.carrier === 'ws' ? 'ws' : 'rtc',
            recipientRoles,
            deliveredRecipientRoles: [],
            receiptEvidence: createInitialPortReceiptEvidence(
                command,
                this.participants.filter((participant) => recipientRoles.includes(participant.role)),
                this.group.owner
            ),
            buffered: false,
            deliveredIndex: undefined,
            repairAttempts: 0,
            rosterVersion: this.group.rosterVersion,
            floor: toPortFloor(command.minSnapshotVersion, this.group.snapshotVersion),
            attemptCarriers: [],
            attemptOutcomes: [],
            relayRejection: undefined,
            failure: capacityRefused
                ? { kind: 'refused', reason: 'capacity' }
                : storageRefused
                ? { kind: 'storage-unavailable', cause }
                : undefined,
            carrierFallback: undefined,
            reason: undefined,
            durabilityDowngrade: downgraded ? { requested: requestedDurability, cause } : undefined
        };
        return {
            message,
            capacityRefused,
            durable,
            checkpointed,
            quotaHeld,
            storageRefused,
            rejected
        };
    }

    private route(message: PortMessage, rejected: boolean): void {
        const { command } = message;
        const handedOver = isJsonRecordValue(command.payload)
            ? HANDED_OVER_WS_OUTCOMES[String(command.payload.marker)]
            : undefined;
        if (this.group.left.has('sender')) {
            this.refuseFenced(message);
        }
        else if (message.floor !== undefined && message.floor > this.group.snapshotVersion) {
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
     * The hop reads the gap and, once per arrival that reveals it, NACKs the range of the held sequence: one hint per
     * revealing message, whatever controls that arrival raises. The sender admits each as `committed`; the first hint
     * answers with one retransmission, and the second finds that budget of one spent and settles the held message
     * `skipped` as `repair-exhausted`. The revealing frame waits at the receiver for the gap to close.
     */
    private bufferBehindGap(message: PortMessage, held: PortMessage): void {
        message.submitted = true;
        message.buffered = true;
        message.state = 'transport-accepted';
        this.recordSenderNack(message, 'committed');
        if (held.repairAttempts >= 1) {
            held.state = 'failed';
            held.failure = { kind: 'skipped', reason: 'repair-exhausted' };
            return;
        }
        held.repairAttempts += 1;
        this.recordRepairDispatch(held);
    }

    /** The hint served: the held message's repair commit, stated as the sender's own commit while the hold stands. */
    private recordRepairDispatch(held: PortMessage): void {
        recordOutboundDiagnostic(this.sender, {
            kind: 'commit-phases',
            lane: 'durable',
            senderId: 'sender',
            msgId: held.msgId,
            typeId: held.command.typeId,
            origin: 'repair',
            readDurationMs: 0,
            readOperationCount: 0,
            commitDurationMs: 0,
            commitOutcome: 'committed',
            ...toPortMessageTrace(held)
        });
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
            if (isALDeliveryTerminal(this.readDeliveryLifecycle(successor))) {
                continue;
            }
            if (this.findHeldPredecessor(successor) !== undefined) {
                return;
            }
            successor.buffered = false;
            if (successor.command.carrier !== 'ws') {
                this.recordBufferedRelease(orderingKey, successor);
            }
            this.recordReceiverMessage(successor);
        }
    }

    /**
     * The claim that released one buffered sequence of the track `<ordering key>:<sender>:0`; it names no message.
     * Over WS the relay is the hop that buffers and releases, out of the receiver page's sight, so none is stated there.
     */
    private recordBufferedRelease(orderingKey: string, successor: PortMessage): void {
        recordInboundDiagnostic(this.receiver, {
            kind: 'claim-settled',
            lane: 'durable',
            workerId: 'receiver-inbound',
            effectId: `release:${encodeURIComponent(`${orderingKey}:sender:0`)}:${successor.command.seq}`,
            msgId: null,
            typeId: null,
            subjectMsgId: null,
            payloadKind: 'release-buffered',
            durationMs: 0,
            attempts: 1,
            outcome: 'completed',
            queueWaitMs: 0,
            dueAtMs: this.now,
            batchStartedAtMs: this.now,
            startedAtMs: this.now,
            traceId: null,
            corrId: null
        });
    }

    /** Delivered with an attempt on each carrier; the receiver states its verdict on the WS copy. */
    private handOver(message: PortMessage, handedOver: HandedOverOutcome): void {
        message.activeCarrier = 'ws';
        message.attemptCarriers = ['rtc', 'ws'];
        message.attemptOutcomes = handedOver.attemptOutcomes;
        message.carrierFallback = {
            from: 'rtc',
            to: 'ws',
            reason: handedOver.fallbackReason,
            atMs: this.now,
            detail: 'The RTC leg handed the send over to WS.'
        };
        this.deliver(message);
        recordInboundDiagnostic(this.receiver, {
            kind: 'admission-outcome',
            workerId: 'receiver-inbound',
            msgId: message.msgId,
            typeId: message.command.typeId,
            carrier: 'ws',
            outcome: handedOver.outcome,
            reason: handedOver.reason,
            ...toPortMessageTrace(message)
        });
    }

    /** The server keeps a command addressed to itself and answers it with its own ACK; no member receives it. */
    private acknowledgeByServer(message: PortMessage): void {
        message.submitted = true;
        message.state = 'transport-accepted';
        this.completeReceipt(message, ['server-peer']);
    }

    /**
     * The first hop's snapshot is below the send's floor. Over RTC the receiver is that hop: it refuses the copy, writes
     * nothing and states the refusal, and its NACK is committed at the sender. Over WS the server is, out of the receiver
     * page's sight: it retains the copy, and its advisory NACK reaches a sender that leaves it not handled. Either way
     * the copy waits for a roster move to reach the floor.
     */
    private refuseNotYetInSync(message: PortMessage): void {
        if (message.command.carrier === 'ws') {
            this.recordSenderNack(message, 'not-handled');
            return;
        }
        this.recordSenderNack(message, 'committed');
        recordInboundDiagnostic(this.receiver, {
            kind: 'admission-outcome',
            workerId: 'receiver-inbound',
            msgId: message.msgId,
            typeId: message.command.typeId,
            carrier: 'rtc',
            outcome: 'rejected',
            reason: 'not-yet-in-sync: Awaiting the required room snapshot version',
            ...toPortMessageTrace(message)
        });
    }

    /**
     * The WS server finds the sender no longer an active member at or beyond the send's roster: it refuses the send,
     * and its NACK settles the handle rejected by the trusted server. Over RTC the sender's own room authority would
     * refuse the send first, so the fixture models the server's verdict only.
     */
    private refuseFenced(message: PortMessage): void {
        assertEquals(message.command.carrier, 'ws', 'only the server judges a sender that left the group');
        const rejection: ALDeliveryRelayRejection = { relay: 'trusted-server', reason: 'membership-fenced' };
        this.recordSenderNack(message, 'committed');
        message.state = 'rejected';
        message.failure = { kind: 'relay-rejected', rejection };
        message.relayRejection = rejection;
    }

    private recordSenderNack(message: PortMessage, outcome: 'committed' | 'not-handled'): void {
        recordOutboundDiagnostic(this.sender, {
            kind: 'control-admission',
            msgId: `${message.msgId}-nack`,
            typeId: 'al.control.nack.v2',
            targetMsgId: message.msgId,
            outcome,
            reason: 'none',
            ...toPortControlTrace(message, `${message.msgId}-nack`)
        });
    }

    /**
     * A read returns the group's versions; a leave or a rejoin moves both, which may lift a waiting send's floor. The
     * owner's own leave is refused, as the server refuses the last active owner's, and moves nothing.
     */
    private requestGroup(role: PortRole, command: PortCommand<'http.request'>): RallarBlackBoxTestCommandOutcome {
        const { method, body } = command.request;
        if (method === 'GET') {
            const { snapshotVersion, rosterVersion } = this.group;
            return { status: 'ok', value: { status: 200, body: { group: { snapshotVersion, rosterVersion } } } };
        }
        const leaves = method === 'PUT' && isJsonRecordValue(body) && body.status === 'left';
        if (leaves && role === this.group.owner) {
            return {
                status: 'failed',
                value: { status: 403 },
                error: {
                    code: 'RALLAR_BLACK_BOX_HTTP_STATUS_NOT_ACCEPTED',
                    message: 'http.request received status 403; the last active owner cannot leave the group.'
                }
            };
        }
        if (method === 'PUT' && isJsonRecordValue(body)) {
            this.moveRoster(role, leaves);
        }
        return { status: 'ok', value: { status: 200 } };
    }

    private moveRoster(role: PortRole, leaves: boolean): void {
        if (this.group.left.has(role) === leaves) {
            return;
        }
        if (leaves) {
            this.group.left.add(role);
        }
        else {
            this.group.left.delete(role);
        }
        this.group.snapshotVersion += 1;
        this.group.rosterVersion += 1;
        for (const message of this.messages.filter((candidate) => this.isFloorLifted(candidate))) {
            this.deliver(message);
        }
    }

    /** A send its floor held back, which the WS server it waits at, or the RTC sender's retry, now delivers. */
    private isFloorLifted(message: PortMessage): boolean {
        return message.floor !== undefined && !message.submitted && message.state !== 'rejected' &&
            message.floor <= this.group.snapshotVersion;
    }

    /**
     * The first hop refuses a send past the repair window: over WS the relay NACKs the sender, which commits it as the
     * word of its trusted server (R-S2c-ii-5); over RTC the receiver refuses it.
     */
    private refuseGappedSend(message: PortMessage): void {
        if (message.command.carrier === 'ws') {
            this.recordSenderNack(message, 'committed');
            return;
        }
        recordInboundDiagnostic(this.receiver, {
            kind: 'admission-outcome',
            workerId: 'receiver-inbound',
            msgId: message.msgId,
            typeId: message.command.typeId,
            carrier: 'rtc',
            outcome: 'not-handled',
            reason: 'resync-required',
            ...toPortMessageTrace(message)
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
    private replay(
        { replayOnCarrier: replay }: RallarBlackBoxTestMessagesReplayCommand
    ): RallarBlackBoxTestCommandOutcome {
        const original = this.handles.get(replay.handleId);
        assert(original);
        recordInboundDiagnostic(this.receiver, {
            kind: 'admission-outcome',
            workerId: 'receiver-inbound',
            msgId: original.msgId,
            typeId: original.command.typeId,
            carrier: replay.carrier,
            outcome: 'not-handled',
            reason: 'duplicate',
            ...toPortMessageTrace(original)
        });
        return {
            status: 'ok',
            value: { handleId: replay.handleId, msgId: original.msgId, carrier: replay.carrier, verdict: 'admitted' }
        };
    }

    /** Over RTC the receiver's hop ACK reaches the sender, whose outbound owner commits it as the product does. */
    private admitReceiverAck(message: PortMessage): void {
        recordOutboundDiagnostic(this.sender, {
            kind: 'control-admission',
            msgId: `${message.msgId}-ack`,
            typeId: 'al.control.ack.v2',
            targetMsgId: message.msgId,
            outcome: 'committed',
            reason: 'none',
            ...toPortControlTrace(message, `${message.msgId}-ack`)
        });
    }

    /** Over WS admission precedes completion; a missing logical recipient leaves the admitted receipt pending. */
    private admitServerReceipts(message: PortMessage): void {
        for (const phase of ['admitted', 'complete'] as const) {
            if (phase === 'complete' && message.state !== 'acknowledged') {
                return;
            }
            recordOutboundDiagnostic(this.sender, {
                kind: 'control-admission',
                msgId: `${message.msgId}-receipt-${phase}`,
                typeId: 'al.control.receipt.v1',
                targetMsgId: message.msgId,
                outcome: 'committed',
                reason: 'none',
                phase,
                ...toPortControlTrace(message, `${message.msgId}-receipt-${phase}`)
            });
        }
    }

    private isHeld(message: PortMessage): boolean {
        return [...this.holds.values()].some((hold) =>
            hold.kind === 'type'
                ? hold.typeId === message.command.typeId
                : hold.kind === 'message' && hold.msgId === message.msgId
        );
    }

    /**
     * The browser adapter resolves a `match.msgId` token against the recipe's result cache before it arms the fault;
     * this port reads the same identity from the send the token names.
     */
    private toPortHold(command: RallarBlackBoxTestFaultInjectCommand): PortHold {
        const { match } = command;
        if ('msgId' in match && typeof match.msgId === 'string') {
            const sendCommandId = HOLD_MSG_ID_REFERENCE.exec(match.msgId)?.[1];
            const sent = this.messages.find((message) => message.command.commandId === sendCommandId);
            assert(sent, `the hold names ${match.msgId}, which no send of this run returned`);
            return { kind: 'message', msgId: sent.msgId };
        }
        return 'typeId' in match && typeof match.typeId === 'string'
            ? { kind: 'type', typeId: match.typeId }
            : {
                kind: 'control',
                controlType: 'controlType' in match ? match.controlType : undefined,
                carrier: command.carrier === 'ws' ? 'ws' : 'rtc'
            };
    }

    private deliver(message: PortMessage): void {
        if (isALDeliveryTerminal(this.readDeliveryLifecycle(message))) {
            return;
        }
        // S3a: a send that names no ack is receipted by default; only an explicit `none` ends at transport acceptance.
        const receipted = message.command.ack !== 'none';
        message.submitted = true;
        message.state = 'transport-accepted';
        this.recordReceiverMessage(message);
        const ackHeld = [...this.holds.values()].some((hold) =>
            hold.kind === 'control' && hold.controlType === 'ack' && hold.carrier === message.activeCarrier
        );
        if (!ackHeld) {
            this.completeReceipt(
                message,
                this.participants.filter((participant) => message.deliveredRecipientRoles.includes(participant.role))
                    .map((participant) => participant.sessionId)
            );
            if (message.activeCarrier === 'rtc') {
                this.admitReceiverAck(message);
            }
            else if (receipted) {
                this.admitServerReceipts(message);
            }
        }
        this.releaseBuffered(message);
    }

    /** Reads and retains the canonical deadline transition before any observer or delivery owner acts. */
    private readDeliveryLifecycle(message: PortMessage): ALDeliveryLifecycle {
        const lifecycle = computeALDeliveryDeadline(toPortDeliveryLifecycle(message), this.now);
        message.state = lifecycle.state;
        message.failure = lifecycle.evidence.failure;
        message.reason = lifecycle.evidence.reason;
        return lifecycle;
    }

    private completeReceipt(message: PortMessage, acknowledgedPeerIds: readonly string[]): void {
        if (message.command.ack === 'none') {
            return;
        }
        const lifecycle = computePortAcknowledgement(
            message,
            toCompletedPortReceiptEvidence(message, acknowledgedPeerIds),
            this.now
        );
        message.receiptEvidence = lifecycle.evidence;
        message.state = lifecycle.state;
    }

    /** Every recipient still in the group reads the arrival, with the roster its room target carried. */
    private recordReceiverMessage(message: PortMessage): void {
        this.deliveries += 1;
        message.deliveredIndex = this.deliveries;
        const deliveredRecipientRoles = message.recipientRoles.filter((role) => !this.group.left.has(role));
        for (const role of deliveredRecipientRoles) {
            const recipient = role === 'receiver' ? this.receiver : this.recipientB;
            recipient.recordEvent({
                kind: 'message',
                connection: 'almConformanceReceiver',
                topic: 'typed',
                payload: {
                    data: {
                        msgId: message.msgId,
                        typeId: message.command.typeId,
                        rosterVersion: message.rosterVersion,
                        transport: message.activeCarrier,
                        payload: message.command.payload
                    }
                }
            });
        }
        message.deliveredRecipientRoles = deliveredRecipientRoles;
    }
}

/** A page's AL outbound diagnostic, typed as the runtime states it so the double keeps the production shape. */
function recordOutboundDiagnostic(page: RallarBlackBoxTestRuntime, event: ALOutboundRuntimeDiagnosticsEvent): void {
    page.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.browser.alm.outbound_diagnostics',
        payload: { data: event }
    });
}

/** A page's AL inbound diagnostic, typed as the runtime states it so the double keeps the production shape. */
function recordInboundDiagnostic(page: RallarBlackBoxTestRuntime, event: ALInboundRuntimeDiagnosticsEvent): void {
    page.recordEvent({ kind: 'diagnostic', topic: 'rallar.browser.alm.inbound_diagnostics', payload: { data: event } });
}

/** A port message carries no actions, so it starts its own correlation under one literal trace. */
function toPortMessageTrace(message: PortMessage): ALMessageTrace {
    return { traceId: `trace-${message.msgId}`, corrId: message.msgId };
}

/** A control travels under the trace of the message it answers and correlates under its own id. */
function toPortControlTrace(message: PortMessage, controlMsgId: string): ALMessageTrace {
    return { traceId: toPortMessageTrace(message).traceId, corrId: controlMsgId };
}

/** The floor a send states, resolved against the snapshot its sender held when it sent. */
function toPortFloor(
    floor: RallarBlackBoxTestMessagesSendCommand['minSnapshotVersion'],
    snapshotVersion: number
): number | undefined {
    if (floor === undefined) {
        return undefined;
    }
    return 'absolute' in floor ? floor.absolute : snapshotVersion + floor.aboveCurrentBy;
}

/** Read the held lifecycle before the fixture advances its next carrier attempt. */
function toPortDeliveryObservation(
    handleId: string,
    message: PortMessage | undefined
): BlackBoxRallarDeliveryObservation {
    return {
        handleId,
        state: message?.state ?? 'unobservable',
        submitted: message?.submitted ?? false,
        receiptMode: message?.receiptEvidence.receiptMode,
        confirmedHopPeerIds: message?.receiptEvidence.confirmedHopPeerIds ?? [],
        unconfirmedHopPeerIds: message?.receiptEvidence.unconfirmedHopPeerIds ?? [],
        expectedRecipientPeerIds: message?.receiptEvidence.expectedRecipientPeerIds ?? [],
        confirmedRecipientPeerIds: message?.receiptEvidence.confirmedRecipientPeerIds ?? [],
        unconfirmedRecipientPeerIds: message?.receiptEvidence.unconfirmedRecipientPeerIds ?? [],
        attempts: message?.attemptCarriers.length ?? 0,
        attemptCarriers: message?.attemptCarriers ?? [],
        attemptOutcomes: message?.attemptOutcomes ?? [],
        attemptRefusalReasons: [],
        relayRejection: message?.relayRejection,
        carrierFallback: message?.carrierFallback,
        durabilityDowngrade: message?.durabilityDowngrade,
        failure: message?.failure,
        reason: message?.reason,
        backpressured: false,
        enqueued: message !== undefined && (message.command.durability ?? 'volatile') !== 'volatile' &&
            message.durabilityDowngrade === undefined && message.state !== 'failed'
    };
}

/** A durable original a page held when it ended, a reloaded document's or an ended owner page's, that its page saved. */
function isHeldOriginal(message: PortMessage): boolean {
    return isStoredOriginal(message) && !isALDeliveryTerminal(toPortDeliveryLifecycle(message));
}

/** The saved row inventory remains available to report expired retirement as well as live claims. */
function isStoredOriginal(message: PortMessage): boolean {
    const marker = isJsonRecordValue(message.command.payload) ? message.command.payload.marker : undefined;
    return HELD_ORIGINAL_MARKERS.includes(String(marker)) && !message.submitted && message.checkpoint !== 'lost';
}

function isUnsavedCheckpoint(message: PortMessage): boolean {
    return message.checkpoint === 'unsaved';
}

/** Admission reads only these typed facts from the opaque recipe payload. */
function toAlmReloadAdmissionPayload(
    payload: RallarBlackBoxTestMessagesSendCommand['payload']
): AlmReloadAdmissionPayload {
    assert(isJsonRecordValue(payload));
    return {
        marker: typeof payload.marker === 'string' ? payload.marker : undefined,
        index: typeof payload.index === 'number' ? payload.index : undefined,
        seq: typeof payload.seq === 'number' ? payload.seq : undefined
    };
}

function resolvePortRecipientRoles(
    command: RallarBlackBoxTestMessagesSendCommand,
    participants: readonly AlmReloadParticipant[],
    group: PortGroup
): readonly PortRole[] {
    if (command.toPeer === 'server') {
        return [];
    }
    return participants.filter((participant) => {
        const role = participant.role;
        if (role === 'sender' || group.left.has(role)) {
            return false;
        }
        if (command.toPeer === 'receiver' || command.recipientPeer !== undefined) {
            return role === (command.toPeer ?? command.recipientPeer);
        }
        return command.scope !== 'principal' || participant.principalId === command.principalId;
    }).map((participant) => participant.role);
}

function createInitialPortReceiptEvidence(
    command: RallarBlackBoxTestMessagesSendCommand,
    recipients: readonly AlmReloadParticipant[],
    owner: PortRole
): ALDeliveryReceiptEvidence {
    const receiptRecipients = command.ack === 'group-leader'
        ? recipients.filter((participant) => participant.role === owner)
        : recipients;
    const expectedRecipientPeerIds = command.ack === 'none'
        ? []
        : command.toPeer === 'server'
        ? ['server-peer']
        : receiptRecipients.map((participant) => participant.sessionId);
    return {
        receiptMode: undefined,
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds,
        confirmedRecipientPeerIds: [],
        unconfirmedRecipientPeerIds: expectedRecipientPeerIds
    };
}

function toCompletedPortReceiptEvidence(
    message: PortMessage,
    acknowledgedPeerIds: readonly string[]
): ALDeliveryReceiptEvidence {
    const confirmedRecipientPeerIds = message.receiptEvidence.expectedRecipientPeerIds.filter((peerId) =>
        acknowledgedPeerIds.includes(peerId)
    );
    return {
        ...message.receiptEvidence,
        receiptMode: message.command.ack === 'group-leader' ? 'leader' : 'receiver',
        confirmedHopPeerIds: message.activeCarrier === 'rtc' && message.command.toPeer === undefined
            ? message.deliveredRecipientRoles.slice(0, 1)
            : [],
        confirmedRecipientPeerIds,
        unconfirmedRecipientPeerIds: message.receiptEvidence.expectedRecipientPeerIds.filter((peerId) =>
            !confirmedRecipientPeerIds.includes(peerId)
        )
    };
}

function computePortAcknowledgement(
    message: PortMessage,
    receiptEvidence: ALDeliveryReceiptEvidence,
    atMs: number
): ALDeliveryLifecycle {
    const mode = receiptEvidence.receiptMode;
    assert(mode !== undefined);
    return computeALDeliveryLifecycle(toPortDeliveryLifecycle(message), {
        kind: 'acknowledgement',
        msgId: message.msgId,
        carrier: message.activeCarrier,
        atMs,
        mode,
        confirmedHopPeerIds: receiptEvidence.confirmedHopPeerIds,
        unconfirmedHopPeerIds: receiptEvidence.unconfirmedHopPeerIds,
        expectedRecipientPeerIds: receiptEvidence.expectedRecipientPeerIds,
        confirmedRecipientPeerIds: receiptEvidence.confirmedRecipientPeerIds,
        unconfirmedRecipientPeerIds: receiptEvidence.unconfirmedRecipientPeerIds,
        complete: receiptEvidence.unconfirmedRecipientPeerIds.length === 0
    });
}

/** Translate retained fixture facts once for acknowledgement, deadline and terminal policy. */
function toPortDeliveryLifecycle(message: PortMessage): ALDeliveryLifecycle {
    const previous = createInitialALDeliveryLifecycle({
        msgId: message.msgId,
        typeId: message.command.typeId,
        ackMode: message.command.ack ?? 'receiver',
        receiptAlgo: message.command.ack === 'none' ? 'none' : message.receiptEvidence.receiptMode ?? 'receiver',
        expiresAtMs: message.command.ttlMs === undefined ? undefined : message.admittedAtMs + message.command.ttlMs,
        submittedAtMs: message.admittedAtMs
    });
    return {
        ...previous,
        state: message.state,
        evidence: {
            ...previous.evidence,
            ...message.receiptEvidence,
            admittedAtMs: message.admittedAtMs,
            carrierFallback: message.carrierFallback,
            durabilityDowngrade: message.durabilityDowngrade,
            relayRejection: message.relayRejection,
            failure: message.failure,
            reason: message.reason
        }
    };
}
