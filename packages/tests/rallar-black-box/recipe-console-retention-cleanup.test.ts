// @vitest-environment happy-dom
import { createElement, StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeConsoleControlRetentionCapability } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import type { RecipeConsoleControlRetentionApi } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-retention-api.ts';
import type {
    ControlRetentionConfirmation,
    ControlRetentionPreview,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-retention-validation.ts';
import {
    useRetentionCleanup,
    type RetentionCleanupController,
} from '../../../apps/rallar-black-box/src/recipe-console/history/use-retention-cleanup.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RAW_PREVIEW = {
    deletedRunIds: [],
    retainedRuns: 4,
    maxRuns: 2,
    dryRun: true,
    wouldDeleteRuns: [{
        runId: 'control-a',
        createdAtEpochMs: 10,
        updatedAtEpochMs: 20,
        connectedAgentCount: 1,
        issuedRunTokenCount: 2,
        distributedRuns: [
            { distributedRunId: 'distributed-a', state: 'running' },
            { distributedRunId: 'distributed-b', state: 'failed' },
        ],
        fleetReportIds: ['distributed-b'],
    }, {
        runId: 'control-b',
        createdAtEpochMs: 30,
        updatedAtEpochMs: 40,
        connectedAgentCount: 0,
        issuedRunTokenCount: 0,
        distributedRuns: [{ distributedRunId: 'distributed-c', state: 'passed' }],
        fleetReportIds: ['distributed-c'],
    }],
    wouldDeleteRunIds: ['control-a', 'control-b'],
    wouldDeleteDistributedRunIds: [
        'distributed-c',
        'distributed-a',
        'distributed-b',
    ],
    wouldDeleteFleetReportIds: ['distributed-c', 'distributed-b'],
    projectedRetainedRuns: 2,
    preserves: {
        connectedAgentSockets: true,
        storedArtifactFiles: true,
    },
    planToken: 'opaque-plan-token-never-for-display',
} as unknown as ControlRetentionPreview;

const CONFIRMATION: ControlRetentionConfirmation = {
    deletedRunIds: ['control-a', 'control-b'],
    retainedRuns: 2,
    maxRuns: 2,
};

type HookProps = Readonly<{
    capability?: RecipeConsoleControlRetentionCapability;
    unavailableReason?: string;
}>;

type Deferred<Value> = Readonly<{
    promise: Promise<Value>;
    resolve(value: Value): void;
    reject(error: unknown): void;
}>;

function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Value>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function fixture(overrides: Partial<RecipeConsoleControlRetentionApi> = {}) {
    const lifetime = new AbortController();
    const api: RecipeConsoleControlRetentionApi = {
        preview: vi.fn(async () => RAW_PREVIEW),
        confirm: vi.fn(async () => CONFIRMATION),
        ...overrides,
    };
    const load = vi.fn(async () => api);
    const capability: RecipeConsoleControlRetentionCapability = {
        generation: Symbol('retention-test-generation'),
        signal: lifetime.signal,
        load,
    };
    return { api, capability, lifetime, load };
}

describe('Recipe Console retention cleanup controller', () => {
    let container: HTMLDivElement;
    let root: Root;
    let current: RetentionCleanupController | undefined;
    let renders: RetentionCleanupController[];

    function Harness(props: HookProps) {
        current = useRetentionCleanup(props);
        renders.push(current);
        return null;
    }

    async function render(props: HookProps): Promise<void> {
        await act(async () => root.render(createElement(Harness, props)));
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        current = undefined;
        renders = [];
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    });

    it('loads only on Preview and exposes exact frozen token-free consequences', async () => {
        const setup = fixture();
        await render({ capability: setup.capability });

        expect(setup.load).not.toHaveBeenCalled();
        expect(current?.state).toEqual({ status: 'idle' });
        expect(current).toMatchObject({ canPreview: true, canConfirm: false, busy: false });

        await act(async () => current?.preview());

        expect(setup.load).toHaveBeenCalledTimes(1);
        expect(setup.api.preview).toHaveBeenCalledTimes(1);
        expect(current?.state.status).toBe('preview-ready');
        expect(current?.state.preview).toEqual({
            current: true,
            retainedRuns: 4,
            maxRuns: 2,
            projectedRetainedRuns: 2,
            candidates: [{
                key: 'retention-candidate:0',
                ...RAW_PREVIEW.wouldDeleteRuns[0],
            }, {
                key: 'retention-candidate:1',
                ...RAW_PREVIEW.wouldDeleteRuns[1],
            }],
            wouldDeleteRunIds: RAW_PREVIEW.wouldDeleteRunIds,
            wouldDeleteDistributedRunIds: RAW_PREVIEW.wouldDeleteDistributedRunIds,
            wouldDeleteFleetReportIds: RAW_PREVIEW.wouldDeleteFleetReportIds,
            preserves: RAW_PREVIEW.preserves,
        });
        expect(JSON.stringify(current?.state)).not.toContain('planToken');
        expect(JSON.stringify(current?.state)).not.toContain('opaque-plan-token');
        expect(Object.isFrozen(current)).toBe(true);
        expect(Object.isFrozen(current?.state.preview)).toBe(true);
        expect(Object.isFrozen(current?.state.preview?.candidates[0].distributedRuns)).toBe(true);
        expect(current).toMatchObject({ canPreview: true, canConfirm: true, busy: false });
    });

    it('remains operational after the StrictMode effect replay', async () => {
        const setup = fixture();
        await act(async () => root.render(createElement(
            StrictMode,
            null,
            createElement(Harness, { capability: setup.capability }),
        )));

        await act(async () => current?.preview());

        expect(setup.load).toHaveBeenCalledTimes(1);
        expect(setup.api.preview).toHaveBeenCalledTimes(1);
        expect(current?.state.status).toBe('preview-ready');
        expect(current?.canConfirm).toBe(true);
    });

    it.each([
        { maxRuns: 0, projectedRetainedRuns: 4, wouldDeleteRuns: [], wouldDeleteRunIds: [] },
        { maxRuns: 4, projectedRetainedRuns: 4, wouldDeleteRuns: [], wouldDeleteRunIds: [] },
    ])('keeps empty and disabled plans nonconfirmable', async patch => {
        const raw = {
            ...RAW_PREVIEW,
            ...patch,
            wouldDeleteDistributedRunIds: [],
            wouldDeleteFleetReportIds: [],
        } as ControlRetentionPreview;
        const setup = fixture({ preview: vi.fn(async () => raw) });
        await render({ capability: setup.capability });
        await act(async () => current?.preview());

        expect(current?.state.status).toBe('preview-ready');
        expect(current?.canConfirm).toBe(false);
        await act(async () => current?.confirm());
        expect(setup.api.confirm).not.toHaveBeenCalled();
    });

    it('serializes double preview calls and suppresses a superseded result', async () => {
        const pending = deferred<ControlRetentionPreview>();
        const setup = fixture({ preview: vi.fn(() => pending.promise) });
        await render({ capability: setup.capability });

        let first!: Promise<void>;
        await act(async () => {
            first = current!.preview();
            void current!.preview();
            await Promise.resolve();
        });
        expect(current).toMatchObject({ busy: true, canPreview: false, canConfirm: false });
        expect(setup.load).toHaveBeenCalledTimes(1);
        expect(setup.api.preview).toHaveBeenCalledTimes(1);

        pending.resolve(RAW_PREVIEW);
        await act(async () => first);
        expect(current?.state.status).toBe('preview-ready');
    });

    it('confirms only the exact private preview and awaits one callback before success', async () => {
        const callback = deferred<void>();
        const afterConfirmed = vi.fn(() => callback.promise);
        const setup = fixture();
        await render({ capability: setup.capability });
        await act(async () => current?.preview());

        let confirmation!: Promise<void>;
        await act(async () => {
            confirmation = current!.confirm(afterConfirmed);
            void current!.confirm(afterConfirmed);
            await Promise.resolve();
        });

        expect(setup.load).toHaveBeenCalledTimes(1);
        expect(setup.api.confirm).toHaveBeenCalledTimes(1);
        expect(setup.api.confirm).toHaveBeenCalledWith({
            preview: RAW_PREVIEW,
            signal: expect.any(AbortSignal),
        });
        expect(afterConfirmed).toHaveBeenCalledTimes(1);
        expect(afterConfirmed).toHaveBeenCalledWith(CONFIRMATION, expect.objectContaining({
            current: true,
            wouldDeleteRunIds: ['control-a', 'control-b'],
        }), expect.any(AbortSignal));
        expect(current).toMatchObject({ busy: true, canConfirm: false });

        callback.resolve();
        await act(async () => confirmation);
        expect(current?.state).toMatchObject({
            status: 'succeeded',
            confirmation: CONFIRMATION,
        });
        expect(current?.canConfirm).toBe(false);
    });

    it('maps 409 to drift, preserves only stale consequences, and requires a new preview', async () => {
        const conflict = Object.assign(new Error('Retention plan drifted.'), { status: 409 });
        const setup = fixture({ confirm: vi.fn(async () => { throw conflict; }) });
        await render({ capability: setup.capability });
        await act(async () => current?.preview());
        await act(async () => current?.confirm());

        expect(current?.state).toMatchObject({
            status: 'drift',
            message: 'Retention plan drifted.',
            preview: { current: false },
        });
        expect(current?.canConfirm).toBe(false);
        await act(async () => current?.confirm());
        expect(setup.api.confirm).toHaveBeenCalledTimes(1);
    });

    it('shows non-abort failures and treats callback failure as an error', async () => {
        const previewFailure = fixture({
            preview: vi.fn(async () => { throw new Error('Authorization is unavailable.'); }),
        });
        await render({ capability: previewFailure.capability });
        await act(async () => current?.preview());
        expect(current?.state).toEqual({
            status: 'error',
            message: 'Authorization is unavailable.',
        });
        expect(current?.canConfirm).toBe(false);

        const callbackFailure = fixture();
        await render({ capability: callbackFailure.capability });
        await act(async () => current?.preview());
        await act(async () => current?.confirm(async () => {
            throw new Error('History reconciliation failed.');
        }));
        expect(current?.state).toMatchObject({
            status: 'error',
            message: 'History reconciliation failed.',
            preview: { current: false },
        });
    });

    it('silently resets a current AbortError without exposing it', async () => {
        const setup = fixture({
            preview: vi.fn(async () => {
                throw new DOMException('cancelled', 'AbortError');
            }),
        });
        await render({ capability: setup.capability });
        await act(async () => current?.preview());

        expect(current?.state).toEqual({ status: 'idle' });
        expect(current).toMatchObject({ canPreview: true, canConfirm: false, busy: false });
    });

    it('invalidates synchronously on capability replacement and suppresses late load and preview', async () => {
        const loadPending = deferred<RecipeConsoleControlRetentionApi>();
        const first = fixture();
        first.load.mockImplementation(() => loadPending.promise);
        const second = fixture();
        await render({ capability: first.capability });

        let oldPreview!: Promise<void>;
        await act(async () => {
            oldPreview = current!.preview();
            await Promise.resolve();
        });
        renders = [];
        await render({
            capability: second.capability,
            unavailableReason: 'A new control connection is active.',
        });

        expect(renders[0]?.canConfirm).toBe(false);
        expect(current?.state.status).toBe('unavailable');
        expect(current?.canPreview).toBe(true);
        loadPending.resolve(first.api);
        await act(async () => oldPreview);
        expect(first.api.preview).not.toHaveBeenCalled();
        expect(second.load).not.toHaveBeenCalled();
    });

    it('invalidates a completed preview on capability identity replacement', async () => {
        const first = fixture();
        const secondApi: RecipeConsoleControlRetentionApi = {
            preview: vi.fn(async () => RAW_PREVIEW),
            confirm: vi.fn(async () => CONFIRMATION),
        };
        const secondLoad = vi.fn(async () => secondApi);
        const replacement: RecipeConsoleControlRetentionCapability = {
            generation: first.capability.generation,
            signal: first.capability.signal,
            load: secondLoad,
        };
        await render({ capability: first.capability });
        await act(async () => current?.preview());
        expect(current?.canConfirm).toBe(true);

        renders = [];
        await render({ capability: replacement });

        expect(renders[0]?.state).toMatchObject({
            status: 'unavailable',
            preview: { current: false },
        });
        expect(renders[0]?.canConfirm).toBe(false);
        await act(async () => current?.confirm());
        expect(first.api.confirm).not.toHaveBeenCalled();
        expect(secondApi.confirm).not.toHaveBeenCalled();

        await act(async () => current?.preview());
        expect(secondLoad).toHaveBeenCalledTimes(1);
        expect(secondApi.preview).toHaveBeenCalledTimes(1);
        expect(current?.canConfirm).toBe(true);
    });

    it('aborts in-flight work on signal/context drift and never calls back after drift', async () => {
        const confirmation = deferred<ControlRetentionConfirmation>();
        const afterConfirmed = vi.fn();
        const first = fixture({ confirm: vi.fn(() => confirmation.promise) });
        const second = fixture();
        await render({ capability: first.capability });
        await act(async () => current?.preview());

        let pending!: Promise<void>;
        await act(async () => {
            pending = current!.confirm(afterConfirmed);
            await Promise.resolve();
        });
        const signal = vi.mocked(first.api.confirm).mock.calls[0][0].signal;
        await render({ capability: second.capability });
        expect(signal?.aborted).toBe(true);
        expect(current?.state).toMatchObject({
            status: 'unavailable',
            preview: { current: false },
        });

        confirmation.resolve(CONFIRMATION);
        await act(async () => pending);
        expect(afterConfirmed).not.toHaveBeenCalled();
        expect(current?.state.status).toBe('unavailable');
    });

    it('aborts an in-progress reconciliation callback on context drift', async () => {
        const reconciliation = deferred<void>();
        const sideEffect = vi.fn();
        const afterConfirmed = vi.fn(async (
            _confirmation: ControlRetentionConfirmation,
            _preview: unknown,
            signal: AbortSignal,
        ) => {
            await reconciliation.promise;
            if (!signal.aborted) sideEffect();
        });
        const first = fixture();
        const second = fixture();
        await render({ capability: first.capability });
        await act(async () => current?.preview());

        let pending!: Promise<void>;
        await act(async () => {
            pending = current!.confirm(afterConfirmed);
            await vi.waitFor(() => expect(afterConfirmed).toHaveBeenCalledTimes(1));
        });
        const callbackSignal = afterConfirmed.mock.calls[0][2];
        await render({ capability: second.capability });

        expect(callbackSignal.aborted).toBe(true);
        reconciliation.resolve();
        await act(async () => pending);
        expect(sideEffect).not.toHaveBeenCalled();
        expect(current?.state.status).toBe('unavailable');
    });

    it('shows unavailable reasons, reacts to capability abort, and remounts empty', async () => {
        await render({ unavailableReason: 'Operator authorization is required.' });
        expect(current?.state).toEqual({
            status: 'unavailable',
            message: 'Operator authorization is required.',
        });
        expect(current).toMatchObject({ canPreview: false, canConfirm: false, busy: false });

        const setup = fixture();
        await render({ capability: setup.capability });
        await act(async () => current?.preview());
        await act(async () => setup.lifetime.abort());
        expect(current?.state).toMatchObject({
            status: 'unavailable',
            preview: { current: false },
        });
        expect(current?.canPreview).toBe(false);

        await act(async () => root.unmount());
        root = createRoot(container);
        current = undefined;
        await render({ capability: fixture().capability });
        expect(current?.state).toEqual({ status: 'idle' });
    });
});
