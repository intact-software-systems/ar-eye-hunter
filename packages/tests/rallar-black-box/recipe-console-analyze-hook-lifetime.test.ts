// @vitest-environment happy-dom
import {
    act,
    createElement,
    useLayoutEffect,
    useState,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeConsoleControlExecutionApi } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-execution-api.ts';
import type { RecipeConsoleControlSelection } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-selection.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import type {
    AnalyzeWorkerRequest,
    AnalyzeWorkerResponse,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-contract.ts';
import {
    useAnalyzeWorkspace,
    type AnalyzeWorkspaceController,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/use-analyze-workspace.ts';

type RecipeConsoleControlConnection = Parameters<
    typeof useAnalyzeWorkspace
>[0]['connection'];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Recipe Console rendered Analyze worker lifetime', () => {
    let container: HTMLDivElement;
    let root: Root;
    let frames: FrameRequestCallback[];
    let controller: AnalyzeWorkspaceController | undefined;

    beforeEach(() => {
        ControllableWorker.instances.length = 0;
        frames = [];
        vi.stubGlobal('Worker', ControllableWorker);
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        }));
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('keeps input, navigation, accepted analysis, and export usable across held replies, Tune, and a failed replacement', async () => {
        const execution = createExecution();
        const connection = createConnection(execution);
        const navigateEvents: NavigationEvent[] = [];
        const navigate = (patch: Partial<RecipeConsoleUrlState>) => {
            navigateEvents.push({
                patch,
                committedStatus: workspace()?.dataset.status,
                pendingPainted: workspace()?.dataset.pendingPainted,
            });
        };
        const props = harnessProps({
            connection,
            navigate,
            urlState: urlState('analyze', 'dist-a'),
            capture: value => {
                controller = value;
            },
        });
        await render(props);

        const { completion: firstCompletion } = await beginControlLoad(1);
        const acceptedWorker = ControllableWorker.instances[0]!;
        const firstGeneration = acceptedWorker.request('offer').operationGeneration;
        expect(workspace()?.dataset).toMatchObject({
            status: 'pending',
            pendingPainted: 'false',
        });

        await emit(acceptedWorker, {
            type: 'accepted',
            operationGeneration: firstGeneration,
        });
        expect(acceptedWorker.requestTypes()).toEqual(['offer']);

        await runFrame(0);
        expect(workspace()?.dataset).toMatchObject({
            status: 'pending',
            pendingPainted: 'true',
        });
        expect(acceptedWorker.requestTypes()).toEqual(['offer']);

        await runFrame(16);
        expect(acceptedWorker.requestTypes()).toEqual(['offer', 'start']);

        await emit(
            acceptedWorker,
            completeResponse(firstGeneration, 101, 'dist-a'),
        );
        await expect(firstCompletion).resolves.toBe(true);
        expect(workspace()?.dataset).toMatchObject({
            status: 'ready',
            distributedRunId: 'dist-a',
            pendingPainted: 'false',
        });
        expect(identityNavigation(navigateEvents)).toEqual([{
            patch: expect.objectContaining({
                controlRunId: 'control-a',
                distributedRunId: 'dist-a',
            }),
            committedStatus: 'ready',
            pendingPainted: 'false',
        }]);

        const search = acceptedWorker.request('search');
        await setInput('search response held');
        await click('Navigate locally');
        expect(workspace()?.dataset).toMatchObject({
            input: 'search response held',
            routeClicks: '1',
            status: 'ready',
        });

        await emit(acceptedWorker, searchResponse(search, {
            ...emptyWindow(),
            nextCursor: 'next-window',
        }));
        let windowRequestId: number | undefined;
        await act(async () => {
            windowRequestId = controller?.requestWindow('next-window');
        });
        expect(windowRequestId).toBeDefined();
        expect(acceptedWorker.request('window').requestId).toBe(windowRequestId);

        await setInput('window response held');
        await click('Navigate locally');
        expect(workspace()?.dataset).toMatchObject({
            input: 'window response held',
            routeClicks: '2',
            status: 'ready',
        });

        const { completion: replacementCompletion } = await beginControlLoad(2);
        const replacementWorker = ControllableWorker.instances[1]!;
        const replacementGeneration = replacementWorker.request('offer')
            .operationGeneration;
        await emit(replacementWorker, {
            type: 'accepted',
            operationGeneration: replacementGeneration,
        });
        await runFrame(32);
        await runFrame(48);
        await emitFailure(replacementWorker, 'error');
        await expect(replacementCompletion).resolves.toBe(false);

        expect(workspace()?.dataset).toMatchObject({
            status: 'error',
            distributedRunId: 'dist-a',
        });
        expect(acceptedWorker.terminate).not.toHaveBeenCalled();
        expect(replacementWorker.terminate).toHaveBeenCalledOnce();
        expect(identityNavigation(navigateEvents)).toHaveLength(1);

        await render({
            ...props,
            urlState: urlState('tune', 'dist-a'),
        });
        let tuneRequest: Extract<AnalyzeWorkerRequest, { type: 'tune' }> | undefined;
        await vi.waitFor(() => {
            expect(acceptedWorker.requestTypes()).toContain('tune');
            tuneRequest = acceptedWorker.request('tune');
        });
        await emit(acceptedWorker, tuneResponse(tuneRequest!));
        expect(workspace()?.dataset.hasTuneFacade).toBe('true');
        await render({
            ...props,
            urlState: {
                ...urlState('tune', 'dist-a'),
                timingMetric: 'p95',
            },
        });
        await vi.waitFor(() => {
            expect(acceptedWorker.requestTypes().filter(type => type === 'tune'))
                .toHaveLength(2);
        });
        expect(workspace()?.dataset.hasTuneFacade).toBe('true');
        await render({
            ...props,
            urlState: urlState('analyze', 'dist-a'),
        });
        expect(ControllableWorker.instances).toHaveLength(2);
        expect(acceptedWorker.terminate).not.toHaveBeenCalled();
        expect(workspace()?.dataset.hasTuneFacade).toBe('true');

        await emitFailure(acceptedWorker, 'messageerror');
        expect(acceptedWorker.terminate).toHaveBeenCalledOnce();
        expect(workspace()?.dataset.hasTuneFacade).toBe('true');
        await render({
            ...props,
            urlState: urlState('tune', 'dist-a'),
        });
        expect(workspace()?.dataset.hasTuneFacade).toBe('true');

        const createObjectUrl = vi.spyOn(URL, 'createObjectURL')
            .mockReturnValue('blob:retained-artifact');
        const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL')
            .mockImplementation(() => {});
        const downloads: Array<Readonly<{ filename: string; href: string }>> = [];
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement,
        ) {
            downloads.push({ filename: this.download, href: this.href });
        });

        await click('Export retained artifact');
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(downloads).toEqual([{
            filename: 'dist-a-artifact.json',
            href: 'blob:retained-artifact',
        }]);
        const retainedBlob = createObjectUrl.mock.calls[0]?.[0] as Blob | undefined;
        expect(await retainedBlob?.text()).toContain('"portable":"dist-a"');
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:retained-artifact');
    });

    it('rejects a candidate completed after a render-time context and execution change before passive reconciliation', async () => {
        const firstExecution = createExecution();
        const firstConnection = createConnection(firstExecution);
        const navigateEvents: NavigationEvent[] = [];
        const navigate = (patch: Partial<RecipeConsoleUrlState>) => {
            navigateEvents.push({
                patch,
                committedStatus: workspace()?.dataset.status,
                pendingPainted: workspace()?.dataset.pendingPainted,
            });
        };
        const initialProps = harnessProps({
            connection: firstConnection,
            navigate,
            urlState: urlState('analyze', 'dist-a'),
            capture: value => {
                controller = value;
            },
        });
        await render(initialProps);

        const { completion: acceptedCompletion } = await beginControlLoad(1);
        const acceptedWorker = ControllableWorker.instances[0]!;
        const acceptedGeneration = acceptedWorker.request('offer').operationGeneration;
        await acceptAndStart(acceptedWorker, acceptedGeneration);
        await emit(
            acceptedWorker,
            completeResponse(acceptedGeneration, 201, 'dist-a'),
        );
        await expect(acceptedCompletion).resolves.toBe(true);
        expect(identityNavigation(navigateEvents)).toHaveLength(1);

        const { completion: candidateCompletion } = await beginControlLoad(2);
        const candidateWorker = ControllableWorker.instances[1]!;
        const candidateGeneration = candidateWorker.request('offer').operationGeneration;
        await acceptAndStart(candidateWorker, candidateGeneration);

        const secondExecution = createExecution();
        let emittedDuringLayout = false;
        await render({
            ...initialProps,
            connection: createConnection(secondExecution),
            selection: createSelection('dist-b'),
            urlState: urlState('analyze', 'dist-b'),
            afterCommit: () => {
                if (emittedDuringLayout) return;
                emittedDuringLayout = true;
                candidateWorker.emitMessage(
                    completeResponse(candidateGeneration, 202, 'dist-a'),
                );
            },
        });

        await expect(candidateCompletion).resolves.toBe(false);
        expect(emittedDuringLayout).toBe(true);
        expect(candidateWorker.terminate).toHaveBeenCalledOnce();
        expect(acceptedWorker.terminate).not.toHaveBeenCalled();
        expect(identityNavigation(navigateEvents)).toHaveLength(1);
        expect(workspace()?.dataset).toMatchObject({
            status: 'error',
            distributedRunId: 'dist-a',
            selectedDistributedRunId: 'dist-b',
        });
    });

    it('promotes a long digest-validated Control identity without navigating to its display handle', async () => {
        const distributedRunId = `distributed-${'界'.repeat(600)}`;
        const navigateEvents: NavigationEvent[] = [];
        await render(harnessProps({
            connection: createConnection(createExecution()),
            navigate: patch => navigateEvents.push({ patch }),
            urlState: urlState('analyze', distributedRunId),
            capture: value => {
                controller = value;
            },
        }));

        const { completion } = await beginControlLoad(1);
        const worker = ControllableWorker.instances[0]!;
        const offer = worker.request('offer');
        expect(new TextEncoder().encode(offer.artifact.label).byteLength)
            .toBeLessThanOrEqual(1_024);
        await acceptAndStart(worker, offer.operationGeneration);
        const response = completeResponse(offer.operationGeneration, 301, 'display');
        const displayHandle = 'opaque-id:1812:0123456789abcdef0123456789abcdef';
        await emit(worker, {
            ...response,
            projection: {
                ...response.projection,
                distributedRunId: displayHandle,
                identity: {
                    distributedRunId: displayHandle,
                    distributedRunIdExact: false,
                    controlRunId: 'control-a',
                },
            },
        });

        await expect(completion).resolves.toBe(true);
        expect(workspace()?.dataset).toMatchObject({
            status: 'ready',
            distributedRunId: displayHandle,
            selectedDistributedRunId: distributedRunId,
        });
        expect(identityNavigation(navigateEvents)).toEqual([]);
        expect(JSON.stringify(navigateEvents)).not.toContain(displayHandle);
    });

    it('binds cursor pending authority, recovers from failure, and suppresses stale window replies',
        async () => {
            const props = harnessProps({
                connection: createConnection(createExecution()),
                navigate: vi.fn(),
                urlState: urlState('analyze', 'dist-a'),
                capture: value => {
                    controller = value;
                },
            });
            await render(props);
            const { completion } = await beginControlLoad(1);
            const worker = ControllableWorker.instances[0]!;
            const generation = worker.request('offer').operationGeneration;
            await acceptAndStart(worker, generation);
            await emit(worker, completeResponse(generation, 401, 'dist-a'));
            await expect(completion).resolves.toBe(true);

            const search = worker.request('search');
            expect(controller?.evidenceWindowPending).toBe(true);
            await emit(worker, searchResponse(search, {
                ...emptyWindow(),
                entries: [evidenceEntry('query-a-row')],
                rangeStart: 1,
                rangeEnd: 1,
                nextCursor: 'query-a-next',
                counts: {
                    ...emptyWindow().counts,
                    totalEntries: 2,
                    indexedEntries: 2,
                    retainedMatches: 2,
                    renderedMatches: 1,
                    renderOmittedMatches: 1,
                },
            }));
            expect(controller?.evidenceWindowPending).toBe(false);
            expect(controller?.evidenceWindow?.entries[0]?.id).toBe('query-a-row');

            let failedRequestId: number | undefined;
            let blockedRepeatId: number | undefined;
            await act(async () => {
                failedRequestId = controller?.requestWindow('query-a-next');
                blockedRepeatId = controller?.requestWindow('query-a-next');
            });
            expect(failedRequestId).toBeDefined();
            expect(blockedRepeatId).toBeUndefined();
            expect(controller?.evidenceWindowPending).toBe(true);
            await emit(worker, {
                type: 'failed',
                requestId: failedRequestId,
                error: { code: 'invalid-request', stage: 'window', recoverable: true },
            });
            expect(controller?.evidenceWindowPending).toBe(false);
            expect(controller?.evidenceWindowError)
                .toBe('The evidence window request failed. Try again.');
            expect(controller?.evidenceWindow?.entries[0]?.id).toBe('query-a-row');

            let retryRequestId: number | undefined;
            await act(async () => {
                retryRequestId = controller?.retryEvidenceSearch();
            });
            const retrySearch = worker.request('search');
            expect(retryRequestId).toBeDefined();
            expect(retrySearch.requestId).toBe(retryRequestId);
            expect(retrySearch.requestId).not.toBe(search.requestId);
            expect(retrySearch.query).toEqual(search.query);
            expect(controller?.evidenceWindowPending).toBe(true);
            expect(controller?.evidenceWindowError).toBeUndefined();
            expect(controller?.evidenceWindow?.entries[0]?.id).toBe('query-a-row');
            await emit(worker, searchResponse(retrySearch, {
                ...emptyWindow(),
                entries: [evidenceEntry('query-a-row')],
                rangeStart: 1,
                rangeEnd: 1,
                nextCursor: 'query-a-next',
                counts: {
                    ...emptyWindow().counts,
                    totalEntries: 2,
                    indexedEntries: 2,
                    retainedMatches: 2,
                    renderedMatches: 1,
                    renderOmittedMatches: 1,
                },
            }));
            expect(controller?.evidenceWindowPending).toBe(false);

            let staleWindowId: number | undefined;
            await act(async () => {
                staleWindowId = controller?.requestWindow('query-a-next');
            });
            const staleWindow = worker.request('window');
            expect(staleWindow.requestId).toBe(staleWindowId);
            await render({
                ...props,
                urlState: { ...props.urlState, historyQuery: 'query-b' },
            });
            const currentSearch = worker.request('search');
            expect(currentSearch.query.query).toBe('query-b');
            expect(controller?.evidenceWindowPending).toBe(true);

            await emit(worker, {
                type: 'failed',
                requestId: staleWindow.requestId,
                error: { code: 'invalid-request', stage: 'window', recoverable: true },
            });
            expect(controller?.evidenceWindowPending).toBe(true);
            expect(controller?.evidenceWindowError).toBeUndefined();
            await emit(worker, windowResponse(staleWindow, {
                ...emptyWindow(),
                entries: [evidenceEntry('stale-window-row')],
                rangeStart: 2,
                rangeEnd: 2,
            }));
            expect(controller?.evidenceWindowPending).toBe(true);
            expect(controller?.evidenceWindow?.entries[0]?.id).toBe('query-a-row');

            await emit(worker, searchResponse(currentSearch, {
                ...emptyWindow(),
                entries: [evidenceEntry('query-b-row')],
                rangeStart: 1,
                rangeEnd: 1,
                counts: {
                    ...emptyWindow().counts,
                    totalEntries: 1,
                    indexedEntries: 1,
                    retainedMatches: 1,
                    renderedMatches: 1,
                },
            }));
            expect(controller?.evidenceWindowPending).toBe(false);
            expect(controller?.evidenceWindowError).toBeUndefined();
            expect(controller?.evidenceWindow?.entries[0]?.id).toBe('query-b-row');
            expect(controller?.evidenceWindowFingerprint)
                .toBe(controller?.queryFingerprint);
        });

    async function render(props: HarnessProps): Promise<void> {
        await act(async () => root.render(createElement(AnalyzeHookHarness, props)));
    }

    async function beginControlLoad(
        expectedWorkerCount: number,
    ): Promise<Readonly<{ completion: Promise<boolean> }>> {
        let completion: Promise<boolean> | undefined;
        await act(async () => {
            completion = controller?.loadControlArtifact();
            await vi.waitFor(() => {
                expect(ControllableWorker.instances).toHaveLength(expectedWorkerCount);
            });
        });
        if (!completion) throw new Error('Analyze controller did not start a control load.');
        return { completion };
    }

    async function acceptAndStart(
        worker: ControllableWorker,
        generation: number,
    ): Promise<void> {
        await emit(worker, { type: 'accepted', operationGeneration: generation });
        await runFrame(0);
        await runFrame(16);
    }

    async function runFrame(now: number): Promise<void> {
        const frame = frames.shift();
        if (!frame) throw new Error('Expected a pending animation frame.');
        await act(async () => frame(now));
    }

    async function emit(
        worker: ControllableWorker,
        response: AnalyzeWorkerResponse,
    ): Promise<void> {
        await act(async () => worker.emitMessage(response));
    }

    async function emitFailure(
        worker: ControllableWorker,
        type: 'error' | 'messageerror',
    ): Promise<void> {
        await act(async () => worker.emit(type));
    }

    async function setInput(value: string): Promise<void> {
        const input = container.querySelector<HTMLInputElement>(
            'input[aria-label="Responsive Analyze input"]',
        );
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
        )?.set;
        if (!input || !setter) throw new Error('Expected responsive Analyze input.');
        await act(async () => {
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    async function click(label: string): Promise<void> {
        const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
            .find(candidate => candidate.textContent === label);
        if (!button) throw new Error(`Expected button ${label}.`);
        await act(async () => button.click());
    }

    function workspace(): HTMLElement | null {
        return container.querySelector('[data-analyze-hook-workspace]');
    }
});

type HarnessProps = Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    capture(controller: AnalyzeWorkspaceController): void;
    afterCommit?(): void;
}>;

function AnalyzeHookHarness(props: HarnessProps) {
    const controller = useAnalyzeWorkspace(props);
    const [input, setInput] = useState('');
    const [routeClicks, setRouteClicks] = useState(0);
    props.capture(controller);
    useLayoutEffect(() => {
        props.afterCommit?.();
    }, [props.afterCommit]);

    return createElement(
        'section',
        {
            'data-analyze-hook-workspace': '',
            'data-status': controller.status,
            'data-distributed-run-id': controller.model?.distributedRunId ?? '',
            'data-selected-distributed-run-id': controller.distributedRunId ?? '',
            'data-pending-painted': String(
                controller.pendingPaintGeneration === controller.operationGeneration,
            ),
            'data-has-tune-facade': String(controller.tuneFacade !== undefined),
            'data-input': input,
            'data-route-clicks': String(routeClicks),
        },
        createElement('input', {
            'aria-label': 'Responsive Analyze input',
            value: input,
            onChange: (event: { currentTarget: HTMLInputElement }) => {
                setInput(event.currentTarget.value);
            },
        }),
        createElement('button', {
            type: 'button',
            onClick: () => {
                setRouteClicks(value => value + 1);
                controller.updateFilters({ view: 'tune' });
            },
        }, 'Navigate locally'),
        createElement('button', {
            type: 'button',
            onClick: controller.exportArtifact,
        }, 'Export retained artifact'),
    );
}

class ControllableWorker {
    static readonly instances: ControllableWorker[] = [];

    readonly posts: Array<Readonly<{
        message: AnalyzeWorkerRequest;
        transfer: readonly Transferable[];
    }>> = [];
    readonly terminate = vi.fn();
    readonly #listeners = new Map<string, Set<EventListener>>();

    constructor(
        readonly url: string | URL,
        readonly options?: WorkerOptions,
    ) {
        ControllableWorker.instances.push(this);
    }

    postMessage(
        message: AnalyzeWorkerRequest,
        transfer: readonly Transferable[] = [],
    ): void {
        this.posts.push({ message, transfer });
    }

    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
    ): void {
        const normalized = normalizeListener(listener);
        const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
        listeners.add(normalized);
        this.#listeners.set(type, listeners);
    }

    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
    ): void {
        if (typeof listener === 'function') {
            this.#listeners.get(type)?.delete(listener);
        }
    }

    emitMessage(message: AnalyzeWorkerResponse): void {
        this.emitEvent(new MessageEvent('message', { data: message }));
    }

    emit(type: 'error' | 'messageerror'): void {
        this.emitEvent(new Event(type));
    }

    request<Type extends AnalyzeWorkerRequest['type']>(
        type: Type,
    ): Extract<AnalyzeWorkerRequest, { type: Type }> {
        const match = [...this.posts].reverse().find(post => post.message.type === type);
        if (!match) throw new Error(`Expected Analyze worker request ${type}.`);
        return match.message as Extract<AnalyzeWorkerRequest, { type: Type }>;
    }

    requestTypes(): AnalyzeWorkerRequest['type'][] {
        return this.posts.map(post => post.message.type);
    }

    private emitEvent(event: Event): void {
        for (const listener of this.#listeners.get(event.type) ?? []) listener(event);
    }
}

function normalizeListener(
    listener: EventListenerOrEventListenerObject,
): EventListener {
    return typeof listener === 'function'
        ? listener
        : event => listener.handleEvent(event);
}

function harnessProps(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    capture(controller: AnalyzeWorkspaceController): void;
}>): HarnessProps {
    return {
        ...input,
        selection: createSelection(input.urlState.distributedRunId ?? ''),
        replace: vi.fn(),
    };
}

function createExecution(): RecipeConsoleControlExecutionApi {
    return {
        exportRunArtifactBytes: vi.fn(async request => ({
            distributedRunId: request.distributedRunId,
            bytes: new TextEncoder().encode('{"files":{}}').buffer as ArrayBuffer,
        })),
    } as unknown as RecipeConsoleControlExecutionApi;
}

function createConnection(
    execution: RecipeConsoleControlExecutionApi,
): RecipeConsoleControlConnection {
    return {
        baseUrl: 'http://control.example.test',
        execution,
        query: {
            status: 'live',
            reachability: 'reachable',
            authorization: 'ready',
            snapshot: { runs: [], distributedRuns: [] },
            completeness: 'complete',
            receivedAtEpochMs: 1,
            isRefreshing: false,
        },
    } as unknown as RecipeConsoleControlConnection;
}

function createSelection(distributedRunId: string): RecipeConsoleControlSelection {
    return {
        controlRunId: 'control-a',
        distributedRunId,
        issues: [],
    } as unknown as RecipeConsoleControlSelection;
}

function urlState(
    view: RecipeConsoleUrlState['view'],
    distributedRunId: string,
): RecipeConsoleUrlState {
    return {
        v: 1,
        experience: 'recipe-console',
        view,
        controlRunId: 'control-a',
        distributedRunId,
    };
}

function completeResponse(
    operationGeneration: number,
    modelGeneration: number,
    distributedRunId: string,
): Extract<AnalyzeWorkerResponse, { type: 'complete' }> {
    return {
        type: 'complete',
        operationGeneration,
        modelGeneration,
        controlIdentityValidated: true,
        projection: {
            distributedRunId,
            controlRunId: 'control-a',
            identity: { distributedRunId, controlRunId: 'control-a' },
            workspace: {
                source: 'loose-files',
                support: 'supported',
                generatedAtEpochMs: 1,
                artifactSchemaVersion: 1,
                inventory: [],
                issues: [],
            },
            analysis: {
                generatedAtEpochMs: 1,
                distributedRunId,
                controlRunId: 'control-a',
                status: 'passed',
                ok: true,
                summary: {
                    agents: 1,
                    passRate: 1,
                    failureGroups: 0,
                    blockingFailures: 0,
                },
                parseWarnings: [],
                summaryMarkdown: 'summary',
            },
            issueMarkdown: 'issue',
            provenance: {
                source: 'control',
                label: `Control artifact ${distributedRunId}`,
                workspaceSource: 'loose-files',
                generatedAtEpochMs: 1,
                selectedFileCount: 1,
                artifactFileCount: 1,
                loadedFileCount: 1,
                ignoredFileCount: 0,
                workspaceIgnoredFileCount: 0,
                ignoredFiles: [],
            },
        },
        initialWindow: emptyWindow(),
        exportBytes: new TextEncoder().encode(
            JSON.stringify({ portable: distributedRunId }),
        ).buffer as ArrayBuffer,
        telemetry: telemetry(),
    };
}

function searchResponse(
    request: Extract<AnalyzeWorkerRequest, { type: 'search' }>,
    window: ReturnType<typeof emptyWindow> & Readonly<{ nextCursor?: string }>,
): Extract<AnalyzeWorkerResponse, { type: 'search-complete' }> {
    return {
        type: 'search-complete',
        modelGeneration: request.modelGeneration,
        queryGeneration: request.queryGeneration,
        requestId: request.requestId,
        window,
        telemetry: telemetry(),
    };
}

function windowResponse(
    request: Extract<AnalyzeWorkerRequest, { type: 'window' }>,
    window: ReturnType<typeof emptyWindow> & Readonly<{
        entries?: readonly ReturnType<typeof evidenceEntry>[];
    }>,
): Extract<AnalyzeWorkerResponse, { type: 'window-complete' }> {
    return {
        type: 'window-complete',
        modelGeneration: request.modelGeneration,
        queryGeneration: request.queryGeneration,
        windowGeneration: request.windowGeneration,
        requestId: request.requestId,
        window,
        telemetry: telemetry(),
    };
}

function evidenceEntry(id: string) {
    return {
        id,
        kind: 'event' as const,
        sourceFile: 'events.jsonl',
        summary: id,
        payloadSummary: '{}',
    };
}

function tuneResponse(
    request: Extract<AnalyzeWorkerRequest, { type: 'tune' }>,
): Extract<AnalyzeWorkerResponse, { type: 'tune-complete' }> {
    const analysis = completeResponse(1, request.modelGeneration, 'dist-a')
        .projection.analysis;
    return {
        type: 'tune-complete',
        modelGeneration: request.modelGeneration,
        tuneGeneration: request.tuneGeneration,
        requestId: request.requestId,
        facade: {
            identity: { distributedRunId: 'dist-a', controlRunId: 'control-a' },
            support: 'supported',
            generatedAtEpochMs: 1,
            manifestSummary: {
                distributedRunId: 'dist-a',
                controlRunId: 'control-a',
                group: {
                    applicationId: 'app',
                    workspaceId: 'workspace',
                    groupId: 'group',
                },
                recipeIds: { entries: [], total: 0, omitted: 0 },
                targetPolicy: {
                    mode: 'explicit-agents',
                    configuredAgentCount: 0,
                    configuredRoleCount: 0,
                },
                roleAssignmentCount: 0,
            },
            tuningInventory: {
                totalKnobs: 0,
                knobs: [],
                omittedKnobs: 0,
                totalLimitations: 0,
                limitations: [],
                omittedLimitations: 0,
            },
            selection: { focusRunId: 'dist-a', artifactRole: 'focus' },
            distributedRun: {
                distributedRunId: 'dist-a',
                controlRunId: 'control-a',
                state: 'completed' as const,
                startedAtEpochMs: undefined,
                completedAtEpochMs: undefined,
                updatedAtEpochMs: 1,
                targetAgentIds: { entries: [], total: 0, omitted: 0 },
                rollup: {
                    expectedAgentCount: 0,
                    stagedAgentCount: 0,
                    startedAgentCount: 0,
                    completedAgentCount: 0,
                    failedAgentCount: 0,
                    failures: [],
                },
            },
            analysis,
            receivedMessageDeltas: { entries: [], total: 0, omitted: 0 },
        },
        telemetry: telemetry(),
    };
}

function emptyWindow() {
    return {
        entries: [],
        rangeStart: 0,
        rangeEnd: 0,
        counts: {
            totalEntries: 0,
            indexedEntries: 0,
            indexOmittedEntries: 0,
            retainedMatches: 0,
            queryExcludedEntries: 0,
            renderedMatches: 0,
            renderOmittedMatches: 0,
        },
        totalMatchesIsComplete: true,
        windowSize: 64,
    } as const;
}

function telemetry() {
    return {
        durationMs: 1,
        parseDurationMs: 0.25,
        sourceFileCount: 1,
        sourceBytes: 2,
        documentParseCount: 1,
        jsonlFilePassCount: 0,
        jsonlRowParseCount: 0,
        totalEntryCount: 0,
        retainedEntryCount: 0,
        indexOmittedEntryCount: 0,
        matchedEntryCount: 0,
        projectedEntryCount: 0,
    } as const;
}

type NavigationEvent = Readonly<{
    patch: Partial<RecipeConsoleUrlState>;
    committedStatus?: string;
    pendingPainted?: string;
}>;

function identityNavigation(events: readonly NavigationEvent[]): readonly NavigationEvent[] {
    return events.filter(event => event.patch.distributedRunId !== undefined);
}
