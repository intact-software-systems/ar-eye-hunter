import { toBrowserWsClientALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import { createBrowserALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { createBrowserUnicastMessage } from '@shared-web/browser/messages/create-browser-unicast-message.ts';
import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';
import { acceptWsQueueBoxClientControlMessage } from '@shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';

import type {
    DurableSendBatchEnd,
    DurableSendHarness,
    DurableSendPlan,
    DurableSendReceiptEnd,
    DurableSendRun,
    DurableSendRunInput,
    DurableSendSample,
    FrameLoadInput
} from './durable-send-harness-contract.ts';
import { DurableSendObservation, type DurableSendDispatch } from './durable-send-observation.ts';
import { PacedFrameLoad, type FramePhase } from './paced-frame-load.ts';

/** 7 is coprime with a 16 ms frame, so consecutive sends visit every phase before repeating one. */
const PHASE_STRIDE_MS = 7;
const HARNESS_SERVER_PEER_ID = 'harness-server';
const HARNESS_ROOM = {
    applicationId: 'alm-harness',
    workspaceId: 'alm-harness',
    groupId: 'durable-send'
};

interface DurableSendStart {
    readonly startedAtMs: number;
    readonly phase: FramePhase;
    readonly admission: Promise<ALOutboundEnqueueResult>;
    readonly dispatch: Promise<DurableSendDispatch>;
}

/** How one plan builds its message, plans its send, and what the server answers once it admits it. */
interface DurableSendPlanShape {
    readonly batchEnd: Exclude<DurableSendBatchEnd, 'timeout'>;
    readonly toMessage: (resourceId: string) => ALMessage;
    readonly planOutgoingMessage: (
        msg: ALMessage
    ) => ALOutboundDispatchPlan<ALOutboundTransportMessage>;
    /** Undefined for a plan that tracks no receipt. */
    readonly toServerReceipt: ((msg: ALMessage) => ALMessage) | undefined;
}

namespace PlainPageDurableSendHarness {
    export interface Input {
        readonly shape: DurableSendPlanShape;
        readonly runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
        readonly observation: DurableSendObservation;
        readonly frameLoad: PacedFrameLoad;
    }
}

class PlainPageDurableSendHarness implements DurableSendHarness {
    private readonly shape: DurableSendPlanShape;
    private readonly runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    private readonly observation: DurableSendObservation;
    private readonly frameLoad: PacedFrameLoad;

    constructor(input: PlainPageDurableSendHarness.Input) {
        this.shape = input.shape;
        this.runtime = input.runtime;
        this.observation = input.observation;
        this.frameLoad = input.frameLoad;
    }

    async runSends(input: DurableSendRunInput): Promise<DurableSendRun> {
        if (input.frameLoad !== undefined) {
            this.frameLoad.start(input.frameLoad);
        }
        try {
            const samples = await this.sendAll(input);
            return { samples, frameLoad: this.frameLoad.stop() };
        }
        finally {
            this.frameLoad.stop();
        }
    }

    private async sendAll(input: DurableSendRunInput): Promise<DurableSendSample[]> {
        const samples: DurableSendSample[] = [];
        for (let index = 0; index < input.warmupCount + input.measuredCount; index += 1) {
            const sample = await this.sendOnce(input, index);
            if (index >= input.warmupCount) {
                samples.push(sample);
            }
        }
        return samples;
    }

    /**
     * One durable send, the wait for its own batch to go idle, then the server's receipt, so the next send starts
     * on an idle owner with no receipt open.
     */
    private async sendOnce(input: DurableSendRunInput, index: number): Promise<DurableSendSample> {
        const msg = this.shape.toMessage(`${input.runId}-${index}`);
        const start = await new Promise<DurableSendStart>((resolve) =>
            this.frameLoad.runAtFrameOffset(
                toPhaseOffsetMs(input.frameLoad, index),
                () => resolve(this.startSend(msg, index))
            )
        );
        const [admission, dispatch] = await Promise.all([start.admission, start.dispatch]);
        assertDurableAdmission(admission);
        const batchDrain = await dispatch.batchDrain;
        return {
            sendToDispatchMs: dispatch.atMs - start.startedAtMs,
            phaseOffsetMs: start.phase.offsetMs,
            framesStraddled: dispatch.framesStarted - start.phase.framesStarted,
            batchEnd: batchDrain.endedOn,
            observedProbeCauses: batchDrain.observedProbeCauses,
            receiptEnd: await this.answerServerReceipt(msg)
        };
    }

    private startSend(msg: ALMessage, index: number): DurableSendStart {
        const dispatch = this.observation.waitForDispatch(msg.id.msgId, index);
        const startedAtMs = performance.now();
        const admission = this.runtime.enqueueIfAbsent(msg);
        return {
            startedAtMs,
            phase: this.frameLoad.getFramePhase(startedAtMs),
            admission,
            dispatch
        };
    }

    /** The receipt reaches the client's own control path, as the WS client hands a control from its server. */
    private async answerServerReceipt(msg: ALMessage): Promise<DurableSendReceiptEnd> {
        if (this.shape.toServerReceipt === undefined) {
            return 'none';
        }
        const receiptEnd = this.observation.waitForReceiptEnd(msg.id.msgId);
        await acceptWsQueueBoxClientControlMessage(this.runtime, this.shape.toServerReceipt(msg));
        return await receiptEnd;
    }
}

function toPhaseOffsetMs(frameLoad: FrameLoadInput | undefined, index: number): number {
    return frameLoad === undefined ? 0 : (index * PHASE_STRIDE_MS) % frameLoad.frameIntervalMs;
}

function assertDurableAdmission(result: ALOutboundEnqueueResult): void {
    if (result.verdict.kind !== 'admitted' || !result.verdict.durable) {
        throw new Error(`Expected a durable admission, received ${JSON.stringify(result.verdict)}`);
    }
}

function toHarnessMessage(sessionId: string, resourceId: string): ALMessage {
    return newALUnicastMessage(
        sessionId,
        { topicId: 'alm-harness', resourceId, contextId: 'durable-send' },
        'harness-peer',
        'alm-harness.durable-send.v1',
        { resourceId },
        { ttlMs: 60_000 }
    );
}

function toDurablePlan(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    return {
        msg,
        dropReasonCode: undefined,
        persist: true,
        preparedMessages: [toALOutboundTransportMessage(msg)]
    };
}

/** The ledger's minimal durable plan: no receipt, no retry, no supersedence. */
function toMinimalPlanShape(sessionId: string): DurableSendPlanShape {
    return {
        batchEnd: 'effect-drain',
        toMessage: (resourceId) => toHarnessMessage(sessionId, resourceId),
        planOutgoingMessage: toDurablePlan,
        toServerReceipt: undefined
    };
}

/** A durable command to the server in a room, as `messages.room({ purpose: 'command' }).sendWs` builds it. */
function toReceiptedCommandPlanShape(sessionId: string): DurableSendPlanShape {
    const qosProvider = toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined);
    return {
        batchEnd: 'readiness-probe',
        toMessage: (resourceId) =>
            createBrowserUnicastMessage({
                creation: { createUnicast: newALUnicastMessage, newResourceId: () => resourceId },
                resolved: {
                    input: {
                        typeId: 'alm-harness.command.v1',
                        topicId: 'alm-harness',
                        payload: { resourceId }
                    },
                    scope: 'room',
                    roomId: HARNESS_ROOM.groupId,
                    roomRef: HARNESS_ROOM
                },
                peerId: HARNESS_SERVER_PEER_ID,
                payload: { resourceId },
                senderId: sessionId,
                channel: { purpose: 'command', durability: 'local-outbox' },
                laneTtlMs: AL_CHANNEL_SEND_DEFAULTS.command.ttlMs
            }),
        planOutgoingMessage: (msg) =>
            toWsQueueBoxClientDispatchPlan(msg, {
                sessionId,
                serverPeerId: HARNESS_SERVER_PEER_ID,
                socketOpen: true,
                qosProvider
            }),
        toServerReceipt: (msg) => toServerAcknowledgement(sessionId, msg)
    };
}

/** The server's own ACK for a command addressed to it: it speaks for itself as the recipient. */
function toServerAcknowledgement(sessionId: string, msg: ALMessage): ALMessage {
    const observedAtEpochMs = Date.now();
    return newALAckControlMessage(
        {
            v: 2,
            msgId: `${HARNESS_SERVER_PEER_ID}-ack:${msg.id.msgId}`,
            senderId: HARNESS_SERVER_PEER_ID,
            ts: observedAtEpochMs
        },
        {
            ackedMsgId: msg.id.msgId,
            fromPeerId: HARNESS_SERVER_PEER_ID,
            toPeerId: sessionId,
            originPeerId: sessionId,
            logicalRecipientPeerId: HARNESS_SERVER_PEER_ID,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs
        }
    );
}

function toDurableSendPlanShape(plan: DurableSendPlan, sessionId: string): DurableSendPlanShape {
    return plan === 'minimal'
        ? toMinimalPlanShape(sessionId)
        : toReceiptedCommandPlanShape(sessionId);
}

/**
 * The browser WS client's durable outbound owner over the browser's IndexedDB store pair, on a
 * private engine with no inbound owner and no volatile pair, and a carrier that records when it is called.
 */
export async function createDurableSendHarness(
    sessionId: string,
    plan: DurableSendPlan
): Promise<DurableSendHarness> {
    const frameLoad = new PacedFrameLoad();
    const shape = toDurableSendPlanShape(plan, sessionId);
    const observation = new DurableSendObservation({ frameLoad, batchEnd: shape.batchEnd });
    const stores = createBrowserALOutboundRuntimeStores(
        toBrowserWsClientALRuntimeStoreId(sessionId),
        { canonicalScope: `browser-session:${sessionId}` }
    );
    const runtime = createDefaultALOutboundMessageRuntime<ALOutboundTransportMessage>({
        stores,
        outbox: stores.workQueue,
        carrier: 'ws',
        decodePreparedMessage: decodeALOutboundTransportMessage,
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, EnqueuedType.WS_OUTBOX),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: shape.planOutgoingMessage,
        diagnostics: (event) => observation.observeDiagnostics(event),
        // The minimal plan keeps no settlement sink, so its chain stays the one earlier heads measured.
        settlements: shape.toServerReceipt === undefined
            ? undefined
            : (settlement) => observation.observeSettlement(settlement),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            observation.observeDispatch(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    await runtime.ready();
    return new PlainPageDurableSendHarness({ shape, runtime, observation, frameLoad });
}
