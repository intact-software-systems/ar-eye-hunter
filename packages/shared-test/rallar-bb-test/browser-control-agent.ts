import { createRallarBlackBoxBrowserTestRuntime } from './browser-adapter.ts';
import { createRallarBlackBoxTestRuntime } from './runtime.ts';
import type {
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestState,
} from './types.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    remoteControlConfig,
    resolveRallarBlackBoxBootstrapConfig,
    validateRallarBlackBoxProviderConfig,
} from './browser-control-agent-config.ts';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge,
} from './browser-rallar-runtime-bridge.ts';
import {
    RallarBlackBoxControlClient,
    type RallarBlackBoxControlSnapshot,
} from './control-client.ts';

export type BrowserControlAgentRunState =
    | 'waiting'
    | 'running'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'reset';

export type RallarBlackBoxBrowserControlAgentSnapshot = Readonly<{
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
    bootstrap: RallarBlackBoxBootstrapConfig;
    bootstrapping: boolean;
    busy: boolean;
    runState: BrowserControlAgentRunState;
    lastAction?: string;
    lastError?: string;
}>;

export type RallarBlackBoxBrowserControlAgent = Readonly<{
    getSnapshot(): RallarBlackBoxBrowserControlAgentSnapshot;
    subscribe(listener: () => void): () => void;
    start(): Promise<void>;
    dispose(): void;
    recordStatus(message: string): void;
}>;

export type CreateRallarBlackBoxBrowserControlAgentOptions = Readonly<{
    search?: string;
    env?: Readonly<Record<string, string | undefined>>;
}>;

type RuntimeWithBridge = Readonly<{
    runtime: RallarBlackBoxTestRuntime;
    disposeBridge?: () => void;
}>;

type BrowserControlAgentListener = () => void;

export function initialControlSnapshot(
    bootstrap: RallarBlackBoxBootstrapConfig,
): RallarBlackBoxControlSnapshot {
    return {
        state: 'idle',
        url: bootstrap.controlUrl,
        reconnectAttempt: 0,
        sentCount: 0,
        receivedCount: 0,
    };
}

function toMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (error && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
    }

    return String(error);
}

function runStateForStatus(
    status: RallarBlackBoxTestRuntimeStatus,
    fallback: BrowserControlAgentRunState,
): BrowserControlAgentRunState {
    switch (status) {
        case 'idle':
            return fallback;
        case 'running':
            return 'running';
        case 'completed':
            return 'passed';
        case 'failed':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
        case 'configured':
        case 'loaded':
            return 'waiting';
        default:
            return fallback;
    }
}

function createRuntimeForBootstrap(
    bootstrap: RallarBlackBoxBootstrapConfig,
): RuntimeWithBridge {
    if (bootstrap.providerMode === 'browser-rallar' && typeof window !== 'undefined') {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createSpaBrowserRallarRuntime(),
            fetch: globalThis.fetch?.bind(globalThis) as typeof fetch | undefined,
            webSocketFactory: createBrowserWebSocketFactory(),
        });
        return {
            runtime,
            disposeBridge: installSpaBrowserRallarEventBridge(runtime),
        };
    }

    return {
        runtime: createRallarBlackBoxTestRuntime(),
    };
}

function recordAndThrowProviderConfigError(
    runtime: RallarBlackBoxTestRuntime,
    config: ReturnType<typeof remoteControlConfig>,
): void {
    const configError = validateRallarBlackBoxProviderConfig(config);
    if (!configError) {
        return;
    }

    runtime.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.bb.provider.browser_rallar.config_invalid',
        severity: 'error',
        payload: configError,
    });
    throw new Error(configError.message);
}

export function createRallarBlackBoxBrowserControlAgent(
    options: CreateRallarBlackBoxBrowserControlAgentOptions = {},
): RallarBlackBoxBrowserControlAgent {
    const bootstrap = resolveRallarBlackBoxBootstrapConfig(options.search, options.env);
    const { runtime, disposeBridge } = createRuntimeForBootstrap(bootstrap);
    const listeners = new Set<BrowserControlAgentListener>();
    let disposed = false;
    let snapshot: RallarBlackBoxBrowserControlAgentSnapshot = {
        state: runtime.state(),
        control: initialControlSnapshot(bootstrap),
        bootstrap,
        bootstrapping: false,
        busy: false,
        runState: 'waiting',
    };

    const emit = () => {
        listeners.forEach(listener => listener());
    };
    const assertNotDisposed = () => {
        if (disposed) {
            throw new Error('Browser control agent is disposed.');
        }
    };

    const controlClient = new RallarBlackBoxControlClient({
        runtime,
        token: bootstrap.controlToken,
        heartbeatIntervalMs: bootstrap.heartbeatIntervalMs,
        statsIntervalMs: bootstrap.statsIntervalMs,
        finalReportUploadUrl: bootstrap.finalReportUploadUrl,
        onSnapshot: control => {
            snapshot = {
                ...snapshot,
                control,
            };
            emit();
        },
    });

    const unsubscribeRuntime = runtime.subscribe(state => {
        snapshot = {
            ...snapshot,
            state,
            runState: runStateForStatus(state.status, snapshot.runState),
        };
        emit();
    });

    return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async start() {
            assertNotDisposed();
            const config = remoteControlConfig(bootstrap, 1);
            snapshot = {
                ...snapshot,
                bootstrapping: true,
                busy: true,
                runState: 'waiting',
                lastAction: 'Bootstrapping remote control agent',
                lastError: undefined,
            };
            emit();

            try {
                await runtime.execute({
                    kind: 'reset',
                    commandId: 'reset-control-1',
                });
                assertNotDisposed();
                await runtime.execute({
                    kind: 'configure',
                    commandId: 'configure-control-1',
                    config,
                });
                assertNotDisposed();
                recordAndThrowProviderConfigError(runtime, config);

                snapshot = {
                    ...snapshot,
                    bootstrapping: false,
                    busy: false,
                    runState: 'waiting',
                    lastAction: bootstrap.autoConnect
                        ? 'Remote control agent configured; connecting'
                        : 'Remote control agent configured',
                    lastError: undefined,
                };
                emit();

                if (bootstrap.autoConnect) {
                    assertNotDisposed();
                    controlClient.connect({
                        url: bootstrap.controlUrl,
                        runId: config.runId ?? bootstrap.runId,
                        agentId: bootstrap.agentId,
                        token: bootstrap.controlToken,
                    });
                }
            } catch (error) {
                if (disposed) {
                    throw error;
                }

                snapshot = {
                    ...snapshot,
                    bootstrapping: false,
                    busy: false,
                    runState: 'failed',
                    lastAction: 'Remote control bootstrap failed',
                    lastError: toMessage(error),
                };
                emit();
                throw error;
            }
        },
        dispose() {
            if (disposed) {
                return;
            }

            disposed = true;
            controlClient.dispose();
            unsubscribeRuntime();
            disposeBridge?.();
            listeners.clear();
        },
        recordStatus(message) {
            snapshot = {
                ...snapshot,
                lastAction: message,
            };
            emit();
        },
    };
}
