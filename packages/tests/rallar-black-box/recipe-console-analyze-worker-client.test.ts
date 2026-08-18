import { describe, expect, it, vi } from 'vitest';
import {
    type AnalyzeWorkerResponse,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-contract.ts';
import {
    createAnalyzeWorkerClient,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-client.ts';
import {
    createAnalyzeExportBlobRetention,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-export-blob.ts';
import {
    createAnalyzeWorkerFactory,
    type AnalyzeWorkerPort,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-factory.ts';
import type {
    AnalyzeEvidenceWindowProjection,
} from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-projection-contract.ts';
import {
    ANALYZE_WORKER_PERFORMANCE_NAMES,
    recordAnalyzeWorkerPerformance,
    type AnalyzeWorkerPerformancePort,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-performance.ts';
import { createAnalyzeControlIdentityDigest } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-control-identity-digest.ts';
import {
    ANALYZE_WORKER_MAX_LABEL_BYTES,
    ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-request-boundary.ts';

describe('Recipe Console Analyze worker client boundaries', () => {
    it('orders accepted, pending paint/start, and complete while transferring bytes once', async () => {
        const worker = new FakeWorkerPort();
        const frames: FrameRequestCallback[] = [];
        const order: string[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker: () => worker,
            requestAnimationFrame: callback => {
                frames.push(callback);
                return frames.length;
            },
            callbacks: {
                onAccepted: () => order.push('accepted'),
                onPendingPaint: () => order.push('pending-painted'),
                onComplete: () => order.push('complete'),
            },
        });
        const bytes = new TextEncoder().encode('{}').buffer as ArrayBuffer;

        const generation = client.offer({
            source: 'local-files', label: 'artifact',
            files: [{ name: 'manifest.json', bytes }],
        });
        expect(worker.posts[0]).toEqual({
            message: expect.objectContaining({ type: 'offer', operationGeneration: generation }),
            transfer: [bytes],
        });
        worker.emitMessage({ type: 'accepted', operationGeneration: generation });
        expect(order).toEqual(['accepted']);
        expect(worker.posts).toHaveLength(1);

        frames.shift()?.(0);
        expect(worker.posts).toHaveLength(1);
        expect(order).toEqual(['accepted', 'pending-painted']);
        frames.shift()?.(16);
        expect(order).toEqual(['accepted', 'pending-painted']);
        expect(worker.posts.at(-1)?.message).toEqual({
            type: 'start', operationGeneration: generation,
        });

        worker.emitMessage(completeResponse(generation, 11));
        expect(order).toEqual(['accepted', 'pending-painted', 'complete']);
        expect(await client.currentExport()?.blob.text()).toContain('portable');
        client.dispose();
    });

    it('transfers a raw Control response envelope without cloning file strings', async () => {
        const worker = new FakeWorkerPort();
        const frames: FrameRequestCallback[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker: () => worker,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
        });
        const controlEnvelope = new TextEncoder().encode('{"files":{}}').buffer as ArrayBuffer;

        client.offer({
            source: 'control', label: 'raw control', files: [], controlEnvelope,
            expectedControlIdentity: await createAnalyzeControlIdentityDigest({
                distributedRunId: 'dist',
            }),
        });

        expect(worker.posts[0]?.transfer).toEqual([controlEnvelope]);
        expect(worker.posts[0]?.message).toMatchObject({
            type: 'offer', artifact: { files: [], controlEnvelope },
        });
        client.dispose();
    });

    it('keeps the accepted worker and export when a replacement candidate crashes', async () => {
        const acceptedWorker = new FakeWorkerPort();
        const candidateWorker = new FakeWorkerPort();
        const workers = [acceptedWorker, candidateWorker];
        const frames: FrameRequestCallback[] = [];
        const unavailable: string[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker: () => workers.shift()!,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
            callbacks: {
                onUnavailable: (reason, scope) => unavailable.push(`${scope}:${reason}`),
            },
        });

        const first = client.offer({ source: 'local-files', label: 'first', files: [] });
        acceptedWorker.emitMessage({ type: 'accepted', operationGeneration: first });
        frames.shift()?.(0); frames.shift()?.(16);
        acceptedWorker.emitMessage(completeResponse(first, 1));
        const acceptedExport = client.currentExport();

        client.offer({ source: 'local-files', label: 'replacement', files: [] });
        candidateWorker.emit('error');
        expect(acceptedWorker.terminate).not.toHaveBeenCalled();
        expect(client.currentExport()).toBe(acceptedExport);
        expect(unavailable).toEqual(['candidate:error']);
        client.dispose();
    });

    it('suppresses stale query replies and retains bounded export after accepted crash', () => {
        const worker = new FakeWorkerPort();
        const frames: FrameRequestCallback[] = [];
        const searches: number[] = [];
        const unavailable: string[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker: () => worker,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
            callbacks: {
                onSearchComplete: response => searches.push(response.requestId),
                onUnavailable: (reason, scope) => unavailable.push(`${scope}:${reason}`),
            },
        });
        const operation = client.offer({ source: 'local-files', label: 'artifact', files: [] });
        worker.emitMessage({ type: 'accepted', operationGeneration: operation });
        frames.shift()?.(0); frames.shift()?.(16);
        worker.emitMessage(completeResponse(operation, 4));

        const first = client.search({ query: 'first' });
        const second = client.search({ query: 'second' });
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        worker.emitMessage(searchResponse(first!, 4, 1));
        worker.emitMessage(searchResponse(second!, 4, 2));
        expect(searches).toEqual([second]);

        const retained = client.currentExport();
        worker.emit('messageerror');
        expect(client.currentExport()).toBe(retained);
        expect(unavailable).toEqual(['accepted-worker:messageerror']);
        client.dispose();
    });

    it('suppresses stale window, selection, Tune, and request-failure replies independently', () => {
        const worker = new FakeWorkerPort();
        const frames: FrameRequestCallback[] = [];
        const windows: number[] = [];
        const selections: number[] = [];
        const tunes: number[] = [];
        const failures: string[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker: () => worker,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
            callbacks: {
                onWindowComplete: response => windows.push(response.requestId),
                onSelectionComplete: response => selections.push(response.requestId),
                onTuneComplete: response => tunes.push(response.requestId),
                onFailure: (error, _operationGeneration, request) => failures.push(
                    `${error.stage}:${request?.kind}:${request?.requestId}`,
                ),
            },
        });
        accept(client, worker, frames, 5);

        const searchRequest = client.search({ query: 'bounded' });
        worker.emitMessage(searchResponse(searchRequest!, 5, 1, {
            ...emptyWindow(),
            nextCursor: 'cursor-a',
        }));
        const firstWindow = client.window({ query: { query: 'bounded' }, cursor: 'cursor-a' });
        const secondWindow = client.window({ query: { query: 'bounded' }, cursor: 'cursor-b' });
        worker.emitMessage(windowResponse(firstWindow!, 5, 1, 1));
        worker.emitMessage(windowResponse(secondWindow!, 5, 1, 2));

        const firstSelection = client.select('evidence-a');
        const secondSelection = client.select('evidence-b');
        worker.emitMessage(selectionResponse(firstSelection!, 5, 1));
        worker.emitMessage(selectionResponse(secondSelection!, 5, 2));

        const firstTune = client.tune({ focusRunId: 'dist' });
        const secondTune = client.tune({ focusRunId: 'dist' });
        worker.emitMessage(tuneResponse(firstTune!, 5, 1));
        worker.emitMessage(tuneResponse(secondTune!, 5, 2));

        const staleSearch = client.search({ query: 'stale-error' });
        const currentSearch = client.search({ query: 'current' });
        worker.emitMessage({
            type: 'failed', requestId: staleSearch,
            error: { code: 'invalid-request', stage: 'search', recoverable: true },
        });
        worker.emitMessage(searchResponse(currentSearch!, 5, 3));

        const failedCurrent = client.search({ query: 'current-error' });
        worker.emitMessage({
            type: 'failed', requestId: failedCurrent,
            error: { code: 'invalid-request', stage: 'search', recoverable: true },
        });

        expect(windows).toEqual([secondWindow]);
        expect(selections).toEqual([secondSelection]);
        expect(tunes).toEqual([secondTune]);
        expect(failures).toEqual([`search:search:${failedCurrent}`]);
        client.dispose();
    });

    it('rejects an identity-invalid candidate without replacing the accepted worker or export', async () => {
        const acceptedWorker = new FakeWorkerPort();
        const rejectedWorker = new FakeWorkerPort();
        const workers = [acceptedWorker, rejectedWorker];
        const frames: FrameRequestCallback[] = [];
        const completed: number[] = [];
        const failures: string[] = [];
        let rejectGeneration = -1;
        const client = createAnalyzeWorkerClient({
            createWorker: () => workers.shift()!,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
            validateComplete: response => response.operationGeneration !== rejectGeneration,
            callbacks: {
                onComplete: response => completed.push(response.operationGeneration),
                onFailure: error => failures.push(error.code),
            },
        });
        const acceptedGeneration = accept(client, acceptedWorker, frames, 7);
        const acceptedExport = client.currentExport();

        rejectGeneration = client.offer({
            source: 'control', label: 'wrong identity', files: [],
            controlEnvelope: new TextEncoder().encode('{}').buffer as ArrayBuffer,
            expectedControlIdentity: await createAnalyzeControlIdentityDigest({
                distributedRunId: 'wrong',
            }),
        });
        rejectedWorker.emitMessage({
            type: 'accepted', operationGeneration: rejectGeneration,
        });
        frames.shift()?.(32); frames.shift()?.(48);
        rejectedWorker.emitMessage(completeResponse(rejectGeneration, rejectGeneration));

        expect(completed).toEqual([acceptedGeneration]);
        expect(failures).toEqual(['identity-mismatch']);
        expect(acceptedWorker.terminate).not.toHaveBeenCalled();
        expect(rejectedWorker.terminate).toHaveBeenCalledOnce();
        expect(client.currentExport()).toBe(acceptedExport);
        expect(await client.currentExport()?.blob.text()).toContain('portable');
        client.dispose();
    });

    it('rejects oversized outbound metadata and RPC text without posting or replacing authority', () => {
        const acceptedWorker = new FakeWorkerPort();
        const unexpectedWorker = new FakeWorkerPort();
        const createWorker = vi.fn()
            .mockReturnValueOnce(acceptedWorker)
            .mockReturnValue(unexpectedWorker);
        const frames: FrameRequestCallback[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
        });
        accept(client, acceptedWorker, frames, 21);
        const postsBefore = acceptedWorker.posts.length;
        const oversized = '界'.repeat(ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES + 1);

        expect(client.search({ query: oversized })).toBeUndefined();
        expect(client.window({ query: {}, cursor: oversized })).toBeUndefined();
        expect(client.select(oversized)).toBeUndefined();
        expect(client.tune({ focusRunId: oversized })).toBeUndefined();
        expect(acceptedWorker.posts).toHaveLength(postsBefore);

        expect(() => client.offer({
            source: 'local-files',
            label: 'l'.repeat(ANALYZE_WORKER_MAX_LABEL_BYTES + 1),
            files: [],
        })).toThrow(/bounded|metadata|offer/i);
        expect(() => client.offer({
            source: 'local-files', label: 'too many ignored files', files: [],
            ignoredFiles: Array.from({ length: 25 }, (_, index) => ({
                basename: `ignored-${index}.txt`,
                sourcePath: `ignored-${index}.txt`,
                reason: 'unsupported-extension',
            })),
        })).toThrow(/bounded|metadata|offer/i);
        expect(createWorker).toHaveBeenCalledOnce();
        expect(acceptedWorker.terminate).not.toHaveBeenCalled();
        client.dispose();
    });

    it('cleans candidate authority synchronously when the initial transfer post throws', () => {
        const throwingWorker = new ThrowingWorkerPort();
        const replacementWorker = new FakeWorkerPort();
        const workers = [throwingWorker, replacementWorker];
        const timers = new FakeTimers();
        const client = createAnalyzeWorkerClient({
            createWorker: () => workers.shift()!,
            setTimeout: timers.set,
            clearTimeout: timers.clear,
            requestAnimationFrame: () => 1,
        });

        expect(() => client.offer({
            source: 'local-files', label: 'first', files: [],
        })).toThrow('post failed');
        expect(throwingWorker.terminate).toHaveBeenCalledOnce();
        expect(timers.callbacks.size).toBe(0);

        expect(client.offer({
            source: 'local-files', label: 'replacement', files: [],
        })).toBe(2);
        expect(replacementWorker.posts.at(-1)?.message).toMatchObject({
            type: 'offer', operationGeneration: 2,
        });
        client.dispose();
    });

    it('times out only the candidate or request that owns the watchdog and ignores late replies', () => {
        const acceptedWorker = new FakeWorkerPort();
        const candidateWorker = new FakeWorkerPort();
        const workers = [acceptedWorker, candidateWorker];
        const frames: FrameRequestCallback[] = [];
        const timers = new FakeTimers();
        const unavailable: string[] = [];
        const searches: number[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker: () => workers.shift()!,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
            setTimeout: timers.set,
            clearTimeout: timers.clear,
            callbacks: {
                onUnavailable: (reason, scope, request) => unavailable.push(
                    `${scope}:${reason}:${request?.kind ?? 'none'}:${request?.requestId ?? 'none'}`,
                ),
                onSearchComplete: response => searches.push(response.requestId),
            },
        });
        accept(client, acceptedWorker, frames, 9);
        const retained = client.currentExport();

        const request = client.search({ query: 'held' });
        timers.runOldest();
        acceptedWorker.emitMessage(searchResponse(request!, 9, 1));
        expect(searches).toEqual([]);
        expect(acceptedWorker.terminate).not.toHaveBeenCalled();

        const candidate = client.offer({ source: 'local-files', label: 'held', files: [] });
        timers.runOldest();
        candidateWorker.emitMessage({ type: 'accepted', operationGeneration: candidate });
        expect(candidateWorker.terminate).toHaveBeenCalledOnce();
        expect(acceptedWorker.terminate).not.toHaveBeenCalled();
        expect(client.currentExport()).toBe(retained);
        expect(unavailable).toEqual([
            `accepted-request:timeout:search:${request}`,
            'candidate:timeout:none:none',
        ]);
        client.dispose();
    });

    it('cancels the prior query window watchdog when a newer search owns authority', () => {
        const worker = new FakeWorkerPort();
        const frames: FrameRequestCallback[] = [];
        const timers = new FakeTimers();
        const unavailable: string[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker: () => worker,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
            setTimeout: timers.set,
            clearTimeout: timers.clear,
            callbacks: {
                onUnavailable: (reason, scope) => unavailable.push(`${scope}:${reason}`),
            },
        });
        accept(client, worker, frames, 12);
        const initial = client.search({ query: 'first query' });
        worker.emitMessage(searchResponse(initial!, 12, 1, {
            ...emptyWindow(), nextCursor: 'first-next',
        }));

        client.window({ query: { query: 'first query' }, cursor: 'first-next' });
        const newest = client.search({ query: 'second query' });
        expect(timers.callbacks.size).toBe(1);
        worker.emitMessage(searchResponse(newest!, 12, 2));
        expect(timers.callbacks.size).toBe(0);
        expect(unavailable).toEqual([]);
        client.dispose();
    });

    it('creates no worker until the lazy factory is explicitly invoked', () => {
        const worker = fakeWorker();
        const construct = vi.fn(() => worker);
        const createWorker = createAnalyzeWorkerFactory(construct);

        expect(construct).not.toHaveBeenCalled();
        expect(createWorker()).toBe(worker);
        expect(construct).toHaveBeenCalledOnce();
    });

    it('targets the production Analyze artifact worker asset', () => {
        const worker = fakeWorker();
        const constructed = vi.fn();
        class WorkerConstructor {
            constructor(url: URL, options: WorkerOptions) {
                constructed(url, options);
                return worker;
            }
        }
        vi.stubGlobal('Worker', WorkerConstructor);

        createAnalyzeWorkerFactory()();

        expect(String(constructed.mock.calls[0]?.[0])).toMatch(
            /\/analyze-artifact\.worker\.ts$/,
        );
        expect(constructed.mock.calls[0]?.[1]).toEqual(
            { name: 'rallar-recipe-console-analyze', type: 'module' },
        );
        vi.unstubAllGlobals();
    });

    it('records separate finite parse and model measures when a model completes', () => {
        const worker = new FakeWorkerPort();
        const frames: FrameRequestCallback[] = [];
        const performance = new FakePerformance();
        const client = createAnalyzeWorkerClient({
            createWorker: () => worker,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
            performance,
        });

        accept(client, worker, frames, 14);

        expect(performance.measures.map(row => [
            row.name,
            row.options.duration,
        ])).toEqual([
            [ANALYZE_WORKER_PERFORMANCE_NAMES.parse, 0.25],
            [ANALYZE_WORKER_PERFORMANCE_NAMES.model, 1],
        ]);
        client.dispose();
    });

    it('records each accepted search response exactly once', () => {
        const worker = new FakeWorkerPort();
        const frames: FrameRequestCallback[] = [];
        const performance = new FakePerformance();
        const client = createAnalyzeWorkerClient({
            createWorker: () => worker,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
            performance,
        });
        accept(client, worker, frames, 15);

        const requestId = client.search({ query: 'one measure' });
        worker.emitMessage(searchResponse(requestId!, 15, 1));

        expect(performance.clearedMarks.filter(name =>
            name === ANALYZE_WORKER_PERFORMANCE_NAMES.search
        )).toHaveLength(1);
        expect(performance.measures.filter(row =>
            row.name === ANALYZE_WORKER_PERFORMANCE_NAMES.search
        )).toHaveLength(1);
        client.dispose();
    });

    it('uses the canonical bounded traversal-safe artifact filename', () => {
        const worker = new FakeWorkerPort();
        const frames: FrameRequestCallback[] = [];
        const client = createAnalyzeWorkerClient({
            createWorker: () => worker,
            requestAnimationFrame: callback => (frames.push(callback), frames.length),
        });
        const generation = client.offer({
            source: 'local-files', label: 'unsafe identity', files: [],
        });
        worker.emitMessage({ type: 'accepted', operationGeneration: generation });
        frames.shift()?.(0); frames.shift()?.(16);
        const complete = completeResponse(generation, generation);
        const distributedRunId = `../dist-\u202e/${'x'.repeat(300)}`;
        worker.emitMessage({
            ...complete,
            projection: {
                ...complete.projection,
                distributedRunId,
                identity: { ...complete.projection.identity, distributedRunId },
            },
        });

        const filename = client.currentExport()?.filename ?? '';
        expect(filename.length).toBeLessThanOrEqual(140);
        expect(filename).not.toMatch(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u);
        expect(filename).not.toContain('..');
        client.dispose();
    });

    it('promotes a candidate export only after commit and keeps it after failure', async () => {
        const retention = createAnalyzeExportBlobRetention();
        const accepted = new Blob(['accepted artifact'], { type: 'application/json' });
        const replacement = new Blob(['replacement artifact'], { type: 'application/json' });

        retention.stage({ generation: 1, blob: accepted, filename: 'accepted.json' });
        expect(retention.current()).toBeUndefined();
        expect(retention.commit(1)).toBe(true);
        expect(await retention.current()?.blob.text()).toBe('accepted artifact');

        retention.stage({ generation: 2, blob: replacement, filename: 'replacement.json' });
        retention.reject(2);
        expect(await retention.current()?.blob.text()).toBe('accepted artifact');
        expect(retention.current()?.filename).toBe('accepted.json');
    });

    it('invalidates stale export commits and clears retained bytes explicitly', () => {
        const retention = createAnalyzeExportBlobRetention();
        retention.stage({
            generation: 1,
            blob: new Blob(['first']),
            filename: 'first.json',
        });
        retention.stage({
            generation: 2,
            blob: new Blob(['second']),
            filename: 'second.json',
        });

        expect(retention.commit(1)).toBe(false);
        expect(retention.current()).toBeUndefined();
        expect(retention.commit(2)).toBe(true);
        expect(retention.current()?.generation).toBe(2);
        retention.clear();
        expect(retention.current()).toBeUndefined();
    });

    it('keeps one finite numeric secret-free performance entry per fixed name', () => {
        const performance = new FakePerformance();

        recordAnalyzeWorkerPerformance(performance, {
            name: 'model',
            durationMs: 12.5,
            counts: {
                sourceCount: 6,
                indexCount: 500,
                matchCount: 64,
                mountedCount: 64,
                renderCount: 2,
            },
        });
        recordAnalyzeWorkerPerformance(performance, {
            name: 'model',
            durationMs: 8.25,
            counts: {
                sourceCount: 6,
                indexCount: 500,
                matchCount: 12,
                mountedCount: 12,
                renderCount: 3,
            },
        });

        expect(performance.measures).toEqual([{
            name: ANALYZE_WORKER_PERFORMANCE_NAMES.model,
            options: {
                start: 0,
                duration: 8.25,
                detail: {
                    sourceCount: 6,
                    indexCount: 500,
                    matchCount: 12,
                    mountedCount: 12,
                    renderCount: 3,
                },
            },
        }]);
        expect(performance.clearedMarks).toEqual([
            ANALYZE_WORKER_PERFORMANCE_NAMES.model,
            ANALYZE_WORKER_PERFORMANCE_NAMES.model,
        ]);
        expect(Object.keys(ANALYZE_WORKER_PERFORMANCE_NAMES)).toEqual([
            'parse',
            'model',
            'search',
            'window',
            'tune',
        ]);
        expect(JSON.stringify(performance.measures)).not.toMatch(
            /token|payload|secret|artifact|filename|query/i,
        );
        expect(() => recordAnalyzeWorkerPerformance(performance, {
            name: 'search',
            durationMs: Number.NaN,
            counts: {
                sourceCount: 1,
                indexCount: 1,
                matchCount: 1,
                mountedCount: 1,
                renderCount: 1,
            },
        })).not.toThrow();
        expect(performance.measures).toHaveLength(1);
    });
});

function fakeWorker(): AnalyzeWorkerPort {
    return {
        postMessage: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        terminate: vi.fn(),
    };
}

class FakeWorkerPort implements AnalyzeWorkerPort {
    readonly posts: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
    readonly terminate = vi.fn();
    readonly #listeners = new Map<string, Set<EventListener>>();

    postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
    ): void {
        this.posts.push({ message, transfer: toTransferList(transfer) });
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const normalized = typeof listener === 'function'
            ? listener
            : (event: Event) => listener.handleEvent(event);
        const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
        listeners.add(normalized);
        this.#listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === 'function') this.#listeners.get(type)?.delete(listener);
    }

    emitMessage(message: AnalyzeWorkerResponse): void {
        const event = new MessageEvent('message', { data: message });
        this.emitEvent(event);
    }

    emit(type: 'error' | 'messageerror'): void {
        this.emitEvent(new Event(type));
    }

    private emitEvent(event: Event): void {
        for (const listener of this.#listeners.get(event.type) ?? []) listener(event);
    }
}

function toTransferList(
    transfer: Transferable[] | StructuredSerializeOptions,
): readonly Transferable[] {
    return Array.isArray(transfer) ? transfer : transfer.transfer ?? [];
}

class ThrowingWorkerPort extends FakeWorkerPort {
    override postMessage(): void {
        throw new Error('post failed');
    }
}

function completeResponse(
    operationGeneration: number,
    modelGeneration: number,
): Extract<AnalyzeWorkerResponse, { type: 'complete' }> {
    const exportBytes = new TextEncoder().encode('{"portable":true}').buffer as ArrayBuffer;
    return {
        type: 'complete', operationGeneration, modelGeneration, exportBytes,
        projection: {
            distributedRunId: 'dist', controlRunId: 'control',
            identity: { distributedRunId: 'dist', controlRunId: 'control' },
            workspace: {
                source: 'loose-files', support: 'supported', generatedAtEpochMs: 1,
                artifactSchemaVersion: 1, inventory: [], issues: [],
            },
            analysis: {
                generatedAtEpochMs: 1, distributedRunId: 'dist', controlRunId: 'control',
                status: 'passed', ok: true,
                summary: { agents: 1, passRate: 1, failureGroups: 0, blockingFailures: 0 },
                parseWarnings: [], summaryMarkdown: 'summary',
            },
            issueMarkdown: 'issue',
            provenance: {
                source: 'local-files', label: 'artifact', workspaceSource: 'loose-files',
                generatedAtEpochMs: 1, selectedFileCount: 1, artifactFileCount: 1,
                loadedFileCount: 1, ignoredFileCount: 0, workspaceIgnoredFileCount: 0,
                ignoredFiles: [],
            },
        },
        initialWindow: emptyWindow(),
        telemetry: telemetry(),
    };
}

function searchResponse(
    requestId: number,
    modelGeneration: number,
    queryGeneration: number,
    window = emptyWindow(),
): Extract<AnalyzeWorkerResponse, { type: 'search-complete' }> {
    return {
        type: 'search-complete', requestId, modelGeneration, queryGeneration,
        window, telemetry: telemetry(),
    };
}

function windowResponse(
    requestId: number,
    modelGeneration: number,
    queryGeneration: number,
    windowGeneration: number,
): Extract<AnalyzeWorkerResponse, { type: 'window-complete' }> {
    return {
        type: 'window-complete', requestId, modelGeneration, queryGeneration,
        windowGeneration, window: emptyWindow(), telemetry: telemetry(),
    };
}

function selectionResponse(
    requestId: number,
    modelGeneration: number,
    selectionGeneration: number,
): Extract<AnalyzeWorkerResponse, { type: 'selection-complete' }> {
    return {
        type: 'selection-complete', requestId, modelGeneration,
        selectionGeneration,
    };
}

function tuneResponse(
    requestId: number,
    modelGeneration: number,
    tuneGeneration: number,
): Extract<AnalyzeWorkerResponse, { type: 'tune-complete' }> {
    const complete = completeResponse(modelGeneration, modelGeneration);
    return {
        type: 'tune-complete', requestId, modelGeneration, tuneGeneration,
        facade: {
            identity: complete.projection.identity,
            support: 'supported', generatedAtEpochMs: 1,
            manifestSummary: {
                distributedRunId: 'dist', controlRunId: 'control',
                group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' },
                recipeIds: { entries: [], total: 0, omitted: 0 },
                targetPolicy: {
                    mode: 'selected-agents', configuredAgentCount: 0,
                    configuredRoleCount: 0,
                },
                roleAssignmentCount: 0,
            },
            tuningInventory: {
                totalKnobs: 0, knobs: [], omittedKnobs: 0,
                totalLimitations: 0, limitations: [], omittedLimitations: 0,
            },
            selection: { focusRunId: 'dist', artifactRole: 'focus' },
            distributedRun: {
                distributedRunId: 'dist', controlRunId: 'control', state: 'passed',
                updatedAtEpochMs: 1,
                targetAgentIds: { entries: [], total: 0, omitted: 0 },
                rollup: {
                    state: 'passed', ok: true, failures: [],
                    summary: {
                        participants: 0, requiredParticipants: 0, readyParticipants: 0,
                        passedParticipants: 0, failedParticipants: 0, recipes: 0,
                        requiredRecipes: 0, passedRecipes: 0, failedRecipes: 0,
                        groupAssertions: 0, passedGroupAssertions: 0, failedGroupAssertions: 0,
                        blockingFailures: 0,
                    },
                },
            },
            analysis: complete.projection.analysis,
            receivedMessageDeltas: { entries: [], total: 0, omitted: 0 },
        },
        telemetry: telemetry(),
    };
}

function accept(
    client: ReturnType<typeof createAnalyzeWorkerClient>,
    worker: FakeWorkerPort,
    frames: FrameRequestCallback[],
    modelGeneration: number,
): number {
    const generation = client.offer({
        source: 'local-files', label: 'artifact', files: [],
    });
    worker.emitMessage({ type: 'accepted', operationGeneration: generation });
    frames.shift()?.(0); frames.shift()?.(16);
    worker.emitMessage(completeResponse(generation, modelGeneration));
    return generation;
}

function emptyWindow(): AnalyzeEvidenceWindowProjection {
    return {
        entries: [], rangeStart: 0, rangeEnd: 0,
        counts: {
            totalEntries: 0, indexedEntries: 0, indexOmittedEntries: 0,
            retainedMatches: 0, queryExcludedEntries: 0,
            renderedMatches: 0, renderOmittedMatches: 0,
        },
        totalMatchesIsComplete: true,
        windowSize: 64,
    };
}

function telemetry() {
    return {
        durationMs: 1, parseDurationMs: 0.25,
        sourceFileCount: 1, sourceBytes: 2,
        pipelinePassCount: 1, sourceCollectionPassCount: 1,
        sourceFileVisitCount: 1,
        documentParseCount: 1, jsonlFilePassCount: 0, jsonlRowParseCount: 0,
        totalEntryCount: 0, retainedEntryCount: 0, indexOmittedEntryCount: 0,
        matchedEntryCount: 0, projectedEntryCount: 0,
    } as const;
}

class FakePerformance implements AnalyzeWorkerPerformancePort {
    readonly measures: Array<Readonly<{
        name: string;
        options: PerformanceMeasureOptions;
    }>> = [];
    readonly clearedMarks: string[] = [];

    clearMarks(name: string): void {
        this.clearedMarks.push(name);
    }

    clearMeasures(name: string): void {
        const retained = this.measures.filter(measure => measure.name !== name);
        this.measures.splice(0, this.measures.length, ...retained);
    }

    measure(name: string, options: PerformanceMeasureOptions): PerformanceMeasure {
        this.measures.push({ name, options });
        return {} as PerformanceMeasure;
    }
}

class FakeTimers {
    readonly callbacks = new Map<number, () => void>();
    #next = 0;

    readonly set = (callback: () => void): number => {
        const id = ++this.#next;
        this.callbacks.set(id, callback);
        return id;
    };

    readonly clear = (id: number | ReturnType<typeof setTimeout>): void => {
        this.callbacks.delete(id as number);
    };

    runOldest(): void {
        const entry = this.callbacks.entries().next().value as
            | readonly [number, () => void]
            | undefined;
        if (!entry) throw new Error('No pending timer.');
        this.callbacks.delete(entry[0]);
        entry[1]();
    }
}
