import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useSyncExternalStore,
    type ReactNode,
} from 'react';
import {
    createRecipeConsoleControlApi,
    type RecipeConsoleControlApi,
} from './control-api.ts';
import {
    createControlQueryService,
    type ControlQueryAuthorization,
    type ControlQuerySnapshot,
} from './control-query.ts';
import type { RecipeConsoleControlCredentialPolicy } from './control-credential-policy.ts';
import type { RecipeConsoleControlExecutionApi } from './control-execution-api.ts';

export const CONTROL_QUERY_POLL_INTERVAL_MS = 5_000;
export const CONTROL_QUERY_REQUEST_TIMEOUT_MS = 4_000;

export type RecipeConsoleControlBootstrap = Readonly<{
    controlUrl?: string;
    bootstrapRunId?: string;
    apiBaseUrl: string;
    manualToken?: string;
    credentialPolicy: RecipeConsoleControlCredentialPolicy;
    bootstrapGroup: RallarBlackBoxDistributedGroupRef;
}>;

export type RecipeConsoleControlConnection = Readonly<{
    bootstrap: RecipeConsoleControlBootstrap;
    baseUrl: string;
    execution: RecipeConsoleControlExecutionApi | undefined;
    query: ControlQuerySnapshot<ControlServerSnapshot>;
    refresh(): Promise<void>;
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
    const service = useMemo(() => createControlQueryService({
        query: async ({ signal }) => {
            if (!apiSetup.api) {
                throw apiSetup.error;
            }
            const result = await apiSetup.api.readSnapshot({ signal });
            return {
                completeness: result.completeness,
                snapshot: result.snapshot,
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
        bootstrap,
        baseUrl: apiSetup.api?.baseUrl ?? 'Invalid control URL',
        execution: apiSetup.api?.execution,
        query,
        refresh: service.refresh,
    }), [apiSetup, bootstrap, query, service.refresh]);

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
