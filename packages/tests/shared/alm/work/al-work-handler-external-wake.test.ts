import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler, type ALWorkReadinessProbeDiagnostics } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { collectProbe, toTestALWorkReadySelection } from './al-work-test-entries.ts';

afterEach(() => {
    vi.useRealTimers();
});

describe('an external write announced to the engine', () => {
    it('re-probes only the owners of the types it wrote, whatever other owners share the engine', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const engine = new InboxOutboxEngine();
        const outboundProbes: ALWorkReadinessProbeDiagnostics[] = [];
        const inboundProbes: ALWorkReadinessProbeDiagnostics[] = [];
        const outbound = createProbeCountingHandler(engine, new Set(['AL_OUTBOUND_WORK', 'WS_OUTBOX']), outboundProbes);
        const inbound = createProbeCountingHandler(engine, new Set(['AL_INBOUND_WORK']), inboundProbes);
        try {
            await outbound.ready();
            await inbound.ready();
            await engine.executeOnce();
            const remembered = { outbound: outboundProbes.length, inbound: inboundProbes.length };

            engine.wakeAfterExternalWrite(new Set(['WS_OUTBOX']));
            await engine.executeOnce();
            // An AppInbox commit that wrote only its own queue's rows owes no AL owner a probe.
            engine.wakeAfterExternalWrite(new Set(['APP_INBOX']));
            await engine.executeOnce();

            expect(outboundProbes.slice(remembered.outbound).map((probe) => probe.cause)).toEqual(['external-wake']);
            expect(inboundProbes.slice(remembered.inbound)).toEqual([]);
        }
        finally {
            await Promise.allSettled([outbound.dispose(), inbound.dispose(), engine.stop()]);
        }
    });
});

function createProbeCountingHandler(
    engine: InboxOutboxEngine,
    workTypes: ReadonlySet<string>,
    probes: ALWorkReadinessProbeDiagnostics[]
): ALWorkHandler {
    return new ALWorkHandler({
        workerId: `owner:${[...workTypes].join('+')}`,
        port: createALWorkQueuePort({
            queue: new InMemoryQueueBox(),
            workTypes,
            leaseMs: 30_000,
            nowMs: Date.now,
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        }),
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: Date.now },
        pageSize: 16,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: async () => undefined,
        selectReady: async () => toTestALWorkReadySelection([]),
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: (event) => collectProbe(probes, event)
    });
}
