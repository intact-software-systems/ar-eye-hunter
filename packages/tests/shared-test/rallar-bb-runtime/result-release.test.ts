import { describe, expect, it } from 'vitest';

import { computeResultCaptureReceipt } from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
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
    const runtime = createDefaultRallarBlackBoxTestRuntime({ commandExecutor: () => ({ status: 'ok', value: 'x'.repeat(1_048_577) }) });
    const result = await runtime.execute({ kind: 'health', commandId: 'large' }, identity);
    const release = await runtime.releaseResults({
        ...identity,
        requestId: 'large',
        receipts: [{ ...identity, commandId: result.commandId, capture: result.capture!, digest: 'unverifiable' }]
    });
    expect(release.status).toBe('rejected');
    expect(runtime.state().resultCache.large).toBe(result);
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
