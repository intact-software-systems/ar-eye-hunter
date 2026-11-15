import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_OUTBOUND_WORK_PAGE_SIZE } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createDefaultALOutboundDequeueResilience } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createDefaultOutboundTestRuntime } from '../../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from '../../outbound-test-payload.ts';

type ReadinessProbeEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'readiness-probe'; }>;

const CLOCK_START_MS = 1_760_000_000_000;
const DEQUEUE_TYPE = 'WS_OUTBOX';
const NAMESPACE = 'outbound-lane-readiness';

describe('ALOutboundStoreLane readiness', () => {
    it('judges a full page of due rows ready although the clock moves on between the handler and the probe', async () => {
        // The runtime's clock moves one millisecond on at every reading, as a real one may between any two
        // readings; the stores read it without moving it.
        let atMs = CLOCK_START_MS;
        const readStoreMs = () => atMs;
        const outbox = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(readStoreMs()));
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), readStoreMs);
        const engine = new InboxOutboxEngine();
        const probes: ReadinessProbeEvent[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores: {
                admissionStore: createALOutboundAdmissionStore({
                    nowMs: readStoreMs,
                    canonicalScope: NAMESPACE,
                    decodePrepared: decodeOutboundTestPayload,
                    namespace: NAMESPACE,
                    backend,
                    supersedenceTrackTtlMs: 60_000,
                    retention: normalizeALRuntimeStoreRetention()
                }),
                workQueue: backend.workQueue
            },
            queueEngine: engine,
            nowMs: () => atMs++,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDefaultALOutboundDequeueResilience() },
            diagnostics: (event) => {
                if (event.kind === 'readiness-probe') {
                    probes.push(event);
                }
            },
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        await runtime.ready();

        // A full page: the probe sees more rows than it read, so it answers "due now" instead of a row's time.
        for (let index = 0; index < AL_OUTBOUND_WORK_PAGE_SIZE; index += 1) {
            await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
                createDequeuedMessage(`due-${index}`),
                DEQUEUE_TYPE,
                Temporal.Instant.fromEpochMilliseconds(readStoreMs())
            ));
        }
        const probed = probes.length;
        const roundReadAtMs = atMs;

        expect(await engine.executeOnce()).toBe(true);
        expect(probes.slice(probed).map((probe) => probe.readyAtMs)).toEqual([roundReadAtMs]);
    });
});

function createDequeuedMessage(resourceId: string) {
    return newALUnicastMessage(
        'server',
        { topicId: 'chat', resourceId, contextId: 'conversation-1' },
        'peer-1',
        'chat.private-text.v1',
        { text: resourceId },
        { ttlMs: 30_000 }
    );
}
