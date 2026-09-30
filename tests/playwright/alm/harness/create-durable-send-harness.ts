import { toBrowserWsClientALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import { createBrowserALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
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

import type {
    DurableSendHarness,
    DurableSendRun,
    DurableSendRunInput,
    DurableSendSample,
    FrameLoadInput
} from './durable-send-harness-contract.ts';
import { DurableSendObservation, type DurableSendDispatch } from './durable-send-observation.ts';
import { PacedFrameLoad, type FramePhase } from './paced-frame-load.ts';

/** 7 is coprime with a 16 ms frame, so consecutive sends visit every phase before repeating one. */
const PHASE_STRIDE_MS = 7;

interface DurableSendStart {
    readonly startedAtMs: number;
    readonly phase: FramePhase;
    readonly admission: Promise<ALOutboundEnqueueResult>;
    readonly dispatch: Promise<DurableSendDispatch>;
}

class PlainPageDurableSendHarness implements DurableSendHarness {
    private readonly sessionId: string;
    private readonly runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    private readonly observation: DurableSendObservation;
    private readonly frameLoad: PacedFrameLoad;

    constructor(
        sessionId: string,
        runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>,
        observation: DurableSendObservation,
        frameLoad: PacedFrameLoad
    ) {
        this.sessionId = sessionId;
        this.runtime = runtime;
        this.observation = observation;
        this.frameLoad = frameLoad;
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

    /** One durable send, then the wait for the probe its own commit earns so the next send starts on an idle owner. */
    private async sendOnce(input: DurableSendRunInput, index: number): Promise<DurableSendSample> {
        const msg = toHarnessMessage(this.sessionId, `${input.runId}-${index}`);
        const start = await new Promise<DurableSendStart>((resolve) =>
            this.frameLoad.runAtFrameOffset(
                toPhaseOffsetMs(input.frameLoad, index),
                () => resolve(this.startSend(msg, index))
            )
        );
        const [admission, dispatch] = await Promise.all([start.admission, start.dispatch]);
        assertDurableAdmission(admission);
        const ownProbe = await dispatch.ownProbe;
        return {
            sendToDispatchMs: dispatch.atMs - start.startedAtMs,
            phaseOffsetMs: start.phase.offsetMs,
            framesStraddled: dispatch.framesStarted - start.phase.framesStarted,
            probeEnd: ownProbe.endedOn,
            observedProbeCauses: ownProbe.observedCauses
        };
    }

    private startSend(msg: ALMessage, index: number): DurableSendStart {
        const dispatch = this.observation.waitForDispatch(msg.id.msgId, index);
        const startedAtMs = performance.now();
        const admission = this.runtime.enqueueIfAbsent(msg);
        return {
            startedAtMs,
            phase: this.frameLoad.readFramePhase(startedAtMs),
            admission,
            dispatch
        };
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

/**
 * The browser WS client's durable outbound owner over the browser's IndexedDB store pair, on a
 * private engine with no inbound owner and no volatile pair, and a carrier that records when it is called.
 */
export async function createDurableSendHarness(sessionId: string): Promise<DurableSendHarness> {
    const frameLoad = new PacedFrameLoad();
    const observation = new DurableSendObservation(frameLoad);
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
        planOutgoingMessage: toDurablePlan,
        diagnostics: (event) => observation.observeDiagnostics(event),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            observation.observeDispatch(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    await runtime.ready();
    return new PlainPageDurableSendHarness(sessionId, runtime, observation, frameLoad);
}
