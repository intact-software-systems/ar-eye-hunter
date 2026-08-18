// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    ControlConnectionProvider,
    type RecipeConsoleControlConnection,
} from '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import { TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-credential-policy.ts';
import { useRecipeConsoleControlWorkspace } from
    '../../../apps/rallar-black-box/src/recipe-console/control/use-control-workspace.ts';
import type { RecipeConsoleControlSelection } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-selection.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Observation = Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
}>;

type Deferred<Value> = Readonly<{
    promise: Promise<Value>;
    resolve(value: Value): void;
}>;

function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>(onResolve => {
        resolve = onResolve;
    });
    return { promise, resolve };
}

function snapshot(status = 'connected'): ControlServerSnapshot {
    const runId = 'control-a';
    const agentId = 'agent-a';
    const run: ControlRunSnapshot = {
        runId,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        agents: [{
            runId,
            agentId,
            connected: true,
            status,
            lastHeartbeatAtEpochMs: 2,
            identity: {
                principalId: 'principal-a',
                sessionId: 'session-a',
                applicationId: 'app-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a',
            },
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: [],
        }],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
    return { runs: [run], distributedRuns: [] };
}

describe('Recipe Console indexed provider projection', () => {
    let container: HTMLDivElement;
    let root: Root;
    let observed: Observation | undefined;
    let pending: Deferred<Response> | undefined;
    let nextDocument: string;

    function Harness() {
        const workspace = useRecipeConsoleControlWorkspace({
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'monitor',
                controlRunId: 'control-a',
                agentId: 'agent-a',
            },
            navigate: vi.fn(),
            replace: vi.fn(),
        });
        observed = {
            connection: workspace.connection,
            selection: workspace.selection,
        };
        return null;
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        observed = undefined;
        pending = undefined;
        nextDocument = JSON.stringify(snapshot());
        vi.stubGlobal('fetch', vi.fn(async () => {
            if (pending) return pending.promise;
            return new Response(nextDocument, {
                headers: { 'content-type': 'application/json' },
            });
        }));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('skips attempt-start derivation, hits exact revisions, and rebuilds deep changes', async () => {
        await act(async () => root.render(createElement(
            ControlConnectionProvider,
            {
                bootstrap: {
                    controlUrl: 'https://control.test',
                    apiBaseUrl: 'https://api.test',
                    providerMode: 'browser-rallar',
                    credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
                    bootstrapGroup: {
                        applicationId: 'app-a',
                        workspaceId: 'workspace-a',
                        groupId: 'group-a',
                    },
                },
                children: createElement(Harness),
            },
        )));
        await vi.waitFor(() => expect(observed?.connection.query.status).toBe('live'));

        const firstIndex = observed!.connection.selectionIndex;
        const firstSelection = observed!.selection;
        const firstRows = observed!.selection.boardRows;
        expect(firstIndex).toBeDefined();
        expect(observed!.connection.selectionIndexWork).toMatchObject({
            cacheHit: false,
            indexBuildCount: 1,
        });
        expect(Object.isFrozen(observed!.connection.selectionIndexWork)).toBe(true);

        pending = deferred<Response>();
        let refresh!: Promise<void>;
        await act(async () => {
            refresh = observed!.connection.refresh();
            await vi.waitFor(() =>
                expect(observed!.connection.query.isRefreshing).toBe(true)
            );
        });
        expect(observed!.selection).toBe(firstSelection);
        expect(observed!.selection.boardRows).toBe(firstRows);

        const sameRaw = nextDocument;
        const response = new Response(sameRaw, {
            headers: { 'content-type': 'application/json' },
        });
        const active = pending;
        pending = undefined;
        active.resolve(response);
        await act(async () => refresh);

        expect(observed!.connection.selectionIndex).toBe(firstIndex);
        expect(observed!.connection.selectionIndexWork).toEqual({
            cacheHit: true,
            indexBuildCount: 0,
            controlRunVisitCount: 0,
            distributedRunVisitCount: 0,
            selectionIndexLoopVisitCount: 0,
        });
        expect(observed!.selection.controlRun)
            .toBe(observed!.connection.query.snapshot!.runs[0]);
        expect(observed!.selection.agent)
            .toBe(observed!.connection.query.snapshot!.runs[0]!.agents[0]);
        expect(observed!.selection.boardRows[0]!.identity)
            .toBe(observed!.connection.query.snapshot!.runs[0]!.agents[0]!.identity);

        nextDocument = JSON.stringify(snapshot('deep-change-with-same-id-and-time'));
        await act(async () => observed!.connection.refresh());
        expect(observed!.connection.selectionIndex).not.toBe(firstIndex);
        expect(observed!.connection.selectionIndexWork).toMatchObject({
            cacheHit: false,
            indexBuildCount: 1,
        });
    });
});
