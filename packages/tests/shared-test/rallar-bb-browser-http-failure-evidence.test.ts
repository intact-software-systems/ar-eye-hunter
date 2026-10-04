import { spawnSync } from 'node:child_process';

import { afterEach, expect, it, vi } from 'vitest';

import { controlEventArtifactJsonl } from '../../../apps/rallar-black-box-control-server/src/control-artifacts.ts';
import { toLiveRtcLifecycleHistory } from '../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { createBrowserCommandAbortScope } from '../../shared-test/rallar-bb-test/browser/browser-command-cancellation.ts';
import type { BrowserCommandEnvironment } from '../../shared-test/rallar-bb-test/browser/browser-command-environment.ts';
import { BrowserHttpRequests } from '../../shared-test/rallar-bb-test/browser/browser-http-requests.ts';
import { toControlEventEnvelope } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestRuntimeEventInput
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

const command = {
    kind: 'http.request',
    commandId: 'failed-request',
    request: { url: 'https://example.test/private-path' },
    response: { body: 'json' }
} as const;

afterEach(() => vi.useRealTimers());

it.each(['fetch', 'body'] as const)('retains the reached %s phase without attributing an AbortError to the scope', async (phase) => {
    const failure = new Error('private-error-sentinel');
    failure.name = 'AbortError';
    const runtime = createRallarBlackBoxBrowserTestRuntime({
        now: () => 120,
        fetch: async () => {
            if (phase === 'fetch') {
                throw failure;
            }
            return new Response(new ReadableStream({ start: (stream) => stream.error(failure) }));
        }
    });

    const result = await runtime.execute(command);
    expect(result).toMatchObject({ ok: false, error: { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', details: { name: 'AbortError' } } });
    const event = runtime.state().events.find((event) => event.topic === 'rallar.bb.http.failure');
    expect(event).toMatchObject({ payload: { data: { kind: 'http-request-failed', phase, scopeAborted: false, scopeAbortOrigin: null } } });
    if (!event) {
        throw new Error('Expected the HTTP failure observation.');
    }
    expect(JSON.stringify(event)).not.toContain('private-');
    expect(JSON.stringify(event)).not.toContain('https:');
    const jsonl = controlEventArtifactJsonl(toControlEventEnvelope(event, 'run', 'agent-a'));
    const retained = toLiveRtcLifecycleHistory({
        jsonl,
        bytesRead: Buffer.byteLength(jsonl),
        retainedBytes: Buffer.byteLength(jsonl),
        retainedPrefixDropped: false,
        transportTruncated: false,
        failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' },
        agentIds: ['agent-a'],
        cycle: null
    });
    expect(retained['agent-a']).toMatchObject({
        events: [{ commandId: 'failed-request', kind: 'http-request-failed', phase, scopeAborted: false, scopeAbortOrigin: null }]
    });
    expect(JSON.stringify(retained)).not.toContain('private-');
    expect(JSON.stringify(retained)).not.toContain('https:');
});

it.each(['fetch', 'body'] as const)('observes its actual timeout while awaiting %s without changing the budget', async (phase) => {
    vi.useFakeTimers();
    let reachedFetch = false;
    const runtime = createRallarBlackBoxBrowserTestRuntime({
        fetch: async (_url, request) => {
            reachedFetch = true;
            const signal = request?.signal;
            if (!signal) {
                throw new Error('Expected the owned request signal.');
            }
            if (phase === 'fetch') {
                return await new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            }
            return new Response(
                new ReadableStream({
                    start: (stream) => signal.addEventListener('abort', () => stream.error(signal.reason), { once: true })
                })
            );
        }
    });
    const pending = runtime.execute({ ...command, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(49);
    expect(reachedFetch).toBe(true);
    expect(runtime.state().commandHistory).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, error: { details: { name: 'RALLAR_BLACK_BOX_TIMEOUT' } } });
    expect(runtime.state().events).toContainEqual(expect.objectContaining({
        topic: 'rallar.bb.http.failure',
        payload: expect.objectContaining({
            data: { kind: 'http-request-failed', commandId: 'failed-request', phase, scopeAborted: true, scopeAbortOrigin: 'timeout' }
        })
    }));
    expect(vi.getTimerCount()).toBe(0);
});

it('retains actual parent cancellation through the public runtime', async () => {
    const began = Promise.withResolvers<void>();
    const runtime = createRallarBlackBoxBrowserTestRuntime({
        fetch: async (_url, request) => {
            const signal = request?.signal;
            if (!signal) {
                throw new Error('Expected the runtime cancellation signal.');
            }
            began.resolve();
            return await new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
    });
    const pending = runtime.execute(command);
    await began.promise;
    await runtime.execute({ kind: 'recipe.cancel', commandId: 'cancel', reason: 'private-cancel-sentinel' });
    expect(await pending).toMatchObject({ ok: false });
    expect(runtime.state().events).toContainEqual(expect.objectContaining({
        topic: 'rallar.bb.http.failure',
        payload: expect.objectContaining({
            data: { kind: 'http-request-failed', commandId: 'failed-request', phase: 'fetch', scopeAborted: true, scopeAbortOrigin: 'parent' }
        })
    }));
});

it.each(['sink', 'clock'] as const)('rethrows the original failure when the supplemental %s fails', async (failedPort) => {
    const failure = new Error('primary failure');
    const environment: BrowserCommandEnvironment = {
        ...createEnvironment(async () => {
            throw failure;
        }),
        now: () => {
            if (failedPort === 'clock') {
                throw new Error('clock failed');
            }
            return 120;
        }
    };
    const context = createContext();
    if (failedPort === 'sink') {
        context.recordEvent = () => {
            throw new Error('sink failed');
        };
    }
    await expect(new BrowserHttpRequests(environment).httpRequest(command, context)).rejects.toBe(failure);
});

it.each(['timeout', 'parent'] as const)('keeps the first winning %s abort and cleans up forwarding', async (first) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const parentReason = new Error('AbortError is not an origin');
    const scope = createBrowserCommandAbortScope({ ...command, timeoutMs: 50 }, {
        ...createContext(),
        abortSignal: () => parent.signal
    }, () => 0);
    if (first === 'parent') {
        parent.abort(parentReason);
    }
    await vi.advanceTimersByTimeAsync(50);
    parent.abort(parentReason);
    expect(scope.origin).toBe(first);
    if (first === 'parent') {
        expect(scope.signal?.reason).toBe(parentReason);
    }
    expect(scope.signal?.reason.name).toBe(first === 'parent' ? 'Error' : 'RALLAR_BLACK_BOX_TIMEOUT');
    scope.cleanup();
    expect(vi.getTimerCount()).toBe(0);

    const laterParent = new AbortController();
    const cleaned = createBrowserCommandAbortScope({ ...command, timeoutMs: 50 }, {
        ...createContext(),
        abortSignal: () => laterParent.signal
    }, () => 0);
    cleaned.cleanup();
    laterParent.abort('private-late-reason');
    await vi.advanceTimersByTimeAsync(50);
    expect(cleaned.signal?.aborted).toBe(false);
    expect(cleaned.origin).toBeUndefined();
});

it('preserves timeout precedence, an already aborted parent, and absent abort ownership', async () => {
    vi.useFakeTimers();
    const noScope = createBrowserCommandAbortScope(command, createContext(), () => 120);
    expect(noScope.signal).toBeUndefined();
    expect(noScope.origin).toBeUndefined();
    noScope.cleanup();
    const parent = new AbortController();
    parent.abort('private-parent-reason');
    const already = createBrowserCommandAbortScope({ ...command, timeoutMs: 0 }, {
        ...createContext(),
        abortSignal: () => parent.signal
    }, () => 120);
    await vi.advanceTimersByTimeAsync(0);
    expect(already.origin).toBe('parent');
    expect(already.signal?.reason).toBe('private-parent-reason');
    already.cleanup();
    const scope = createBrowserCommandAbortScope({ ...command, timeoutMs: 50, deadlineEpochMs: 121 }, createContext(), () => 120);
    await vi.advanceTimersByTimeAsync(49);
    expect(scope.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(scope.origin).toBe('timeout');
    scope.cleanup();
    const expired = createBrowserCommandAbortScope({ ...command, deadlineEpochMs: 119 }, createContext(), () => 120);
    await vi.advanceTimersByTimeAsync(0);
    expect(expired.origin).toBe('timeout');
    expired.cleanup();
});

it.each(['none', 'text', 'json'] as const)('preserves successful %s body handling without producing failure evidence', async (body) => {
    vi.useFakeTimers();
    const runtime = createRallarBlackBoxBrowserTestRuntime({ fetch: async () => new Response('{"value":1}') });
    const result = await runtime.execute({ ...command, timeoutMs: 50, response: { body, maxBodyChars: 3 } });
    expect(result.ok).toBe(true);
    expect(runtime.state().events.some((event) => event.topic === 'rallar.bb.http.failure')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const response = runtime.state().events.find((event) => event.topic === 'rallar.bb.http.response');
    expect(response?.payload).toMatchObject(body === 'none' ? {} : { body: body === 'json' ? { value: 1 } : '{"v' });
});

it('keeps rejected HTTP status outcomes and request preparation failures outside the caught-failure evidence', async () => {
    const runtime = createRallarBlackBoxBrowserTestRuntime({ fetch: async () => new Response('{}', { status: 403 }) });
    expect(await runtime.execute({ ...command, response: { body: 'json', acceptedStatusCodes: [200] } })).toMatchObject({
        ok: false,
        error: { code: 'RALLAR_BLACK_BOX_HTTP_STATUS_NOT_ACCEPTED' }
    });
    expect(await runtime.execute({ ...command, commandId: 'unprepared', request: { path: '/missing-config' } })).toMatchObject({ ok: false });
    expect(runtime.state().events.some((event) => event.topic === 'rallar.bb.http.failure')).toBe(false);
});

it('records response-phase failure without replacing the response recorder error', async () => {
    const failure = new Error('response recorder failed');
    const observations: RallarBlackBoxTestRuntimeEventInput[] = [];
    const context = createContext();
    context.recordEvent = (event) => {
        if (event.topic === 'rallar.bb.http.response') {
            throw failure;
        }
        observations.push(event);
    };
    await expect(new BrowserHttpRequests(createEnvironment(async () => new Response('{}'))).httpRequest(command, context)).rejects.toBe(failure);
    expect(observations).toMatchObject([{ payload: { data: { phase: 'response', scopeAborted: false, scopeAbortOrigin: null } } }]);
});

it.each(['before', 'after'] as const)('observes a losing operation rejected %s already-aborted cancellation without delaying its reason', (rejectionTiming) => {
    // Isolate Node's real unhandled-rejection event from the test runner's own rejection listener.
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
        encoding: 'utf8',
        timeout: 5_000,
        input: `
            import { setImmediate } from 'node:timers/promises';
            import { withBrowserCommandAbort } from './packages/shared-test/rallar-bb-test/browser/browser-command-cancellation.ts';
            const controller = new AbortController();
            const cancellation = new Error('primary cancellation');
            controller.abort(cancellation);
            const operation = Promise.withResolvers();
            const operationFailure = new Error('losing operation');
            let unhandledOperationRejections = 0;
            const recordUnhandled = () => { unhandledOperationRejections += 1; };
            process.on('unhandledRejection', recordUnhandled);
            try {
                if (${rejectionTiming === 'before'}) operation.reject(operationFailure);
                let primaryFailure;
                void withBrowserCommandAbort(operation.promise, controller.signal).catch((error) => { primaryFailure = error; });
                await Promise.resolve();
                await Promise.resolve();
                const primaryCancellationPreservedBeforeRelease = primaryFailure === cancellation;
                if (${rejectionTiming === 'after'}) operation.reject(operationFailure);
                await setImmediate();
                console.log(JSON.stringify({ primaryCancellationPreservedBeforeRelease, unhandledOperationRejections }));
            }
            finally {
                process.off('unhandledRejection', recordUnhandled);
            }
        `
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
        primaryCancellationPreservedBeforeRelease: true,
        unhandledOperationRejections: 0
    });
});

function createContext(): RallarBlackBoxTestCommandContext {
    const runtime = createRallarBlackBoxBrowserTestRuntime();
    return {
        state: () => runtime.state(),
        config: () => undefined,
        recordEvent: () => {},
        updateStats: () => {
            throw new Error('unused');
        }
    };
}

function createEnvironment(fetch: typeof globalThis.fetch): BrowserCommandEnvironment {
    return {
        rallarRuntime: undefined,
        fetch,
        webSocketFactory: undefined,
        defaultWsOpenTimeoutMs: 50,
        defaultHttpBodyLimit: 100,
        now: () => 120,
        readSession: () => undefined,
        requestId: () => 'unused'
    };
}
