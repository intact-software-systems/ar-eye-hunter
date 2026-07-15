import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    createContext,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
    type ReactNode,
} from 'react';
import {
    createBrowserAgentLaunchService,
    type BrowserAgentLaunchService,
} from '../../browser-agent-launch-service.ts';
import { controlWebSocketUrlFromHttpBaseUrl } from '../../runner-agent-launch.ts';
import {
    createRecipeConsoleControlApi,
    type RecipeConsoleControlApi,
    type RecipeConsoleControlFleetCapability,
    type RecipeConsoleControlQueryProvenance,
    type RecipeConsoleControlRetentionCapability,
} from './control-api.ts';
import {
    createControlQueryService,
    type ControlQueryAuthorization,
    type ControlQuerySnapshot,
} from './control-query.ts';
import type { RecipeConsoleControlCredentialPolicy } from './control-credential-policy.ts';
import type { RecipeConsoleControlExecutionApi } from './control-execution-api.ts';
import {
    controlSelectionIndexCacheLastLookup,
    createControlSelectionIndexCache,
    type ControlSnapshotSelectionIndex,
    type ControlSelectionIndexCacheLookupWork,
} from './control-selection-index-cache.ts';

export const CONTROL_QUERY_POLL_INTERVAL_MS = 5_000;
export const CONTROL_QUERY_REQUEST_TIMEOUT_MS = 4_000;

export type RecipeConsoleControlBootstrap = Readonly<{
    controlUrl?: string;
    bootstrapRunId?: string;
    apiBaseUrl: string;
    providerMode: RallarBlackBoxProviderMode;
    manualToken?: string;
    credentialPolicy: RecipeConsoleControlCredentialPolicy;
    bootstrapGroup: RallarBlackBoxDistributedGroupRef;
}>;

export type RecipeConsoleControlContext = Readonly<Pick<
    RecipeConsoleControlBootstrap,
    'bootstrapRunId' | 'apiBaseUrl' | 'providerMode' | 'bootstrapGroup'
>>;

export type RecipeConsoleControlConnection = Readonly<{
    bootstrap: RecipeConsoleControlContext;
    baseUrl: string;
    browserAgentLaunch: BrowserAgentLaunchService | undefined;
    browserAgentLaunchIssue?: string;
    execution: RecipeConsoleControlExecutionApi | undefined;
    retention: RecipeConsoleControlRetentionCapability | undefined;
    fleet: RecipeConsoleControlFleetCapability | undefined;
    query: ControlQuerySnapshot<
        ControlServerSnapshot,
        RecipeConsoleControlQueryProvenance
    >;
    selectionIndex?: ControlSnapshotSelectionIndex;
    selectionIndexWork?: ControlSelectionIndexCacheLookupWork;
    refresh(): Promise<void>;
    refreshAfterCurrent(): Promise<void>;
}>;

const ControlConnectionContext = createContext<
    RecipeConsoleControlConnection | undefined
>(undefined);

type ControlApiSetup =
    | Readonly<{ api: RecipeConsoleControlApi; error?: never }>
    | Readonly<{ api?: never; error: unknown }>;

const browserScheduler = {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
        return globalThis.setTimeout(callback, delayMs);
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>): void {
        globalThis.clearTimeout(handle);
    },
};

export function ControlConnectionProvider({
    authSession,
    bootstrap,
    children,
}: Readonly<{
    authSession?: AuthSession;
    bootstrap: RecipeConsoleControlBootstrap;
    children: ReactNode;
}>) {
    const apiSetup = useMemo<ControlApiSetup>(() => {
        try {
            return {
                api: createRecipeConsoleControlApi({
                    controlUrl: bootstrap.controlUrl,
                    manualToken: bootstrap.manualToken,
                    apiBaseUrl: bootstrap.apiBaseUrl,
                    authSession,
                    credentialPolicy: bootstrap.credentialPolicy,
                }),
            };
        } catch (error) {
            return { error };
        }
    }, [
        authSession,
        bootstrap.apiBaseUrl,
        bootstrap.controlUrl,
        bootstrap.credentialPolicy,
        bootstrap.manualToken,
    ]);
    const publicBootstrap = useMemo<RecipeConsoleControlContext>(() => ({
        bootstrapRunId: bootstrap.bootstrapRunId,
        apiBaseUrl: bootstrap.apiBaseUrl,
        providerMode: bootstrap.providerMode,
        bootstrapGroup: bootstrap.bootstrapGroup,
    }), [
        bootstrap.apiBaseUrl,
        bootstrap.bootstrapGroup,
        bootstrap.bootstrapRunId,
        bootstrap.providerMode,
    ]);
    const browserAgentLaunchIssue = bootstrap.providerMode !== 'browser-rallar'
        ? undefined
        : bootstrap.credentialPolicy.apiBaseUrlFromLocation
        ? 'Use a configured API endpoint before launching browser-rallar agents. Stored operator credentials are blocked for a URL-configured API origin.'
        : !authSession
        ? 'Log in before launching browser-rallar agents. Fresh per-agent sessions require an authenticated operator.'
        : undefined;
    const browserAgentLaunch = useMemo(() => apiSetup.api && !browserAgentLaunchIssue
        ? createBrowserAgentLaunchService({
            origin: globalThis.location?.origin ?? 'http://localhost:5176',
            providerMode: bootstrap.providerMode,
            controlWsUrl: controlWebSocketUrlFromHttpBaseUrl(apiSetup.api.baseUrl),
            apiBaseUrl: bootstrap.apiBaseUrl,
            authSession,
            issueRunToken: apiSetup.api.agentLaunch.issueRunToken,
        })
        : undefined, [
        apiSetup,
        authSession,
        bootstrap.apiBaseUrl,
        bootstrap.providerMode,
        browserAgentLaunchIssue,
    ]);
    const service = useMemo(() => createControlQueryService({
        query: async ({ signal }) => {
            if (!apiSetup.api) {
                throw apiSetup.error;
            }
            const result = await apiSetup.api.readSnapshot({ signal });
            return {
                completeness: result.completeness,
                snapshot: result.snapshot,
                provenance: {
                    distributedRunsSource: result.distributedRunsSource,
                },
                authorization: partialQueryAuthorization(result.partialError),
            };
        },
        now: Date.now,
        scheduler: browserScheduler,
        pollIntervalMs: CONTROL_QUERY_POLL_INTERVAL_MS,
        requestTimeoutMs: CONTROL_QUERY_REQUEST_TIMEOUT_MS,
    }), [apiSetup]);
    const query = useSyncExternalStore(
        service.subscribe,
        service.getSnapshot,
        service.getSnapshot,
    );
    const selectionIndexCache = useMemo(
        () => createControlSelectionIndexCache(),
        [apiSetup],
    );
    const selectionProjection = useMemo(() => {
        const snapshot = query.snapshot;
        if (!snapshot) return undefined;
        const selectionIndex = selectionIndexCache.get(snapshot);
        return Object.freeze({
            selectionIndex,
            selectionIndexWork:
                controlSelectionIndexCacheLastLookup(selectionIndexCache),
        });
    }, [query.snapshot, selectionIndexCache]);

    const apiLifetime = useRef<Readonly<{
        api: RecipeConsoleControlApi | undefined;
        token: object;
    }> | undefined>(undefined);
    useLayoutEffect(() => {
        const previous = apiLifetime.current;
        if (previous?.api && previous.api !== apiSetup.api) {
            previous.api.close();
        }
        const token = {};
        const current = { api: apiSetup.api, token };
        apiLifetime.current = current;
        return () => queueMicrotask(() => {
            const active = apiLifetime.current;
            // React StrictMode replays effects with the same memoized API.
            // Close only after a real replacement or unmount, never that replay.
            if (active?.token === token || active?.api !== current.api) {
                current.api?.close();
            }
        });
    }, [apiSetup]);

    useEffect(() => {
        let cancelled = false;
        queueMicrotask(() => {
            if (!cancelled) {
                service.start();
            }
        });
        return () => {
            cancelled = true;
            service.stop();
        };
    }, [service]);

    const value = useMemo<RecipeConsoleControlConnection>(() => ({
        bootstrap: publicBootstrap,
        baseUrl: apiSetup.api?.baseUrl ?? 'Invalid control URL',
        browserAgentLaunch,
        browserAgentLaunchIssue,
        execution: apiSetup.api?.execution,
        retention: apiSetup.api?.retention,
        fleet: apiSetup.api?.fleet,
        query,
        selectionIndex: selectionProjection?.selectionIndex,
        selectionIndexWork: selectionProjection?.selectionIndexWork,
        refresh: service.refresh,
        refreshAfterCurrent: service.refreshAfterCurrent,
    }), [
        apiSetup,
        browserAgentLaunch,
        browserAgentLaunchIssue,
        publicBootstrap,
        query,
        selectionProjection,
        service.refresh,
    ]);

    return (
        <ControlConnectionContext.Provider value={value}>
            {children}
        </ControlConnectionContext.Provider>
    );
}

function partialQueryAuthorization(
    error: unknown,
): ControlQueryAuthorization {
    const record = error && typeof error === 'object'
        ? error as Record<string, unknown>
        : undefined;
    if (record?.authorizationRequired === true) {
        return 'required';
    }
    const status = typeof record?.status === 'number'
        ? record.status
        : record?.controlStatus;
    return status === 401 || status === 403 ? 'required' : 'ready';
}

export function useControlConnection(): RecipeConsoleControlConnection {
    const value = useContext(ControlConnectionContext);
    if (!value) {
        throw new Error('Recipe Console control connection provider is missing.');
    }
    return value;
}
