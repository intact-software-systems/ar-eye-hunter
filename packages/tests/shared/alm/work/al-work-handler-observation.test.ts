import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';
import { ALWorkHandler, type ALWorkAttemptResult, type ALWorkObservationDeferral } from '@shared/alm/work/al-work-handler.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { describe, expect, it } from 'vitest';
import { fakePort, toTestALWorkReadySelection } from './al-work-test-entries.ts';

interface ObservationCase {
    readonly enabled: boolean;
    readonly result: ALWorkAttemptResult | Error;
    readonly releaseError?: Error;
    readonly reentrant?: boolean;
    readonly constructorThrows?: boolean;
}

function observedHandler(input: ObservationCase) {
    const order: string[] = [];
    let nowMs = 1000;
    let deferSink: ALWorkObservationDeferral | undefined;
    function recordThrowingSink(): void {
        order.push('sink');
        nowMs = 99000;
        if (input.reentrant) {
            deferSink?.(recordReentrantSink);
        }
        throw new Error('optional sink');
    }
    function recordReentrantSink(): void {
        order.push('reentrant-sink');
    }
    function recordSecondSink(): void {
        order.push('second-sink');
    }
    const engine = new InboxOutboxEngine();
    const port = fakePort({
        claims: ['work'],
        onRelease: (_claim, outcome) => {
            order.push(`release:${outcome.status}:${nowMs}`);
            if (input.releaseError) {
                throw input.releaseError;
            }
        }
    });
    const handler = new ALWorkHandler({
        workerId: 'observed-worker',
        port,
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: () => nowMs },
        pageSize: 1,
        readinessMemoryMs: 0,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (selected, size) => toTestALWorkReadySelection(await selected.claim({ maxCount: size, observedEntries: undefined })),
        claimSuccessor: undefined,
        batchObservations: input.enabled ? input.constructorThrows ? FailedObservationBatch : ALWorkBatchObservations : undefined,
        runClaim: async (_claim, _batchTime, defer) => {
            order.push(defer === undefined ? 'capture-absent' : 'capture-present');
            deferSink = defer;
            defer?.(recordThrowingSink);
            if (input.reentrant) {
                defer?.(recordSecondSink);
            }
            if (input.result instanceof Error) {
                throw input.result;
            }
            return input.result;
        },
        diagnostics: (event) => {
            if (event.kind === 'work-batch') {
                order.push(`batch:${nowMs}`);
            }
        }
    });
    return { handler, order, engine };
}

describe('AL work observation boundary', () => {
    it.each([false, true])('preserves retry classification and release before optional capture enabled=%s', async (enabled) => {
        const fixture = observedHandler({ enabled, result: new Error('carrier failure') });
        try {
            await fixture.handler.ready();
            expect(fixture.order).toEqual(
                enabled
                    ? ['capture-present', 'release:retry:1000', 'batch:1000', 'sink']
                    : ['capture-absent', 'release:retry:1000', 'batch:1000']
            );
        }
        finally {
            fixture.handler.dispose();
            fixture.engine.stop();
        }
    });

    it('continues in insertion order after a throwing sink, including callbacks appended during drain', async () => {
        const fixture = observedHandler({ enabled: true, result: { status: 'completed' }, reentrant: true });
        try {
            await fixture.handler.ready();
            expect(fixture.order).toEqual([
                'capture-present',
                'release:completed:1000',
                'batch:1000',
                'sink',
                'second-sink',
                'reentrant-sink'
            ]);
        }
        finally {
            fixture.handler.dispose();
            fixture.engine.stop();
        }
    });

    it('preserves the original release corruption despite a throwing deferred sink', async () => {
        const original = new ALAdmissionCorruptionError('key', new Error('corruption'));
        const fixture = observedHandler({ enabled: true, result: { status: 'completed' }, releaseError: original });
        try {
            await expect(fixture.handler.ready()).rejects.toBe(original);
            expect(fixture.order).toEqual(['capture-present', 'release:completed:1000', 'sink']);
        }
        finally {
            fixture.handler.dispose();
            fixture.engine.stop();
        }
    });

    it.each([false, true])('loses optional diagnostics on construction failure and preserves release failure=%s', async (releaseFails) => {
        const original = new ALAdmissionCorruptionError('key', new Error('corruption'));
        const fixture = observedHandler({
            enabled: true,
            constructorThrows: true,
            result: new Error('carrier failure'),
            releaseError: releaseFails ? original : undefined
        });
        try {
            if (releaseFails) {
                await expect(fixture.handler.ready()).rejects.toBe(original);
            }
            else {
                await fixture.handler.ready();
            }
            expect(fixture.order).toEqual(
                releaseFails
                    ? ['capture-present', 'release:retry:1000']
                    : ['capture-present', 'release:retry:1000', 'batch:1000']
            );
        }
        finally {
            fixture.handler.dispose();
            fixture.engine.stop();
        }
    });

    it('does not wait for a retained claim or claim its release from batch observation', async () => {
        let complete: ((result: { status: 'completed'; }) => void) | undefined;
        function captureRetainedCompletion(resolve: (result: { status: 'completed'; }) => void): void {
            complete = resolve;
        }
        const settled = new Promise<{ status: 'completed'; }>(captureRetainedCompletion);
        const fixture = observedHandler({ enabled: true, result: { status: 'retained', settled } });
        try {
            await fixture.handler.ready();
            expect(fixture.order).toEqual(['capture-present', 'batch:1000', 'sink']);
            complete?.({ status: 'completed' });
            await settled;
            await Promise.resolve();
            expect(fixture.order).toContain('release:completed:99000');
        }
        finally {
            fixture.handler.dispose();
            fixture.engine.stop();
        }
    });
});

class FailedObservationBatch extends ALWorkBatchObservations {
    constructor() {
        super();
        throw new Error('batch observation construction');
    }
}
