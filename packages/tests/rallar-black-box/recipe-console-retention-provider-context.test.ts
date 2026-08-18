// @vitest-environment happy-dom
import type { AuthSession } from '@shared/api/api-config.ts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ControlConnectionProvider,
    type RecipeConsoleControlBootstrap,
    useControlConnection,
} from '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import {
    recipeConsoleControlCredentialPolicyFromSearch,
    TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-credential-policy.ts';
import {
    useRetentionCleanup,
    type RetentionCleanupController,
} from '../../../apps/rallar-black-box/src/recipe-console/history/use-retention-cleanup.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIEW = {
    deletedRunIds: [],
    retainedRuns: 2,
    maxRuns: 1,
    dryRun: true,
    wouldDeleteRuns: [{
        runId: 'context-old',
        createdAtEpochMs: 10,
        updatedAtEpochMs: 20,
        connectedAgentCount: 0,
        issuedRunTokenCount: 0,
        distributedRuns: [],
        fleetReportIds: [],
    }],
    wouldDeleteRunIds: ['context-old'],
    wouldDeleteDistributedRunIds: [],
    wouldDeleteFleetReportIds: [],
    projectedRetainedRuns: 1,
    preserves: { connectedAgentSockets: true, storedArtifactFiles: true },
    planToken: 'provider-context-token',
} as const;

const BOOTSTRAP: RecipeConsoleControlBootstrap = {
    controlUrl: 'https://control-a.test/control',
    apiBaseUrl: 'https://api-a.test',
    providerMode: 'browser-rallar',
    credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
    bootstrapGroup: {
        applicationId: 'app-a',
        workspaceId: 'workspace-a',
        groupId: 'group-a',
    },
};

type ProviderInput = Readonly<{
    bootstrap: RecipeConsoleControlBootstrap;
    authSession?: AuthSession;
}>;

const CONTEXT_CHANGES: readonly Readonly<{
    label: string;
    next(input: ProviderInput): ProviderInput;
}>[] = [{
    label: 'control endpoint',
    next: input => ({
        ...input,
        bootstrap: { ...input.bootstrap, controlUrl: 'https://control-b.test' },
    }),
}, {
    label: 'API base URL',
    next: input => ({
        ...input,
        bootstrap: { ...input.bootstrap, apiBaseUrl: 'https://api-b.test' },
    }),
}, {
    label: 'credential origin',
    next: input => ({
        ...input,
        bootstrap: {
            ...input.bootstrap,
            credentialPolicy: recipeConsoleControlCredentialPolicyFromSearch(
                '?controlUrl=https%3A%2F%2Fcontrol-a.test',
            ),
        },
    }),
}, {
    label: 'connection generation',
    next: input => ({ ...input, authSession: session('operator-b') }),
}];

type Observation = Readonly<{
    capability: NonNullable<ReturnType<typeof useControlConnection>['retention']>;
    cleanup: RetentionCleanupController;
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

function session(clientId: string): AuthSession {
    return {
        clientId,
        sessionId: `session-${clientId}`,
        username: clientId,
        accessToken: `access-${clientId}`,
        expiresAtEpochMs: 4_000_000_000_000,
    };
}

describe('retention provider context authority', () => {
    let container: HTMLDivElement;
    let root: Root;
    let observed: Observation | undefined;
    let retentionRequests: URL[];
    let pendingPreview: Deferred<Response> | undefined;

    function Harness() {
        const connection = useControlConnection();
        const cleanup = useRetentionCleanup({ capability: connection.retention });
        if (!connection.retention) throw new Error('Missing retention capability.');
        observed = {
            capability: connection.retention,
            cleanup,
        };
        return null;
    }

    async function render(input: ProviderInput): Promise<void> {
        await act(async () => root.render(createElement(
            ControlConnectionProvider,
            { ...input, children: createElement(Harness) },
        )));
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        observed = undefined;
        retentionRequests = [];
        pendingPreview = undefined;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/retention/cleanup') {
                retentionRequests.push(url);
                if (pendingPreview) return pendingPreview.promise;
                return Response.json(PREVIEW);
            }
            return Response.json({ runs: [], distributedRuns: [] });
        }));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each(CONTEXT_CHANGES)(
        'aborts a pending preview when $label changes',
        async context => {
            const initial = { bootstrap: BOOTSTRAP };
            pendingPreview = deferred<Response>();
            await render(initial);
            const previous = observed!.capability;
            let preview!: Promise<void>;
            await act(async () => {
                preview = observed!.cleanup.preview();
                await vi.waitFor(() => expect(retentionRequests).toHaveLength(1));
            });

            await render(context.next(initial));

            expect(previous.signal.aborted).toBe(true);
            expect(observed!.capability.generation).not.toBe(previous.generation);
            expect(observed!.cleanup.canConfirm).toBe(false);
            expect(observed!.cleanup.state.status).toBe('unavailable');
            pendingPreview.resolve(Response.json(PREVIEW));
            await act(async () => preview);
            await act(async () => observed!.cleanup.confirm());
            expect(retentionRequests.filter(url => url.searchParams.has('planToken')))
                .toHaveLength(0);
        },
    );

    it.each(CONTEXT_CHANGES)(
        'makes a completed preview stale when $label changes',
        async context => {
            const initial = { bootstrap: BOOTSTRAP };
            await render(initial);
            const previous = observed!.capability;
            await act(async () => observed!.cleanup.preview());
            expect(observed!.cleanup.canConfirm).toBe(true);

            await render(context.next(initial));

            expect(previous.signal.aborted).toBe(true);
            expect(observed!.capability.generation).not.toBe(previous.generation);
            expect(observed!.cleanup.state).toMatchObject({
                status: 'unavailable',
                preview: { current: false },
            });
            expect(observed!.cleanup.canConfirm).toBe(false);
            await act(async () => observed!.cleanup.confirm());
            expect(retentionRequests.filter(url => url.searchParams.has('planToken')))
                .toHaveLength(0);

            await act(async () => observed!.cleanup.preview());
            expect(observed!.cleanup.state.status).toBe('preview-ready');
            expect(observed!.cleanup.canConfirm).toBe(true);
            expect(retentionRequests.filter(url => url.searchParams.has('dryRun')))
                .toHaveLength(2);
        },
    );
});
