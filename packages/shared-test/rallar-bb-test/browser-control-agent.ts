import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { takeAgentResumeRecord } from './alm/browser-control-agent-resume.ts';
import {
    resolveRallarBlackBoxBootstrapConfig,
    toRallarBlackBoxBootstrapRefusal,
    type RallarBlackBoxBootstrapConfig
} from './browser-control-agent-config.ts';
import type { RallarBlackBoxBootstrapEnvironment } from './browser-control-agent/resolve-launch-value.ts';
import {
    readBrowserAuthSessionPresence,
    toRemoteControlConfig
} from './browser-control-agent/to-remote-control-config.ts';
import { validateRallarBlackBoxProviderConfig } from './browser-control-agent/validate-rallar-black-box-provider-config.ts';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge
} from './browser-rallar-runtime-bridge.ts';
import type { RallarBlackBoxProviderMode } from './client-defaults.ts';
import {
    createDefaultRallarBlackBoxControlClient,
    type RallarBlackBoxAgentControlClient,
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

export type BrowserControlAgentRunState =
    | 'waiting'
    | 'running'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'reset';

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

export interface BrowserControlAgentRuntime {
    readonly runtime: RallarBlackBoxTestRuntime;
    /** Absent when the simulated runtime installs no page event bridge. */
    readonly disposeBridge?: () => void;
}

/** The agent owns the runtime bridge and control client it is given, and disposes both with itself. */
export interface CreateRallarBlackBoxBrowserControlAgentInput {
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly agentRuntime: BrowserControlAgentRuntime;
    /** Drives the same runtime as `agentRuntime`. */
    readonly controlClient: RallarBlackBoxAgentControlClient;
}

/** The launch URL, its fragment and the Vite environment of the agent page. */
export interface CreateDefaultRallarBlackBoxBrowserControlAgentInput {
    readonly search: string;
    readonly env: RallarBlackBoxBootstrapEnvironment;
    readonly hash: string;
}

const DISPOSED_AGENT_FAILURE = 'Browser control agent is disposed.';

export function createRallarBlackBoxBrowserControlAgent(
    input: CreateRallarBlackBoxBrowserControlAgentInput
): RallarBlackBoxBrowserControlAgent {
    return new BrowserControlAgent(input);
}

export function createDefaultRallarBlackBoxBrowserControlAgent(
    input: CreateDefaultRallarBlackBoxBrowserControlAgentInput
): RallarBlackBoxBrowserControlAgent {
    const bootstrap = resolveRallarBlackBoxBootstrapConfig(input.search, input.env, input.hash);
    const agentRuntime = createDefaultBrowserControlAgentRuntime(bootstrap.providerMode);
    const controlClient = createDefaultRallarBlackBoxControlClient({
        runtime: agentRuntime.runtime,
        heartbeatIntervalMs: bootstrap.heartbeatIntervalMs,
        statsIntervalMs: bootstrap.statsIntervalMs
    });
    return createRallarBlackBoxBrowserControlAgent({ bootstrap, agentRuntime, controlClient });
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
    private readonly controlClient: RallarBlackBoxAgentControlClient;
    private readonly unsubscribeControl: () => void;
    private readonly unsubscribeRuntime: () => void;
    private readonly listeners = new Set<() => void>();
    private disposed = false;
    private snapshot: RallarBlackBoxBrowserControlAgentSnapshot;

    constructor(input: CreateRallarBlackBoxBrowserControlAgentInput) {
        const { bootstrap, agentRuntime, controlClient } = input;
        this.bootstrap = bootstrap;
        this.agentRuntime = agentRuntime;
        this.controlClient = controlClient;
        this.snapshot = {
            state: agentRuntime.runtime.state(),
            control: toInitialControlSnapshot(bootstrap),
            bootstrap,
            bootstrapping: false,
            busy: false,
            runState: 'waiting'
        };
        this.unsubscribeControl = controlClient.subscribe((control) => this.setSnapshot({ control }));
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
        const refusal = toRallarBlackBoxBootstrapRefusal(this.bootstrap);
        if (refusal !== undefined) {
            return this.recordBootstrapFailure(refusal);
        }

        const config = toRemoteControlConfig({
            bootstrap: this.bootstrap,
            hasStoredAuthSession: readBrowserAuthSessionPresence()
        });
        const resumeRecord = takeAgentResumeRecord(this.bootstrap.runId, this.bootstrap.agentId);
        const completedCommandIds = resumeRecord?.completedCommandIds ?? [];
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
            () => Either.ofRight(this.connectConfiguredAgent(completedCommandIds))
        );
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.controlClient.dispose();
        this.unsubscribeControl();
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

    private connectConfiguredAgent(completedCommandIds: readonly string[]): BrowserControlAgentStartOutcome {
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
            runId: this.bootstrap.runId,
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

function createDefaultBrowserControlAgentRuntime(providerMode: RallarBlackBoxProviderMode): BrowserControlAgentRuntime {
    if (providerMode === 'simulated') {
        return { runtime: createRallarBlackBoxTestRuntime() };
    }

    const runtime = createRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: createSpaBrowserRallarRuntime(),
        fetch: (request, init) => globalThis.fetch(request, init),
        webSocketFactory: createBrowserWebSocketFactory()
    });
    return { runtime, disposeBridge: installSpaBrowserRallarEventBridge(runtime) };
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
