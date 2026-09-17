/**
 * The in-page command runtime the local workbench installs. It answers the simulated provider with
 * synthetic evidence and refuses every other provider mode, so no command reaches a real backend
 * from here.
 */
import { validateRallarBlackBoxProviderConfig } from '@shared-test/rallar-bb-test/browser-control-agent/validate-rallar-black-box-provider-config.ts';
import { decodeRallarBlackBoxConfigProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestError
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

function startDelay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
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
export async function runSimulatedProviderCommand(
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
