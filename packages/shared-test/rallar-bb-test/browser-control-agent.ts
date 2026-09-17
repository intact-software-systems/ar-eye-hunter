import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { takeAgentResumeRecord } from './alm/browser-control-agent-resume.ts';
import {
    resolveRallarBlackBoxBootstrapConfig,
    type RallarBlackBoxBootstrapConfig,
    type RallarBlackBoxBootstrapEnvironment
} from './browser-control-agent-config.ts';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge
} from './browser-rallar-runtime-bridge.ts';
import {
    createDefaultRallarBlackBoxControlClient,
    type RallarBlackBoxControlClient,
    type RallarBlackBoxControlSnapshot
} from './control-client.ts';
import { createRallarBlackBoxBrowserTestRuntime } from './create-rallar-black-box-browser-test-runtime.ts';
import type {
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestState
} from './rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from './runtime/create-rallar-black-box-test-runtime.ts';
import { readBrowserAuthSessionPresence, toRemoteControlConfig } from './to-remote-control-config.ts';
import { validateRallarBlackBoxProviderConfig } from './validate-rallar-black-box-provider-config.ts';

export type BrowserControlAgentRunState =
    | 'waiting'
    | 'running'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'reset';

/** Where a successful start leaves the agent: configured, and connecting when the bootstrap asks to auto-connect. */
export type BrowserControlAgentStartOutcome = 'configured' | 'connecting';

export interface RallarBlackBoxBrowserControlAgentSnapshot {
    readonly state: RallarBlackBoxTestState;
    readonly control: RallarBlackBoxControlSnapshot;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly bootstrapping: boolean;
    readonly busy: boolean;
    readonly runState: BrowserControlAgentRunState;
    /** Absent before the agent records an action. */
    readonly lastAction?: string;
    /** Absent while the agent carries no bootstrap failure. */
    readonly lastError?: string;
}

export interface RallarBlackBoxBrowserControlAgent {
    getSnapshot(): RallarBlackBoxBrowserControlAgentSnapshot;
    subscribe(listener: () => void): () => void;
    start(): Promise<Either<string, BrowserControlAgentStartOutcome>>;
    dispose(): void;
    recordStatus(message: string): void;
}

export interface CreateRallarBlackBoxBrowserControlAgentOptions {
    readonly search: string;
    readonly env: RallarBlackBoxBootstrapEnvironment;
    readonly hash: string;
}

interface BrowserControlAgentRuntime {
    readonly runtime: RallarBlackBoxTestRuntime;
    /** Absent when the simulated runtime installs no page event bridge. */
    readonly disposeBridge?: () => void;
}

const DISPOSED_AGENT_FAILURE = 'Browser control agent is disposed.';

export function createRallarBlackBoxBrowserControlAgent(
    options: CreateRallarBlackBoxBrowserControlAgentOptions
): RallarBlackBoxBrowserControlAgent {
    const bootstrap = resolveRallarBlackBoxBootstrapConfig(options.search, options.env, options.hash);
    return new BrowserControlAgent(bootstrap, createAgentRuntime(bootstrap));
}

export function toInitialControlSnapshot(bootstrap: RallarBlackBoxBootstrapConfig): RallarBlackBoxControlSnapshot {
    return {
        state: 'idle',
        url: bootstrap.controlUrl,
        reconnectAttempt: 0,
        sentCount: 0,
        receivedCount: 0
    };
}

class BrowserControlAgent implements RallarBlackBoxBrowserControlAgent {
    private readonly bootstrap: RallarBlackBoxBootstrapConfig;
    private readonly agentRuntime: BrowserControlAgentRuntime;
    private readonly controlClient: RallarBlackBoxControlClient;
    private readonly unsubscribeRuntime: () => void;
    private readonly listeners = new Set<() => void>();
    private disposed = false;
    private snapshot: RallarBlackBoxBrowserControlAgentSnapshot;

    constructor(bootstrap: RallarBlackBoxBootstrapConfig, agentRuntime: BrowserControlAgentRuntime) {
        this.bootstrap = bootstrap;
        this.agentRuntime = agentRuntime;
        this.snapshot = {
            state: agentRuntime.runtime.state(),
            control: toInitialControlSnapshot(bootstrap),
            bootstrap,
            bootstrapping: false,
            busy: false,
            runState: 'waiting'
        };
        this.controlClient = createDefaultRallarBlackBoxControlClient({
            runtime: agentRuntime.runtime,
            heartbeatIntervalMs: bootstrap.heartbeatIntervalMs,
            statsIntervalMs: bootstrap.statsIntervalMs,
            onSnapshot: (control) => this.setSnapshot({ control })
        });
        this.unsubscribeRuntime = agentRuntime.runtime.subscribe((state) => {
            this.setSnapshot({ state, runState: toRunState(state.status, this.snapshot.runState) });
        });
    }

    getSnapshot(): RallarBlackBoxBrowserControlAgentSnapshot {
        return this.snapshot;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** A disposal while the bootstrap commands run ends the start without touching the snapshot. */
    async start(): Promise<Either<string, BrowserControlAgentStartOutcome>> {
        if (this.disposed) {
            return Either.ofLeft(DISPOSED_AGENT_FAILURE);
        }

        const config = toRemoteControlConfig({
            bootstrap: this.bootstrap,
            runNumber: 1,
            hasStoredAuthSession: readBrowserAuthSessionPresence()
        });
        const runId = config.runId ?? this.bootstrap.runId;
        const completedCommandIds = takeAgentResumeRecord(runId, this.bootstrap.agentId)?.completedCommandIds ?? [];
        this.setSnapshot({
            bootstrapping: true,
            busy: true,
            runState: 'waiting',
            lastAction: 'Bootstrapping remote control agent',
            lastError: undefined
        });

        const configured = await this.configureRuntime(config);
        if (this.disposed) {
            return Either.ofLeft(DISPOSED_AGENT_FAILURE);
        }
        return configured.flatMap(
            (failure) => this.recordBootstrapFailure(failure),
            () => Either.ofRight(this.connectConfiguredAgent(runId, completedCommandIds))
        );
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.controlClient.dispose();
        this.unsubscribeRuntime();
        this.agentRuntime.disposeBridge?.();
        this.listeners.clear();
    }

    recordStatus(message: string): void {
        this.setSnapshot({ lastAction: message });
    }

    private async configureRuntime(
        config: RallarBlackBoxTestConfig
    ): Promise<Either<string, RallarBlackBoxTestConfig>> {
        const { runtime } = this.agentRuntime;
        try {
            await runtime.execute({ kind: 'reset', commandId: 'reset-control-1' });
            if (!this.disposed) {
                await runtime.execute({ kind: 'configure', commandId: 'configure-control-1', config });
            }
        }
        catch (caught) {
            return Either.ofLeft(toError(caught).message);
        }

        const [configError] = validateRallarBlackBoxProviderConfig(config);
        if (configError && !this.disposed) {
            runtime.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.provider.browser_rallar.config_invalid',
                severity: 'error',
                payload: configError
            });
        }
        return configError ? Either.ofLeft(configError.message) : Either.ofRight(config);
    }

    private connectConfiguredAgent(
        runId: string,
        completedCommandIds: readonly string[]
    ): BrowserControlAgentStartOutcome {
        this.setSnapshot({
            bootstrapping: false,
            busy: false,
            runState: 'waiting',
            lastAction: this.bootstrap.autoConnect
                ? 'Remote control agent configured; connecting'
                : 'Remote control agent configured',
            lastError: undefined
        });
        if (!this.bootstrap.autoConnect) {
            return 'configured';
        }

        this.controlClient.connect({
            url: this.bootstrap.controlUrl,
            runId,
            agentId: this.bootstrap.agentId,
            token: this.bootstrap.controlToken,
            finalReportUploadUrl: this.bootstrap.finalReportUploadUrl,
            completedCommandIds
        });
        return 'connecting';
    }

    private recordBootstrapFailure(failure: string): Either<string, BrowserControlAgentStartOutcome> {
        this.setSnapshot({
            bootstrapping: false,
            busy: false,
            runState: 'failed',
            lastAction: 'Remote control bootstrap failed',
            lastError: failure
        });
        return Either.ofLeft(failure);
    }

    private setSnapshot(patch: Partial<RallarBlackBoxBrowserControlAgentSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        this.listeners.forEach((listener) => listener());
    }
}

function createAgentRuntime(bootstrap: RallarBlackBoxBootstrapConfig): BrowserControlAgentRuntime {
    if (bootstrap.providerMode === 'browser-rallar' && typeof window !== 'undefined') {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: createSpaBrowserRallarRuntime(),
            fetch: globalThis.fetch?.bind(globalThis) as typeof fetch | undefined,
            webSocketFactory: createBrowserWebSocketFactory()
        });
        return { runtime, disposeBridge: installSpaBrowserRallarEventBridge(runtime) };
    }

    return { runtime: createRallarBlackBoxTestRuntime() };
}

function toRunState(
    status: RallarBlackBoxTestRuntimeStatus,
    current: BrowserControlAgentRunState
): BrowserControlAgentRunState {
    switch (status) {
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
            return current;
    }
}
