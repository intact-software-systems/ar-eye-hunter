import { takeAgentResumeRecord } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import {
    readRallarBlackBoxBootstrapConfig,
    toRallarBlackBoxBootstrapRefusal,
    type RallarBlackBoxBootstrapConfig
} from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { readBrowserAuthSessionPresence } from '@shared-test/rallar-bb-test/browser-control-agent/read-browser-auth-session-presence.ts';
import {
    toRallarBlackBoxFleetConfig,
    toRallarBlackBoxRallarConfig,
    toRemoteControlConfig
} from '@shared-test/rallar-bb-test/browser-control-agent/to-remote-control-config.ts';
import { validateRallarBlackBoxProviderConfig } from '@shared-test/rallar-bb-test/browser-control-agent/validate-rallar-black-box-provider-config.ts';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge
} from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import {
    decodeRallarBlackBoxConfigProviderMode,
    RALLAR_BLACK_BOX_CLIENT_DEFAULTS
} from '@shared-test/rallar-bb-test/client-defaults.ts';
import {
    createDefaultRallarBlackBoxControlClient,
    type RallarBlackBoxControlClient,
    type RallarBlackBoxControlSnapshot
} from '@shared-test/rallar-bb-test/control-client.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { configureAuthSessionStorage } from '@shared/api/auth.ts';
import { Either } from '@shared/resilience/Either.ts';
import { useSyncExternalStore } from 'react';
import { RALLAR_BLACK_BOX_RECIPE_FIXTURES } from './recipe-fixtures.ts';

export type { RallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';

type RuntimeStoreSnapshot = Readonly<{
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
    bootstrap: RallarBlackBoxBootstrapConfig;
    bootstrapping: boolean;
    busy: boolean;
    runState: 'waiting' | 'running' | 'passed' | 'failed' | 'cancelled' | 'reset';
    /** Absent before the operator has run anything in this session. */
    lastAction?: string;
    /** Absent while the last action carried no failure. */
    lastError?: string;
    /** Absent when no fixture is loaded — a hand-written recipe, or a workbench that was reset. */
    loadedFixtureId?: string;
}>;

type StoreListener = () => void;

function resolveInitialBootstrapConfig(): RallarBlackBoxBootstrapConfig {
    const bootstrap = readRallarBlackBoxBootstrapConfig();
    configureAuthSessionStorage(bootstrap.rallarAuthStorage);
    return bootstrap;
}

function createInitialControlSnapshot(
    bootstrap: RallarBlackBoxBootstrapConfig
): RallarBlackBoxControlSnapshot {
    return {
        state: 'idle',
        url: bootstrap.controlUrl,
        reconnectAttempt: 0,
        sentCount: 0,
        receivedCount: 0
    };
}

function startDelay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Reports the configuration the provider accepted, or the message an invalid one earns after its
 * diagnostic is recorded.
 */
function recordValidatedProviderConfig(
    runtime: RallarBlackBoxTestRuntime,
    config: RallarBlackBoxTestConfig
): Either<string, RallarBlackBoxTestConfig> {
    const [configError] = validateRallarBlackBoxProviderConfig(config);
    if (!configError) {
        return Either.ofRight(config);
    }

    runtime.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.bb.provider.browser_rallar.config_invalid',
        severity: 'error',
        payload: configError
    });
    return Either.ofLeft(configError.message);
}

function resolveRuntimeDelayMs(command: RallarBlackBoxTestCommand): number {
    const configuredDelay = command.metadata?.localDelayMs;
    if (typeof configuredDelay === 'number' && Number.isFinite(configuredDelay)) {
        return Math.max(0, configuredDelay);
    }

    switch (command.kind) {
        case 'rtc.connect':
            return 450;
        case 'rtc.send':
            return 260;
        case 'ws.open':
        case 'http.request':
            return 340;
        case 'wait':
        case 'assert':
            return 0;
        default:
            return 160;
    }
}

const FAKE_RUNTIME_SESSION_ID = 'visible-session-alice';
const FAKE_RUNTIME_DELIVERY_MODE = 'direct';
/** The code the runtime itself stamps on a failed command, kept so a returned failure reads alike. */
const FAKE_RUNTIME_COMMAND_FAILED_CODE = 'RALLAR_BLACK_BOX_COMMAND_FAILED';

/** The manual-workbench facts a command carries; the operator sets each one or leaves it out. */
interface ManualCommandMetadata {
    /** Absent unless the operator listed the clients the command expects to observe. */
    readonly expectedClients?: readonly string[];
    /** Absent unless the operator listed the agents a send addresses. */
    readonly targets?: readonly string[];
    /** Absent unless the operator chose a delivery mode instead of the send's own default. */
    readonly deliveryMode?: string;
}

function decodeCommandText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function decodeCommandTexts(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) ? value.map(String) : undefined;
}

function decodeManualCommandMetadata(value: unknown): ManualCommandMetadata | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Readonly<Record<string, unknown>>;
    const expectedClients = decodeCommandTexts(record.expectedClients);
    const targets = decodeCommandTexts(record.targets);
    const deliveryMode = decodeCommandText(record.deliveryMode);
    return {
        ...(expectedClients ? { expectedClients } : {}),
        ...(targets ? { targets } : {}),
        ...(deliveryMode === undefined ? {} : { deliveryMode })
    };
}

function recordProviderRefusal(
    command: RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>,
    context: RallarBlackBoxTestCommandContext
): RallarBlackBoxTestCommandOutcome {
    const config = context.config();
    if (config) {
        const [configError] = validateRallarBlackBoxProviderConfig(config);
        if (configError) {
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.provider.browser_rallar.config_invalid',
                commandId: command.commandId,
                severity: 'error',
                payload: configError
            });
            return {
                status: 'failed',
                error: configError,
                nextStatus: 'failed'
            };
        }
    }

    const error: RallarBlackBoxTestError = {
        code: 'RALLAR_BLACK_BOX_PROVIDER_NOT_IMPLEMENTED',
        message:
            'browser-rallar provider is selected, but the real browser Rallar SPA adapter is planned for Iteration 15B.',
        details: {
            providerMode: 'browser-rallar',
            commandKind: command.kind
        }
    };
    context.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.bb.provider.browser_rallar.not_ready',
        commandId: command.commandId,
        severity: 'error',
        payload: error
    });
    return {
        status: 'failed',
        error,
        nextStatus: 'failed'
    };
}

function canInstallSpaBrowserRallarRuntime(): boolean {
    return typeof window !== 'undefined';
}

async function runProviderCommand(
    command: RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>,
    context: RallarBlackBoxTestCommandContext
): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
    const runsSimulatedProvider = decodeRallarBlackBoxConfigProviderMode(context.config())
        .fold(() => false, (providerMode) => providerMode === 'simulated');
    if (!runsSimulatedProvider && command.kind !== 'reset') {
        return recordProviderRefusal(command, context);
    }

    await startDelay(resolveRuntimeDelayMs(command));

    switch (command.kind) {
        case 'rtc.connect': {
            const config = context.config();
            const sessionId = decodeCommandText(
                command.rallar?.sessionId ?? config?.sessionId
            ) ?? FAKE_RUNTIME_SESSION_ID;
            const manualMetadata = decodeManualCommandMetadata(command.metadata?.manual);
            const manualExpectedClients = manualMetadata?.expectedClients ?? [];
            const expectedClients = manualExpectedClients.length > 0
                ? manualExpectedClients
                : [sessionId];
            const stageBase = {
                commandId: command.commandId,
                connection: command.connection,
                actor: command.actor,
                transport: command.transport,
                severity: 'info' as const
            };
            const stages = [
                ['auth', 'rallar.bb.fake.connect.authenticated'],
                ['runtime-bootstrap', 'rallar.bb.fake.connect.runtime_bootstrapped'],
                ['group-join', 'rallar.bb.fake.connect.group_joined'],
                ['signaling', 'rallar.bb.fake.connect.signaling_ready'],
                ['peer-discovery', 'rallar.bb.fake.connect.peer_discovered'],
                ['data-channel', 'rallar.bb.fake.connect.data_channel_ready']
            ] as const;
            for (const [phase, topic] of stages) {
                context.recordEvent({
                    ...stageBase,
                    kind: 'diagnostic',
                    topic,
                    payload: {
                        phase,
                        roomId: command.roomId,
                        applicationId: command.applicationId,
                        workspaceId: command.workspaceId,
                        scope: command.scope,
                        roomRef: command.roomRef,
                        minSnapshotVersion: command.minSnapshotVersion,
                        sessionId,
                        expectedClients,
                        observedClients: phase === 'peer-discovery' || phase === 'data-channel'
                            ? expectedClients
                            : [sessionId],
                        readyPeerIds: phase === 'data-channel' ? expectedClients : [],
                        activePeerIds: phase === 'data-channel' ? expectedClients : [sessionId],
                        peerCount: phase === 'peer-discovery' || phase === 'data-channel'
                            ? expectedClients.length
                            : 1,
                        laneHealth: phase === 'data-channel' ? 'open' : 'opening'
                    }
                });
            }
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.fake.rtc.connected',
                commandId: command.commandId,
                connection: command.connection,
                actor: command.actor,
                transport: command.transport,
                severity: 'info',
                payload: {
                    roomId: command.roomId,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    sessionId,
                    expectedClients,
                    observedClients: expectedClients,
                    readyPeerIds: expectedClients,
                    activePeerIds: expectedClients,
                    peerCount: expectedClients.length,
                    laneHealth: 'open'
                }
            });
            return {
                status: 'ok',
                value: {
                    providerMode: 'simulated',
                    connected: true,
                    connection: command.connection,
                    actor: command.actor,
                    roomId: command.roomId,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    transport: command.transport,
                    sessionId,
                    expectedClients,
                    observedClients: expectedClients
                },
                nextStatus: context.state().status
            };
        }
        case 'rtc.send': {
            const manualMetadata = decodeManualCommandMetadata(command.metadata?.manual);
            const targets = manualMetadata?.targets ?? [];
            const deliveryMode = manualMetadata?.deliveryMode ?? FAKE_RUNTIME_DELIVERY_MODE;
            const negativeCase = typeof command.metadata?.negativeCase === 'string'
                ? command.metadata.negativeCase
                : undefined;
            if (negativeCase) {
                context.recordEvent({
                    kind: 'diagnostic',
                    topic: `rallar.bb.fake.rtc.${negativeCase}`,
                    commandId: command.commandId,
                    connection: command.connection,
                    transport: command.transport,
                    severity: negativeCase === 'not-yet-in-sync' ? 'warning' : 'error',
                    payload: {
                        negativeCase,
                        deliveryMode,
                        targets,
                        applicationId: command.applicationId,
                        workspaceId: command.workspaceId,
                        scope: command.scope,
                        roomRef: command.roomRef,
                        minSnapshotVersion: command.minSnapshotVersion,
                        nack: negativeCase === 'not-yet-in-sync'
                            ? {
                                code: 'not-yet-in-sync',
                                message: 'Snapshot is behind the minimum requested version.'
                            }
                            : undefined
                    }
                });
            }
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.fake.rtc.send_completed',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                severity: 'info',
                payload: {
                    deliveryMode,
                    targets,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    expectedClients: targets,
                    observedClients: deliveryMode === 'broadcast' ? targets : targets,
                    readyPeerIds: targets,
                    activePeerIds: targets,
                    peerCount: targets.length,
                    laneHealth: negativeCase ? 'degraded' : 'open',
                    firstPayloadMs: resolveRuntimeDelayMs(command)
                }
            });
            context.recordEvent({
                kind: 'message',
                topic: 'rallar.bb.fake.rtc.message',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                severity: 'info',
                payload: {
                    direction: 'loopback',
                    data: command.send,
                    receivedAtEpochMs: Date.now(),
                    deliveryMode,
                    targets
                }
            });
            return {
                status: 'ok',
                value: {
                    providerMode: 'simulated',
                    sent: true,
                    connection: command.connection,
                    transport: command.transport,
                    deliveryMode,
                    targets,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    payloadBytes: JSON.stringify(command.send ?? {}).length
                },
                nextStatus: context.state().status
            };
        }
        case 'ws.open':
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.fake.ws.open_skipped',
                commandId: command.commandId,
                connection: command.connection,
                transport: 'ws',
                severity: 'warning',
                payload: {
                    url: command.url,
                    reason: 'local scaffold does not open remote sockets'
                }
            });
            return {
                status: 'ok',
                value: {
                    providerMode: 'simulated',
                    opened: false,
                    simulated: true,
                    connection: command.connection,
                    url: command.url
                },
                nextStatus: context.state().status
            };
        case 'ws.send':
            context.recordEvent({
                kind: 'message',
                topic: 'rallar.bb.fake.ws.message',
                commandId: command.commandId,
                connection: command.connection,
                transport: 'ws',
                severity: 'info',
                payload: {
                    direction: 'loopback',
                    data: command.data
                }
            });
            return {
                status: 'ok',
                value: {
                    providerMode: 'simulated',
                    sent: true,
                    simulated: true,
                    connection: command.connection,
                    data: command.data
                },
                nextStatus: context.state().status
            };
        case 'ws.close':
            context.recordEvent({
                kind: 'event',
                topic: 'rallar.bb.fake.ws.closed',
                commandId: command.commandId,
                connection: command.connection,
                transport: 'ws',
                severity: 'info',
                payload: {
                    code: command.code,
                    reason: command.reason
                }
            });
            return {
                status: 'ok',
                value: {
                    providerMode: 'simulated',
                    closed: true,
                    simulated: true,
                    connection: command.connection
                },
                nextStatus: context.state().status
            };
        case 'http.request':
            if (!command.request.url && !command.request.path) {
                return {
                    status: 'failed',
                    error: {
                        code: FAKE_RUNTIME_COMMAND_FAILED_CODE,
                        message: 'Local HTTP command requires request.url or request.path.'
                    },
                    nextStatus: 'failed'
                };
            }
            context.recordEvent({
                kind: 'event',
                topic: 'rallar.bb.fake.http.response',
                commandId: command.commandId,
                transport: 'http',
                severity: 'info',
                payload: {
                    status: 200,
                    ok: true,
                    request: command.request,
                    body: {
                        status: 'ok'
                    }
                }
            });
            return {
                status: 'ok',
                value: {
                    providerMode: 'simulated',
                    status: 200,
                    ok: true,
                    simulated: true,
                    request: command.request,
                    body: {
                        status: 'ok'
                    }
                },
                nextStatus: context.state().status
            };
        default:
            return undefined;
    }
}

class RallarBlackBoxRuntimeStore {
    private readonly runtime: RallarBlackBoxTestRuntime;
    private readonly controlClient: RallarBlackBoxControlClient;
    private readonly listeners = new Set<StoreListener>();
    private snapshot: RuntimeStoreSnapshot;
    private bootstrapStarted = false;
    private runSequence = 1;
    private resumedCommandIds: readonly string[] = [];
    private bootstrapConfig = resolveInitialBootstrapConfig();

    constructor() {
        if (
            this.bootstrapConfig.providerMode === 'browser-rallar' &&
            canInstallSpaBrowserRallarRuntime()
        ) {
            const browserRuntime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime(),
                fetch: globalThis.fetch?.bind(globalThis) as typeof fetch | undefined,
                webSocketFactory: createBrowserWebSocketFactory()
            });
            this.runtime = browserRuntime;
            installSpaBrowserRallarEventBridge(browserRuntime);
        }
        else {
            this.runtime = createRallarBlackBoxTestRuntime({
                commandExecutor: runProviderCommand
            });
        }
        this.snapshot = {
            state: this.runtime.state(),
            control: createInitialControlSnapshot(this.bootstrapConfig),
            bootstrap: this.bootstrapConfig,
            bootstrapping: false,
            busy: false,
            runState: 'waiting'
        };
        this.controlClient = createDefaultRallarBlackBoxControlClient({
            runtime: this.runtime,
            heartbeatIntervalMs: this.bootstrapConfig.heartbeatIntervalMs,
            statsIntervalMs: this.bootstrapConfig.statsIntervalMs
        });
        this.controlClient.subscribe((control) => {
            this.snapshot = {
                ...this.snapshot,
                control
            };
            this.emit();
        });
        this.runtime.subscribe((state) => {
            this.snapshot = {
                ...this.snapshot,
                state
            };
            this.emit();
        });
    }

    getSnapshot = (): RuntimeStoreSnapshot => this.snapshot;

    subscribe = (listener: StoreListener): () => void => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    updateBootstrapConfig(
        patch: Partial<RallarBlackBoxBootstrapConfig>
    ): void {
        this.bootstrapConfig = {
            ...this.bootstrapConfig,
            ...patch
        };
        this.snapshot = {
            ...this.snapshot,
            bootstrap: this.bootstrapConfig
        };
        this.emit();
    }

    startBootstrapOnce(): void {
        if (this.bootstrapStarted) {
            return;
        }

        this.bootstrapStarted = true;
        if (this.bootstrapConfig.mode === 'control-agent') {
            void this.bootstrapControlAgent();
            return;
        }

        if (this.bootstrapConfig.providerMode === 'browser-rallar') {
            void this.configureLocalWorkbenchOnly();
            return;
        }

        void this.runSample();
    }

    connectControl(url: string, runId?: string, agentId?: string): void {
        const config = this.runtime.state().currentConfig;
        const effectiveRunId = runId || config?.runId || `local-control-run-${this.runSequence++}`;
        const effectiveAgentId = agentId || config?.agentId || 'visible-agent-local';
        this.snapshot = {
            ...this.snapshot,
            lastAction: 'Connecting control WebSocket',
            lastError: undefined
        };
        this.emit();
        this.controlClient.connect({
            url,
            runId: effectiveRunId,
            agentId: effectiveAgentId,
            token: this.bootstrapConfig.controlToken,
            finalReportUploadUrl: this.bootstrapConfig.finalReportUploadUrl,
            completedCommandIds: this.resumedCommandIds
        });
    }

    disconnectControl(): void {
        this.controlClient.disconnect();
        this.snapshot = {
            ...this.snapshot,
            lastAction: 'Control WebSocket disconnected'
        };
        this.emit();
    }

    /** An absent `lastAction` records the event without changing what the panel says it last did. */
    recordRuntimeEvent(
        event: RallarBlackBoxTestRuntimeEventInput,
        lastAction?: string
    ): void {
        this.runtime.recordEvent(event);
        if (lastAction) {
            this.snapshot = {
                ...this.snapshot,
                lastAction
            };
            this.emit();
        }
    }

    async runSample(): Promise<void> {
        try {
            const configured = await this.resetForRun('Loading local scaffold recipe');
            if (configured.left !== undefined) {
                this.setFailedRunState('Local sample failed', configured.left);
                return;
            }
            await this.loadRecipe(
                RALLAR_BLACK_BOX_RECIPE_FIXTURES[0].recipe,
                RALLAR_BLACK_BOX_RECIPE_FIXTURES[0].fixtureId
            );
            await this.runLoadedRecipe();
        }
        catch (error) {
            this.setFailedRunState('Local sample failed', decodeErrorMessage(error));
        }
    }

    async configureLocalWorkbenchOnly(): Promise<void> {
        try {
            const runNumber = this.runSequence++;
            this.snapshot = {
                ...this.snapshot,
                bootstrapping: true,
                busy: true,
                runState: 'waiting',
                lastAction: 'Configuring local browser-rallar workbench',
                lastError: undefined
            };
            this.emit();

            const configured = await this.configureRuntime(runNumber);
            if (configured.left !== undefined) {
                this.setLocalWorkbenchConfigurationFailure(configured.left);
                return;
            }
            this.snapshot = {
                ...this.snapshot,
                bootstrapping: false,
                busy: false,
                runState: 'waiting',
                loadedFixtureId: undefined,
                lastAction: 'Local browser-rallar workbench configured',
                lastError: undefined
            };
        }
        catch (error) {
            this.setLocalWorkbenchConfigurationFailure(decodeErrorMessage(error));
            return;
        }

        this.emit();
    }

    async bootstrapControlAgent(): Promise<void> {
        const refusal = toRallarBlackBoxBootstrapRefusal(this.bootstrapConfig);
        if (refusal !== undefined) {
            this.snapshot = {
                ...this.snapshot,
                bootstrapping: false,
                busy: false,
                runState: 'failed',
                lastAction: 'Remote control bootstrap failed',
                lastError: refusal
            };
            this.emit();
            return;
        }
        const runNumber = this.runSequence++;
        const config = toRemoteControlConfig({
            bootstrap: this.bootstrapConfig,
            hasStoredAuthSession: readBrowserAuthSessionPresence()
        });
        const resumed = takeAgentResumeRecord(this.bootstrapConfig.runId, this.bootstrapConfig.agentId);
        this.resumedCommandIds = resumed?.completedCommandIds ?? [];
        this.snapshot = {
            ...this.snapshot,
            bootstrapping: true,
            busy: true,
            runState: 'waiting',
            lastAction: 'Bootstrapping remote control agent',
            lastError: undefined
        };
        this.emit();

        try {
            await this.runtime.execute({
                kind: 'reset',
                commandId: `reset-control-${runNumber}`
            });
            await this.runtime.execute({
                kind: 'configure',
                commandId: `configure-control-${runNumber}`,
                config
            });
            const configured = recordValidatedProviderConfig(this.runtime, config);
            if (configured.left !== undefined) {
                this.setFailedRunState('Remote control bootstrap failed', configured.left);
                return;
            }

            this.snapshot = {
                ...this.snapshot,
                bootstrapping: false,
                busy: false,
                runState: 'waiting',
                lastAction: this.bootstrapConfig.autoConnect
                    ? 'Remote control agent configured; connecting'
                    : 'Remote control agent configured',
                lastError: undefined
            };
            this.emit();

            if (this.bootstrapConfig.autoConnect) {
                this.connectControl(
                    this.bootstrapConfig.controlUrl,
                    config.runId,
                    this.bootstrapConfig.agentId
                );
            }
        }
        catch (error) {
            this.setFailedRunState('Remote control bootstrap failed', decodeErrorMessage(error));
        }
    }

    /** An absent `fixtureId` means the operator wrote this recipe instead of picking a fixture. */
    async loadRecipeFromJson(
        recipeJson: string,
        fixtureId?: string
    ): Promise<Either<string, RallarBlackBoxTestRecipe>> {
        const decoded = this.decodeJsonText<RallarBlackBoxTestRecipe>(
            recipeJson,
            'Recipe JSON is invalid'
        );
        const recipe = decoded.right;
        if (recipe === undefined) {
            return Either.ofLeft(decoded.left ?? 'Recipe JSON is invalid');
        }
        await this.loadRecipe(recipe, fixtureId);
        return Either.ofRight(recipe);
    }

    async runLoadedRecipe(): Promise<void> {
        const runNumber = this.runSequence++;
        this.snapshot = {
            ...this.snapshot,
            busy: true,
            runState: 'running',
            lastAction: 'Running loaded local recipe',
            lastError: undefined
        };
        this.emit();

        try {
            const result = await this.runtime.execute({
                kind: 'recipe.run',
                commandId: `recipe-run-local-${runNumber}`
            });
            this.snapshot = {
                ...this.snapshot,
                busy: false,
                bootstrapping: false,
                runState: result.status === 'cancelled'
                    ? 'cancelled'
                    : result.ok
                    ? 'passed'
                    : 'failed',
                lastAction: result.ok
                    ? 'Local recipe completed'
                    : 'Local recipe finished with failures',
                lastError: result.error?.message
            };
        }
        catch (error) {
            this.snapshot = {
                ...this.snapshot,
                busy: false,
                bootstrapping: false,
                runState: 'failed',
                lastAction: 'Local recipe failed',
                lastError: decodeErrorMessage(error)
            };
        }

        this.emit();
    }

    async runCommandFromJsonText(
        commandJson: string
    ): Promise<Either<string, RallarBlackBoxTestCommand>> {
        const decoded = this.decodeJsonText<RallarBlackBoxTestCommand>(
            commandJson,
            'Command JSON is invalid'
        );
        const command = decoded.right;
        if (command === undefined) {
            return Either.ofLeft(decoded.left ?? 'Command JSON is invalid');
        }
        await this.runManualCommand(command, `Executing ${command.kind}`);
        return Either.ofRight(command);
    }

    async runManualCommand(
        command: RallarBlackBoxTestCommand,
        actionLabel = `Executing ${command.kind}`
    ): Promise<void> {
        await this.runManualCommands([command], actionLabel);
    }

    async runManualCommands(
        commands: readonly RallarBlackBoxTestCommand[],
        actionLabel: string
    ): Promise<void> {
        if (commands.length === 0) {
            return;
        }

        this.snapshot = {
            ...this.snapshot,
            busy: true,
            runState: 'running',
            lastAction: actionLabel,
            lastError: undefined
        };
        this.emit();

        try {
            let failed: RallarBlackBoxTestResult | undefined;
            for (const command of commands) {
                const result = await this.runtime.execute(command);
                if (!result.ok && !failed) {
                    failed = result;
                }
            }

            this.snapshot = {
                ...this.snapshot,
                busy: false,
                runState: failed
                    ? failed.status === 'cancelled' ? 'cancelled' : 'failed'
                    : 'passed',
                lastAction: failed ? `${actionLabel} failed` : actionLabel,
                lastError: failed?.error?.message
            };
        }
        catch (error) {
            this.snapshot = {
                ...this.snapshot,
                busy: false,
                runState: 'failed',
                lastAction: `${actionLabel} failed`,
                lastError: decodeErrorMessage(error)
            };
        }

        this.emit();
    }

    async cancelRecipe(): Promise<void> {
        const wasBusy = this.snapshot.busy;
        this.snapshot = {
            ...this.snapshot,
            lastAction: 'Requesting recipe cancellation'
        };
        this.emit();

        const result = await this.runtime.execute({
            kind: 'recipe.cancel',
            commandId: `recipe-cancel-local-${this.runSequence++}`,
            reason: 'cancelled from local workbench'
        });
        this.snapshot = {
            ...this.snapshot,
            busy: wasBusy,
            bootstrapping: false,
            runState: result.ok ? 'cancelled' : 'failed',
            lastAction: result.ok
                ? 'Recipe cancellation requested'
                : 'Recipe cancellation failed',
            lastError: result.error?.message
        };
        this.emit();
    }

    async resetWorkbench(): Promise<void> {
        const configured = await this.resetForRun('Workbench reset');
        if (configured.left !== undefined) {
            this.setFailedRunState('Workbench reset failed', configured.left);
            return;
        }
        this.snapshot = {
            ...this.snapshot,
            busy: false,
            bootstrapping: false,
            runState: 'reset',
            loadedFixtureId: undefined
        };
        this.emit();
    }

    private async resetForRun(
        lastAction: string
    ): Promise<Either<string, RallarBlackBoxTestConfig>> {
        const runNumber = this.runSequence++;
        this.snapshot = {
            ...this.snapshot,
            bootstrapping: true,
            busy: true,
            runState: 'reset',
            lastAction,
            lastError: undefined
        };
        this.emit();

        await this.runtime.execute({
            kind: 'reset',
            commandId: `reset-local-${runNumber}`
        });
        return await this.configureRuntime(runNumber);
    }

    private async configureRuntime(
        runNumber: number
    ): Promise<Either<string, RallarBlackBoxTestConfig>> {
        const rallar = toRallarBlackBoxRallarConfig({
            bootstrap: this.bootstrapConfig,
            hasStoredAuthSession: readBrowserAuthSessionPresence()
        });
        const config: RallarBlackBoxTestConfig = {
            runId: this.bootstrapConfig.runId,
            agentId: this.bootstrapConfig.agentId,
            environment: this.bootstrapConfig.environment,
            apiBaseUrl: this.bootstrapConfig.apiBaseUrl,
            actor: this.bootstrapConfig.actor,
            sessionId: this.bootstrapConfig.sessionId,
            roomId: this.bootstrapConfig.roomId,
            transport: this.bootstrapConfig.transport,
            ...(rallar ? { rallar } : {}),
            control: {
                mode: 'local-workbench',
                providerMode: this.bootstrapConfig.providerMode,
                protocolVersion: 1,
                connected: false
            },
            defaults: {
                timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
                connection: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.connection,
                providerMode: this.bootstrapConfig.providerMode
            },
            fleet: toRallarBlackBoxFleetConfig(this.bootstrapConfig)
        };
        await this.runtime.execute({
            kind: 'configure',
            commandId: `configure-local-${runNumber}`,
            config
        });
        return recordValidatedProviderConfig(this.runtime, config);
    }

    /** An absent `fixtureId` means the operator wrote this recipe instead of picking a fixture. */
    private async loadRecipe(
        recipe: RallarBlackBoxTestRecipe,
        fixtureId?: string
    ): Promise<void> {
        const loadNumber = this.runSequence++;
        this.snapshot = {
            ...this.snapshot,
            busy: true,
            runState: 'waiting',
            lastAction: `Loading recipe ${recipe.recipeId ?? ''}`.trim(),
            lastError: undefined
        };
        this.emit();

        const result = await this.runtime.execute({
            kind: 'recipe.load',
            commandId: `recipe-load-local-${loadNumber}`,
            recipe
        });
        if (!result.ok) {
            this.snapshot = {
                ...this.snapshot,
                busy: false,
                bootstrapping: false,
                runState: 'failed',
                lastAction: `Recipe ${recipe.recipeId ?? ''} is invalid`.trim(),
                lastError: result.error?.message
            };
            this.emit();
            return;
        }

        this.snapshot = {
            ...this.snapshot,
            busy: false,
            bootstrapping: false,
            runState: 'waiting',
            lastAction: `Loaded recipe ${recipe.recipeId}`,
            loadedFixtureId: fixtureId
        };
        this.emit();
    }

    private decodeJsonText<T>(input: string, failedAction: string): Either<string, T> {
        try {
            return Either.ofRight(JSON.parse(input) as T);
        }
        catch (error) {
            const message = decodeErrorMessage(error);
            this.snapshot = {
                ...this.snapshot,
                runState: 'failed',
                lastAction: failedAction,
                lastError: message
            };
            this.emit();
            return Either.ofLeft(message);
        }
    }

    private setFailedRunState(lastAction: string, lastError: string): void {
        this.snapshot = {
            ...this.snapshot,
            bootstrapping: false,
            busy: false,
            runState: 'failed',
            lastAction,
            lastError
        };
        this.emit();
    }

    private setLocalWorkbenchConfigurationFailure(lastError: string): void {
        this.snapshot = {
            ...this.snapshot,
            bootstrapping: false,
            busy: false,
            runState: 'failed',
            loadedFixtureId: undefined,
            lastAction: 'Local browser-rallar workbench configuration failed',
            lastError
        };
        this.emit();
    }

    /** `emit` is the external-store vocabulary React's `useSyncExternalStore` subscribers read. */
    private emit(): void {
        this.listeners.forEach((listener) => listener());
    }
}

export const rallarBlackBoxRuntimeStore = new RallarBlackBoxRuntimeStore();

export function useRallarBlackBoxRuntimeStore(): RuntimeStoreSnapshot {
    return useSyncExternalStore(
        rallarBlackBoxRuntimeStore.subscribe,
        rallarBlackBoxRuntimeStore.getSnapshot,
        rallarBlackBoxRuntimeStore.getSnapshot
    );
}

/** The message a caught value carries, whether it is an `Error`, a test error, or plain text. */
function decodeErrorMessage(error: unknown): string {
    if (
        typeof error === 'object' && error !== null && 'message' in error &&
        typeof error.message === 'string'
    ) {
        return error.message;
    }
    return String(error);
}
