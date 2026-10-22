import { describe, expect, it } from 'vitest';

import { RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES } from '@shared-test/rallar-bb-test/control-protocol.ts';
import {
    canonicalControlRetentionJson,
    CONTROL_RETENTION_PLAN_LIMITS,
    ControlRetentionPlanLimitError
} from '@shared-test/rallar-bb-test/control-retention-canonical.ts';
import {
    computeResultCaptureReceipt,
    RESULT_CAPTURE_LIMITS,
    toCanonicalResultCaptureJson
} from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

const identity = { runId: 'release-run', agentId: 'release-agent' };

describe('explicit durable command result release', () => {
    it('requires exact durable evidence, preserves counts, and never repeats released side effects', async () => {
        let effects = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async () => {
                effects += 1;
                return { status: 'ok', value: { large: 'payload'.repeat(100) } };
            }
        });
        const result = await runtime.execute({ kind: 'health', commandId: 'once' }, identity);
        const receipt = await computeResultCaptureReceipt(result, identity);
        expect(receipt).toBeDefined();
        const request = { ...identity, requestId: 'release-1', receipts: [receipt!] };
        expect((await runtime.releaseResults({ ...request, receipts: [{ ...receipt!, digest: 'wrong' }] })).status)
            .toBe('rejected');
        expect(runtime.state().commandHistory).toHaveLength(1);
        expect((await runtime.releaseResults(request)).status).toBe('released');
        expect(runtime.state().commandHistory).toEqual([]);
        expect(runtime.state().resultCache).toEqual({});
        expect(runtime.state().failures).toEqual([]);
        expect(JSON.stringify(runtime.state())).not.toContain('payloadpayload');
        expect(runtime.state().resultHistory.totalCommands).toBe(1);
        expect(runtime.state().resultHistory.releasedResults).toBe(1);
        expect((await runtime.releaseResults(request)).status).toBe('released');
        const replay = await runtime.execute({ kind: 'health', commandId: 'once' }, identity);
        expect(replay.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
        expect(effects).toBe(1);
    });

    it('protects active execution and rejects receipts from an old assignment or reset', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const result = await runtime.execute({ kind: 'health', commandId: 'old' }, identity);
        const receipt = (await computeResultCaptureReceipt(result, identity))!;
        await runtime.execute({ kind: 'health', commandId: 'current' }, { ...identity, runId: 'next' });
        expect((await runtime.releaseResults({ ...identity, requestId: 'stale', receipts: [receipt] })).status)
            .toBe('rejected');
        expect(runtime.state().resultCache.current).toBeDefined();
    });
});

it('releases nested loop results together and keeps full payloads bounded over a long sequence', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 10 } });
    for (let index = 0; index < 60; index += 1) {
        const result = await runtime.execute({
            kind: 'loop',
            commandId: `loop-${index}`,
            count: 2,
            commands: [{ kind: 'health', commandId: 'child' }]
        }, identity);
        expect(result.ok).toBe(true);
        const retained = runtime.state().commandHistory;
        const receipts = await Promise.all(retained.map((entry) => computeResultCaptureReceipt(entry, identity)));
        const released = await runtime.releaseResults({ ...identity, requestId: `r-${index}`, receipts: receipts.filter((receipt) => receipt !== undefined) });
        expect(released.status).toBe('released');
        expect(runtime.state().commandHistory).toHaveLength(0);
        expect(Object.keys(runtime.state().resultCache)).toHaveLength(0);
    }
    expect(runtime.state().resultHistory.totalCommands).toBe(180);
    expect(runtime.state().resultHistory.load?.loopCount).toBe(60);
    expect(runtime.state().resultHistory.releasedResults).toBe(180);
});

it('scope separates reused roots and a lookalike application payload is preserved', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    await runtime.execute({ kind: 'health', commandId: 'same-root' }, { ...identity, runId: 'old-run' });
    const current = await runtime.execute({ kind: 'health', commandId: 'same-root' }, identity);
    const lookalike = { commandId: current.commandId, ok: true, capture: current.capture, applicationValue: 'native-event' };
    runtime.recordEvent({ kind: 'message', topic: 'app.native', payload: lookalike });
    const receipt = (await computeResultCaptureReceipt(current, identity))!;
    expect((await runtime.releaseResults({ ...identity, requestId: 'reused', receipts: [receipt] })).status).toBe('released');
    expect(runtime.state().events.find((event) => event.topic === 'app.native')?.payload).toEqual(lookalike);
});

it('rejects a forged command identity and contradictory duplicate receipts', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute({ kind: 'health', commandId: 'original' }, identity);
    const receipt = (await computeResultCaptureReceipt(result, identity))!;
    const request = { ...identity, requestId: 'forged', receipts: [{ ...receipt, commandId: 'other' }] };
    expect((await runtime.releaseResults(request)).status).toBe('rejected');
    expect((await runtime.releaseResults({ ...request, receipts: [receipt, { ...receipt, commandId: 'other' }] })).status).toBe('rejected');
    expect(runtime.state().resultCache.original).toBeDefined();
});

it('preserves telemetry appended during receipt verification and cumulative failure/latency statistics', async () => {
    let now = 10;
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: () => now++,
        commandExecutor: async () => ({ status: 'failed', error: { code: 'EXPECTED', message: 'Failure evidence' } })
    });
    const result = await runtime.execute({ kind: 'health', commandId: 'failed' }, identity);
    const receipt = (await computeResultCaptureReceipt(result, identity))!;
    const releasing = runtime.releaseResults({ ...identity, requestId: 'interleaved', receipts: [receipt] });
    runtime.recordEvent({ kind: 'message', topic: 'native-rtc', payload: { native: 'preserved' } });
    expect((await releasing).status).toBe('released');
    expect(runtime.state().events.at(-1)?.topic).toBe('native-rtc');
    expect(runtime.state().resultHistory.totalFailures).toBe(1);
    expect(runtime.state().resultHistory.durationSumMs).toBe(result.durationMs);
    expect(runtime.state().failures).toHaveLength(0);
});

it('defers active work and owned recipe leases, rejects reset receipts, and fails released references explicitly', async () => {
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: async (command) => {
            if (command.commandId === 'held') {
                entered.resolve();
                await held.promise;
            }
            return undefined;
        }
    });
    const first = await runtime.execute({ kind: 'health', commandId: 'first' }, identity);
    const receipt = (await computeResultCaptureReceipt(first, identity))!;
    const request = { ...identity, requestId: 'active', receipts: [receipt] };
    const executing = runtime.execute({ kind: 'health', commandId: 'held' }, identity);
    await entered.promise;
    expect((await runtime.releaseResults(request)).status).toBe('deferred');
    held.resolve();
    await executing;
    await runtime.execute(
        {
            kind: 'recipe.run',
            commandId: 'segment',
            recipe: { schemaVersion: 1, recipeId: 'leased', commands: [{ kind: 'health', commandId: 'lease-child' }] }
        },
        identity,
        {
            recipeExecution: { rootCommandId: 'leased', first: true, last: false, segment: { start: 0, end: 1, first: true } }
        }
    );
    expect((await runtime.releaseResults(request)).status).toBe('deferred');
    runtime.releaseRecipeExecution('leased', identity);
    expect((await runtime.releaseResults(request)).status).toBe('released');
    const reference = await runtime.execute({ kind: 'assert', commandId: 'reference', source: 'resultCache.first.value', operator: 'exists' }, identity);
    expect(reference.ok).toBe(false);
    expect(reference.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
    const absent = await runtime.execute(
        { kind: 'assert', commandId: 'absent', source: 'state.resultCache.first.value', operator: 'exists', expected: false },
        identity
    );
    expect(absent.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
    const wait = await runtime.execute({ kind: 'wait', commandId: 'wait-released', match: { contains: '{resultCache.first.value}' } }, identity);
    expect(wait.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
    await runtime.execute({ kind: 'reset', commandId: 'reset' }, identity);
    expect((await runtime.releaseResults(request)).status).toBe('rejected');
});

it('rejects digest budget failures explicitly and retains original payloads', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: () => ({ status: 'ok', value: 'x'.repeat(RESULT_CAPTURE_LIMITS.stringCharacters + 1) })
    });
    const result = await runtime.execute({ kind: 'health', commandId: 'large' }, identity);
    const release = await runtime.releaseResults({
        ...identity,
        requestId: 'large',
        receipts: [{ ...identity, commandId: result.commandId, capture: result.capture!, digest: 'unverifiable' }]
    });
    expect(release.status).toBe('rejected');
    expect(release.reason).toBe('The exact full result cannot be certified within the capture digest bounds.');
    expect(runtime.state().resultCache.large).toBe(result);
});

it('bounds result capture by the admitted control frame, not by the retention plan', async () => {
    expect(RESULT_CAPTURE_LIMITS).toEqual({
        canonicalDepth: 64,
        canonicalNodes: RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES / 2,
        stringCharacters: RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES,
        canonicalUtf8Bytes: RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES
    });
    const aboveRetention = { samples: new Array(CONTROL_RETENTION_PLAN_LIMITS.canonicalNodes).fill(0) };
    expect(() => canonicalControlRetentionJson(aboveRetention)).toThrow(ControlRetentionPlanLimitError);
    expect(toCanonicalResultCaptureJson(aboveRetention)).toBe(JSON.stringify(aboveRetention));

    const aboveCapture = new Array(RESULT_CAPTURE_LIMITS.canonicalNodes).fill(0);
    expect(() => toCanonicalResultCaptureJson(aboveCapture)).toThrow(
        expect.objectContaining({
            name: 'ResultCaptureLimitError',
            limit: 'canonicalNodes',
            maximum: RESULT_CAPTURE_LIMITS.canonicalNodes
        })
    );
});

it('history aliases cannot fabricate assertions after releasing the latest result', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    await runtime.execute({ kind: 'health', commandId: 'older' }, identity);
    const latest = await runtime.execute({ kind: 'health', commandId: 'latest' }, identity);
    const receipt = (await computeResultCaptureReceipt(latest, identity))!;
    await runtime.releaseResults({ ...identity, requestId: 'latest', receipts: [receipt] });
    for (const source of ['lastResult.value', 'state.commandHistory.length', 'state.results.0', 'failures.length']) {
        const result = await runtime.execute({ kind: 'assert', source, operator: 'notEquals', expected: 'absent' }, identity);
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
    }
});

it('preserves protected native events that own an exact captured result and refuses incomplete release', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute({ kind: 'health', commandId: 'native-owner' }, identity);
    runtime.recordEvent({ kind: 'message', topic: 'app.native', payload: result });
    const receipt = (await computeResultCaptureReceipt(result, identity))!;
    const before = runtime.state().events;
    expect((await runtime.releaseResults({ ...identity, requestId: 'protected', receipts: [receipt] })).status).toBe('rejected');
    expect(runtime.state().events).toBe(before);
    expect(runtime.state().events.at(-1)?.payload).toEqual(result);
    expect(runtime.state().resultCache['native-owner']).toBe(result);
});

it.each([
    'events.0.payload.value',
    'recentEvents.0.payload.value',
    'state.events.0.payload.value',
    ' events..payload.00.payload.value ',
    'events.$.0.payload.value'
])('refuses released payload absence through %s after acknowledged capture', async (source) => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const captured = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
    expect(captured.value).toBeDefined();
    const before = await runtime.execute({ kind: 'assert', source, operator: 'exists', expected: false }, identity);
    expect(before.error?.code).toBe('RALLAR_BLACK_BOX_ASSERT_FAILED');
    const receipt = (await computeResultCaptureReceipt(captured, identity))!;
    expect((await runtime.releaseResults({ ...identity, requestId: 'event-alias', receipts: [receipt] })).status).toBe('released');

    const after = await runtime.execute({ kind: 'assert', source, operator: 'exists', expected: false }, identity);
    expect(after.ok).toBe(false);
    expect(after.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
});

it.each(['events', 'recentEvents', 'state.events'])(
    'refuses released %s comparison payloads while preserving marker metadata and application events',
    async (root) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: (command) => command.kind === 'health' ? { status: 'ok', value: ['one'] } : undefined
        });
        const captured = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
        runtime.recordEvent({
            kind: 'message',
            topic: 'application',
            payload: {
                values: ['one'],
                resultUnavailable: 'released-after-durable-capture',
                commandId: captured.commandId,
                capture: captured.capture,
                applicationValue: 'application'
            }
        });
        const command = {
            kind: 'assert',
            source: `${root}.1.payload.values`,
            operator: 'sameUniqueStringSet',
            comparisonSource: `${root}.0.payload.value`
        } as const;
        expect((await runtime.execute(command, identity)).ok).toBe(true);
        const receipt = (await computeResultCaptureReceipt(captured, identity))!;
        expect((await runtime.releaseResults({ ...identity, requestId: 'comparison', receipts: [receipt] })).status).toBe('released');

        expect((await runtime.execute(command, identity)).error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
        for (
            const [path, expected] of [
                ['0.payload.commandId', 'captured'],
                ['0.payload.capture.ordinal', captured.capture!.ordinal],
                ['0.payload.resultUnavailable', 'released-after-durable-capture'],
                ['1.payload.applicationValue', 'application']
            ] as const
        ) {
            expect((await runtime.execute({ kind: 'assert', source: `${root}.${path}`, operator: 'equals', expected }, identity)).ok).toBe(true);
        }
        expect((await runtime.execute({ kind: 'assert', source: `${root}.0.payload.capture.absent`, operator: 'exists', expected: false }, identity)).ok).toBe(
            true
        );
        expect((await runtime.execute({ kind: 'assert', source: `${root}.1.payload.absent`, operator: 'exists', expected: false }, identity)).ok).toBe(true);
        expect((await runtime.execute({ kind: 'assert', source: `${root}.0.payload`, operator: 'exists' }, identity)).ok).toBe(true);
        expect(runtime.state().events[0].payload).toEqual({
            resultUnavailable: 'released-after-durable-capture',
            commandId: 'captured',
            capture: captured.capture
        });
    }
);

it('resolves released recentEvents payloads in the twenty-event view rather than the complete event history', async () => {
    for (const released of [false, true]) {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        for (let index = 0; index < 22; index += 1) {
            runtime.recordEvent({ kind: 'message', topic: 'application', payload: { index } });
        }
        const captured = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
        if (released) {
            const receipt = (await computeResultCaptureReceipt(captured, identity))!;
            expect((await runtime.releaseResults({ ...identity, requestId: 'recent-window', receipts: [receipt] })).status).toBe('released');
        }
        const assertion = await runtime.execute({ kind: 'assert', source: 'recentEvents.19.payload.value', operator: 'exists', expected: false }, identity);
        expect(assertion.error?.code).toBe(released ? 'RALLAR_BLACK_BOX_RESULT_RELEASED' : 'RALLAR_BLACK_BOX_ASSERT_FAILED');
    }
});

it.each(['events', 'recentEvents', 'state.events'])(
    'keeps owned %s release markers unavailable across assignments without preserving replay tombstones',
    async (root) => {
        let effects = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: (command) => command.kind === 'health' ? { status: 'ok', value: ['one', String(++effects)] } : undefined
        });
        const captured = await runtime.execute({ kind: 'health', commandId: 'reused' }, identity);
        const source = `${root}.0.payload.value`;
        expect((await runtime.execute({ kind: 'assert', source, operator: 'exists', expected: false }, identity)).error?.code).toBe(
            'RALLAR_BLACK_BOX_ASSERT_FAILED'
        );
        const receipt = (await computeResultCaptureReceipt(captured, identity))!;
        expect((await runtime.releaseResults({ ...identity, requestId: 'before-reassignment', receipts: [receipt] })).status).toBe('released');
        const marker = structuredClone(runtime.state().events[0].payload);
        runtime.recordEvent({ kind: 'message', topic: 'application', payload: marker });
        runtime.recordEvent({ kind: 'result', topic: 'rallar.bb.command.result', commandId: 'reused', payload: marker });
        const nextIdentity = { ...identity, runId: 'next-assignment' };

        const after = await runtime.execute({ kind: 'assert', source, operator: 'exists', expected: false }, nextIdentity);
        expect(after.ok).toBe(false);
        expect(after.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
        const comparison = await runtime.execute({
            kind: 'assert',
            source: `${root}.0.payload.commandId`,
            operator: 'sameUniqueStringSet',
            comparisonSource: source
        }, nextIdentity);
        expect(comparison.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
        for (const index of [2, 3]) {
            expect((await runtime.execute({ kind: 'assert', source: `${root}.${index}.payload.value`, operator: 'exists', expected: false }, nextIdentity)).ok)
                .toBe(true);
        }
        expect(
            (await runtime.execute({
                kind: 'assert',
                source: `${root}.0.payload.capture.assignment`,
                operator: 'equals',
                expected: captured.capture!.assignment
            }, nextIdentity)).ok
        ).toBe(true);
        const replacement = await runtime.execute({ kind: 'health', commandId: 'reused' }, nextIdentity);
        expect(replacement.ok).toBe(true);
        expect(replacement.value).toEqual(['one', '2']);
        expect(effects).toBe(2);
        expect((await runtime.execute({ kind: 'assert', source, operator: 'exists', expected: false }, nextIdentity)).error?.code).toBe(
            'RALLAR_BLACK_BOX_RESULT_RELEASED'
        );
    }
);

it.each([
    'resultCache.$.captured.value',
    'resultCache.payload.captured.value',
    'resultCache.$.payload.captured.value',
    'state.$.resultCache.captured.value',
    'state.payload.resultCache.captured.value',
    'state.$.payload.resultCache.captured.value',
    'state.$.commandHistory.length',
    'state.payload.results.length',
    'state.$.failures.length'
])('uses canonical source grammar for released %s values', async (source) => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const captured = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
    expect((await runtime.execute({ kind: 'assert', source, operator: 'exists', expected: false }, identity)).error?.code).toBe(
        'RALLAR_BLACK_BOX_ASSERT_FAILED'
    );
    const receipt = (await computeResultCaptureReceipt(captured, identity))!;
    expect((await runtime.releaseResults({ ...identity, requestId: 'prefixed', receipts: [receipt] })).status).toBe('released');
    expect((await runtime.execute({ kind: 'assert', source, operator: 'exists', expected: false }, identity)).error?.code).toBe(
        'RALLAR_BLACK_BOX_RESULT_RELEASED'
    );
});

it.each(['resultCache.$.captured.value', 'resultCache.payload.captured.value', 'state.$.resultCache.captured.value'])(
    'protects a canonical comparison reference %s after release',
    async (comparisonSource) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: (command) => command.kind === 'health' ? { status: 'ok', value: ['one'] } : undefined
        });
        const captured = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
        runtime.recordEvent({ kind: 'message', topic: 'application', payload: { values: ['one'] } });
        const command = { kind: 'assert', source: 'events.1.payload.values', operator: 'sameUniqueStringSet', comparisonSource } as const;
        expect((await runtime.execute(command, identity)).ok).toBe(true);
        const receipt = (await computeResultCaptureReceipt(captured, identity))!;
        expect((await runtime.releaseResults({ ...identity, requestId: 'comparison-prefix', receipts: [receipt] })).status).toBe('released');
        expect((await runtime.execute(command, identity)).error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
    }
);

it.each([
    { payloadPath: 'value', exists: true },
    { payloadPath: '$.payload.value', exists: false },
    { payloadPath: 'value.answer', equals: 'kept' },
    { payloadPath: 'value.answer', contains: 'ke' },
    { payloadFields: { 'value.answer': 'kept' } },
    { contains: 'kept' }
])('does not substitute released evidence for wait payload query %j', async (query) => {
    for (const absent of [false, true]) {
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: (command) => command.kind === 'health' ? { status: 'ok', value: { answer: 'kept' } } : undefined
        });
        const captured = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
        const receipt = (await computeResultCaptureReceipt(captured, identity))!;
        expect((await runtime.releaseResults({ ...identity, requestId: 'wait-payload', receipts: [receipt] })).status).toBe('released');
        const waited = await runtime.execute({
            kind: 'wait',
            commandId: 'query',
            timeoutMs: 0,
            ...(absent ? { absent: true } : {}),
            match: { kind: 'result', commandId: 'captured', ...query }
        }, identity);
        expect(waited.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
    }
});

it('preserves event presence, release metadata, actual application matches and routing/window exclusions', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: (command) => command.kind === 'health' ? { status: 'ok', value: { answer: 'kept' } } : undefined
    });
    const captured = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
    const capturedAt = runtime.state().events[0].atEpochMs;
    const receipt = (await computeResultCaptureReceipt(captured, identity))!;
    expect((await runtime.releaseResults({ ...identity, requestId: 'wait-metadata', receipts: [receipt] })).status).toBe('released');
    for (
        const query of [
            {},
            { payloadPath: 'capture.ordinal', equals: captured.capture!.ordinal },
            { payloadFields: { resultUnavailable: 'released-after-durable-capture' } },
            { payloadPath: 'resultUnavailable', contains: 'durable-capture' },
            { payloadPath: 'capture.absent', exists: false }
        ]
    ) {
        expect((await runtime.execute({ kind: 'wait', timeoutMs: 0, match: { kind: 'result', commandId: 'captured', ...query } }, identity)).ok).toBe(true);
    }
    runtime.recordEvent({ kind: 'message', topic: 'application', payload: { value: 'known' } });
    expect((await runtime.execute({ kind: 'wait', timeoutMs: 0, match: { payloadPath: 'value', equals: 'known' } }, identity)).ok).toBe(true);
    const marker = runtime.state().events[0].payload;
    runtime.recordEvent({ kind: 'result', topic: 'rallar.bb.command.result', commandId: 'application', payload: marker });
    expect(
        (await runtime.execute(
            { kind: 'wait', timeoutMs: 0, match: { kind: 'result', commandId: 'application', payloadPath: 'value', exists: false } },
            identity
        )).ok
    ).toBe(true);
    for (
        const match of [
            { kind: 'message' as const, commandId: 'captured' },
            { topic: 'application' },
            { connection: 'other' },
            { transport: 'messages.rtc' as const },
            { severity: 'error' as const },
            { kind: 'result' as const, commandId: 'other' },
            { kind: 'result' as const, commandId: 'captured', sinceEpochMs: capturedAt + 1 }
        ]
    ) {
        expect(
            (await runtime.execute({
                kind: 'wait',
                timeoutMs: 0,
                absent: true,
                match: { commandId: 'captured', ...match, payloadPath: 'value', exists: true }
            }, identity)).ok
        )
            .toBe(true);
    }
    expect((await runtime.execute({ kind: 'wait', timeoutMs: 0, absent: true, match: { payloadPath: 'value.answer', exists: true } }, identity)).error?.code)
        .toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
});

it('defers release while a wait owns a future event window and admits release only after it settles', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const captured = await runtime.execute({ kind: 'health', commandId: 'captured' }, identity);
    const receipt = (await computeResultCaptureReceipt(captured, identity))!;
    const request = { ...identity, requestId: 'pending-wait', receipts: [receipt] };
    const pending = runtime.execute({
        kind: 'wait',
        commandId: 'future',
        timeoutMs: 1_000,
        match: { kind: 'message', topic: 'future', payloadPath: 'value', equals: 'known' }
    }, identity);
    expect((await runtime.releaseResults(request)).status).toBe('deferred');
    expect(runtime.state().resultCache.captured).toBe(captured);
    runtime.recordEvent({ kind: 'message', topic: 'future', payload: { value: 'known' } });
    expect((await pending).ok).toBe(true);
    expect((await runtime.releaseResults(request)).status).toBe('released');
    const after = await runtime.execute({
        kind: 'wait',
        timeoutMs: 0,
        match: { kind: 'result', commandId: 'captured', payloadPath: 'value', exists: false }
    }, identity);
    expect(after.error?.code).toBe('RALLAR_BLACK_BOX_RESULT_RELEASED');
});
