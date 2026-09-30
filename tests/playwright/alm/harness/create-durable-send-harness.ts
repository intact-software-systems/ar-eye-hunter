import { toBrowserWsClientALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import { createBrowserALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent
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
    DurableSendRunInput
} from './durable-send-harness-contract.ts';
import { PacedFrameLoad } from './paced-frame-load.ts';

/** Far above any batch this page runs, so a missing probe shows up as a count instead of a hang. */
const SETTLE_BOUND_MS = 2_000;

interface DurableSendSample {
    readonly sendToDispatchMs: number;
    readonly settled: boolean;
}

/** The carrier's send calls and the durable lane's readiness probes, as the page observes them. */
class DurableSendObservation {
    private readonly dispatchWaiters = new Map<string, (atMs: number) => void>();
    private probeWaiters: (() => void)[] = [];

    observeDispatch(msgId: string): void {
        const atMs = performance.now();
        this.dispatchWaiters.get(msgId)?.(atMs);
        this.dispatchWaiters.delete(msgId);
    }

    observeDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
        if (event.kind !== 'readiness-probe' || event.lane !== 'durable') {
            return;
        }
        const waiters = this.probeWaiters;
        this.probeWaiters = [];
        waiters.forEach((resolve) => resolve());
    }

    waitForDispatch(msgId: string): Promise<number> {
        return new Promise((resolve) => this.dispatchWaiters.set(msgId, resolve));
    }

    waitForProbe(boundMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), boundMs);
            this.probeWaiters.push(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }
}

class PlainPageDurableSendHarness implements DurableSendHarness {
    private readonly sessionId: string;
    private readonly runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    private readonly observation: DurableSendObservation;

    constructor(
        sessionId: string,
        runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>,
        observation: DurableSendObservation
    ) {
        this.sessionId = sessionId;
        this.runtime = runtime;
        this.observation = observation;
    }

    async runSends(input: DurableSendRunInput): Promise<DurableSendRun> {
        const frameLoad = new PacedFrameLoad();
        if (input.frameLoad !== undefined) {
            frameLoad.start(input.frameLoad);
        }
        try {
            const samples = await this.sendAll(input, frameLoad);
            return { ...samples, frameLoad: frameLoad.stop() };
        }
        finally {
            frameLoad.stop();
        }
    }

    private async sendAll(
        input: DurableSendRunInput,
        frameLoad: PacedFrameLoad
    ): Promise<Omit<DurableSendRun, 'frameLoad'>> {
        const sendToDispatchMs: number[] = [];
        let unsettledCount = 0;
        for (let index = 0; index < input.warmupCount + input.measuredCount; index += 1) {
            await frameLoad.waitForFrameEnd();
            const sample = await this.sendOnce(
                toHarnessMessage(this.sessionId, `${input.runId}-${index}`)
            );
            if (index >= input.warmupCount) {
                sendToDispatchMs.push(sample.sendToDispatchMs);
                unsettledCount += sample.settled ? 0 : 1;
            }
        }
        return { sendToDispatchMs, unsettledCount };
    }

    /** One durable send, then the wait for its batch's readiness probe so the next send starts idle. */
    private async sendOnce(msg: ALMessage): Promise<DurableSendSample> {
        const dispatched = this.observation.waitForDispatch(msg.id.msgId);
        const startedAtMs = performance.now();
        assertDurableAdmission(await this.runtime.enqueueIfAbsent(msg));
        const dispatchedAtMs = await dispatched;
        const settled = await this.observation.waitForProbe(SETTLE_BOUND_MS);
        return { sendToDispatchMs: dispatchedAtMs - startedAtMs, settled };
    }
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
 * The browser WS client's durable outbound owner over the browser's IndexedDB store pair, with a
 * carrier that records when it is called and reports every attempt sent.
 */
export async function createDurableSendHarness(sessionId: string): Promise<DurableSendHarness> {
    const observation = new DurableSendObservation();
    const stores = createBrowserALOutboundRuntimeStores(
        toBrowserWsClientALRuntimeStoreId(sessionId),
        {
            canonicalScope: `browser-session:${sessionId}`
        }
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
    return new PlainPageDurableSendHarness(sessionId, runtime, observation);
}
