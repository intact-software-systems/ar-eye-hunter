// deno-lint-ignore-file no-explicit-any
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
} from '../rallar-bb-test/types.ts';
import {
    rememberRtcCloseEvent,
    rememberRtcMessage,
    type RtcProvider,
    toRtcConnectionName,
    toRtcExpectedConnectionName,
    toRtcFailureStatus,
    toRtcPayload,
    toRtcSuccessStatus,
    waitForRtcClose,
    waitForRtcMessage,
    waitForRtcMessages,
} from './rtc-provider.ts';

export type RallarRemoteBrowserControlFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export type RallarRemoteBrowserProviderOptions = Readonly<{
    controlBaseUrl?: string;
    runId?: string;
    agentId?: string;
    token?: string;
    fetch?: RallarRemoteBrowserControlFetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
}>;

export type RallarRemoteBrowserControlResultEnvelope = Readonly<{
    kind: 'result';
    runId: string;
    agentId: string;
    commandId: string;
    ok: boolean;
    result?: RallarBlackBoxTestResult;
    error?: Readonly<{
        code: string;
        message: string;
        details?: unknown;
    }>;
    replayed?: boolean;
}>;

export type RallarRemoteBrowserControlEventEnvelope = Readonly<{
    kind: 'event' | 'diagnostic' | 'stats' | 'report';
    runId: string;
    agentId: string;
    atEpochMs: number;
    eventId?: string;
    commandId?: string;
    payload: unknown;
}>;

export type RallarRemoteBrowserControlRunSnapshot = Readonly<{
    runId: string;
    results?: readonly RallarRemoteBrowserControlResultEnvelope[];
    events?: readonly RallarRemoteBrowserControlEventEnvelope[];
}>;

export type RallarRemoteBrowserConfig = Readonly<{
    controlBaseUrl: string;
    runId: string;
    agentId: string;
    token?: string;
    pollIntervalMs: number;
    timeoutMs: number;
}>;

type ControlResultEnvelope = RallarRemoteBrowserControlResultEnvelope;
type ControlEventEnvelope = RallarRemoteBrowserControlEventEnvelope;
type ControlRunSnapshot = RallarRemoteBrowserControlRunSnapshot;
type RemoteProviderConfig = RallarRemoteBrowserConfig;

const DEFAULT_CONTROL_BASE_URL = 'http://localhost:5180';
const DEFAULT_AGENT_ID = 'visible-agent-local';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function envValue(key: string): string | undefined {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env;
    return env?.[key];
}

function firstString(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
}

function toNumber(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function encodePath(value: string): string {
    return encodeURIComponent(value);
}

function authorizationHeaders(remote: RemoteProviderConfig): Record<string, string> {
    return remote.token
        ? {
            Authorization: `Bearer ${remote.token}`,
        }
        : {};
}

function remoteState(context: any): {
    seenEventIds: Set<string>;
} {
    if (!context.rallarRemoteBrowser) {
        context.rallarRemoteBrowser = {
            seenEventIds: new Set<string>(),
        };
    }
    return context.rallarRemoteBrowser;
}

export function resolveRallarRemoteBrowserConfig(
    request: any,
    config: any,
    context: any,
    options: RallarRemoteBrowserProviderOptions = {},
): RemoteProviderConfig {
    const remoteOptions = context.options?.rallarRemoteBrowser ??
        context.options?.remoteBrowser ??
        {};
    const requestControl = request.control ?? {};

    return {
        controlBaseUrl: firstString(
            request.controlBaseUrl,
            request.controlServerUrl,
            requestControl.baseUrl,
            config.controlBaseUrl,
            remoteOptions.controlBaseUrl,
            options.controlBaseUrl,
            envValue('RALLAR_BLACK_BOX_CONTROL_BASE_URL'),
        ) ?? DEFAULT_CONTROL_BASE_URL,
        runId: firstString(
            request.runId,
            request.controlRunId,
            requestControl.runId,
            config.runId,
            remoteOptions.runId,
            options.runId,
            envValue('RALLAR_BLACK_BOX_RUN_ID'),
        ) ?? 'remote-browser-run',
        agentId: firstString(
            request.agentId,
            request.controlAgentId,
            requestControl.agentId,
            config.agentId,
            remoteOptions.agentId,
            options.agentId,
            envValue('RALLAR_BLACK_BOX_AGENT_ID'),
        ) ?? DEFAULT_AGENT_ID,
        token: firstString(
            request.token,
            request.controlToken,
            requestControl.token,
            config.token,
            remoteOptions.token,
            options.token,
            envValue('RALLAR_BLACK_BOX_CONTROL_TOKEN'),
        ),
        pollIntervalMs: toNumber(
            request.pollIntervalMs ??
                requestControl.pollIntervalMs ??
                remoteOptions.pollIntervalMs ??
                options.pollIntervalMs,
            DEFAULT_POLL_INTERVAL_MS,
        ),
        timeoutMs: toNumber(
            request.timeoutMs ??
                requestControl.timeoutMs ??
                remoteOptions.timeoutMs ??
                options.timeoutMs,
            DEFAULT_TIMEOUT_MS,
        ),
    };
}

export function toRallarRemoteBrowserCommandId(action: string, interaction: any): string {
    const request = interaction.request ?? {};
    return firstString(
        request.commandId,
        request.remoteCommandId,
        [
            'rallar-remote-browser',
            action,
            request.scenarioExecutionNumber !== undefined
                ? `s${request.scenarioExecutionNumber}`
                : undefined,
            request.interactionExecutionNumber !== undefined
                ? `i${request.interactionExecutionNumber}`
                : undefined,
            request.repeatIndex !== undefined ? `r${request.repeatIndex}` : undefined,
            request.connection,
            request.actor,
        ]
            .filter(value => value !== undefined && value !== null && value !== '')
            .join('-'),
    ) ?? `rallar-remote-browser-${action}-${Date.now()}`;
}

function toRemoteConfig(
    request: any,
    config: any,
    context: any,
    options: RallarRemoteBrowserProviderOptions,
): RemoteProviderConfig {
    return resolveRallarRemoteBrowserConfig(request, config, context, options);
}

function commandIdFor(action: string, interaction: any): string {
    return toRallarRemoteBrowserCommandId(action, interaction);
}

function toTransport(request: any): 'realtime' | 'messages.rtc' | undefined {
    return request.transport === 'messages.rtc' ? 'messages.rtc' : request.transport === 'realtime'
        ? 'realtime'
        : undefined;
}

function toConnectCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    return {
        kind: 'rtc.connect',
        commandId,
        connection: toRtcConnectionName(request),
        actor: request.actor,
        roomId: request.roomId,
        transport: toTransport(request),
        rallar: request.rallar,
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request,
        },
    };
}

function toSendCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    return {
        kind: 'rtc.send',
        commandId,
        connection: toRtcConnectionName(request),
        send: toRtcPayload(request),
        expect: interaction.response?.message ?? interaction.response?.messages,
        transport: toTransport(request),
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request,
        },
    };
}

function toCloseCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    return {
        kind: 'close',
        commandId,
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            connection: toRtcConnectionName(request),
            blackBoxRunner: request,
        },
    };
}

async function readJson(response: Response): Promise<any> {
    return await response.json().catch(() => ({}));
}

async function enqueueCommand(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    command: RallarBlackBoxTestCommand,
): Promise<void> {
    const response = await fetchFn(
        joinUrl(
            remote.controlBaseUrl,
            `/runs/${encodePath(remote.runId)}/agents/${encodePath(remote.agentId)}/commands`,
        ),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(remote),
            },
            body: JSON.stringify({
                commandId: command.commandId,
                command,
            }),
        },
    );

    if (!response.ok) {
        const body = await readJson(response);
        throw new Error(
            `Control server rejected command ${command.commandId}: ${response.status} ${
                body.error ?? response.statusText
            }`,
        );
    }
}

async function fetchRunSnapshot(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
): Promise<ControlRunSnapshot | undefined> {
    const response = await fetchFn(joinUrl(remote.controlBaseUrl, `/runs/${encodePath(remote.runId)}`), {
        headers: authorizationHeaders(remote),
    });
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        const body = await readJson(response);
        throw new Error(`Control server run lookup failed: ${response.status} ${body.error ?? response.statusText}`);
    }
    return await readJson(response) as ControlRunSnapshot;
}

function eventPayload(event: ControlEventEnvelope): RallarBlackBoxTestEvent | undefined {
    const payload = event.payload;
    return payload && typeof payload === 'object' && 'kind' in payload
        ? payload as RallarBlackBoxTestEvent
        : undefined;
}

function parseRemoteWsData(data: unknown): unknown {
    if (typeof data !== 'string') {
        return data;
    }

    try {
        return JSON.parse(data);
    } catch (_ignored) {
        return data;
    }
}

function rememberRemoteWsMessage(connectionName: string, message: any, context: any): void {
    if (!context.wsMessages) {
        context.wsMessages = {};
    }
    if (!context.wsMessages[connectionName]) {
        context.wsMessages[connectionName] = [];
    }

    context.wsMessages[connectionName].push(message);
}

function rememberRemoteWsCloseEvent(connectionName: string, closeEvent: any, context: any): void {
    if (!context.wsCloseEvents) {
        context.wsCloseEvents = {};
    }
    if (!context.wsCloseEvents[connectionName]) {
        context.wsCloseEvents[connectionName] = [];
    }

    context.wsCloseEvents[connectionName].push(closeEvent);
}

function syncRemoteEvents(snapshot: ControlRunSnapshot | undefined, context: any): void {
    const state = remoteState(context);
    for (const event of snapshot?.events ?? []) {
        const id = event.eventId ?? `${event.kind}:${event.atEpochMs}:${event.commandId ?? ''}`;
        if (state.seenEventIds.has(id)) {
            continue;
        }

        state.seenEventIds.add(id);
        const payload = eventPayload(event);
        if (payload?.kind === 'message') {
            const connectionName = payload.connection ?? 'default';
            const messagePayload = payload.payload &&
                    typeof payload.payload === 'object' &&
                    'data' in payload.payload
                ? (payload.payload as { data: unknown }).data
                : payload.payload;
            if (payload.transport === 'ws') {
                rememberRemoteWsMessage(connectionName, {
                    data: parseRemoteWsData(messagePayload),
                    receivedAtEpochMs: payload.atEpochMs,
                    provider: 'rallar-remote-browser',
                    commandId: payload.commandId,
                }, context);
                continue;
            }

            rememberRtcMessage(connectionName, {
                data: messagePayload,
                receivedAtEpochMs: payload.atEpochMs,
                provider: 'rallar-remote-browser',
                actor: payload.actor,
                roomId: (payload.payload as { roomId?: unknown } | undefined)?.roomId,
                commandId: payload.commandId,
            }, context);
            continue;
        }

        if (
            payload?.kind === 'event' &&
            payload.transport === 'ws' &&
            payload.topic === 'rallar.bb.ws.closed'
        ) {
            const connectionName = payload.connection ?? 'default';
            const closePayload = payload.payload && typeof payload.payload === 'object'
                ? payload.payload as Record<string, unknown>
                : {};
            rememberRemoteWsCloseEvent(connectionName, {
                ...closePayload,
                closedAtEpochMs: payload.atEpochMs,
                provider: 'rallar-remote-browser',
                commandId: payload.commandId,
            }, context);
        }
    }
}

export async function syncRallarRemoteBrowserEvents(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
): Promise<ControlRunSnapshot | undefined> {
    const snapshot = await fetchRunSnapshot(remote, fetchFn);
    syncRemoteEvents(snapshot, context);
    return snapshot;
}

async function syncEvents(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
): Promise<ControlRunSnapshot | undefined> {
    return await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
}

async function waitForCommandResult(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    commandId: string,
): Promise<ControlResultEnvelope> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= remote.timeoutMs) {
        const snapshot = await syncEvents(remote, fetchFn, context);
        const result = snapshot?.results?.find(item => item.commandId === commandId);
        if (result) {
            return result;
        }
        await sleep(remote.pollIntervalMs);
    }

    throw new Error(`Timed out waiting for remote command result ${commandId}.`);
}

function resultDetails(result: ControlResultEnvelope): any {
    return result.result?.value ?? result.error?.details ?? result.error ?? result.result;
}

export async function executeRallarRemoteBrowserCommand(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    command: RallarBlackBoxTestCommand,
): Promise<ControlResultEnvelope> {
    await enqueueCommand(remote, fetchFn, command);
    return await waitForCommandResult(remote, fetchFn, context, command.commandId ?? '');
}

async function executeRemoteCommand(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    command: RallarBlackBoxTestCommand,
): Promise<ControlResultEnvelope> {
    return await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
}

function startEventSync(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
): number {
    let syncing = false;
    return setInterval(() => {
        if (syncing) {
            return;
        }
        syncing = true;
        void syncEvents(remote, fetchFn, context)
            .finally(() => {
                syncing = false;
            });
    }, remote.pollIntervalMs) as unknown as number;
}

async function waitWithRemoteEventSync(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    wait: () => Promise<any>,
): Promise<any> {
    await syncEvents(remote, fetchFn, context);
    const interval = startEventSync(remote, fetchFn, context);
    try {
        return await wait();
    } finally {
        clearInterval(interval);
    }
}

function toFailureFromError(config: any, interaction: any, message: string, error: unknown): any {
    return toRtcFailureStatus(config, interaction, message, {
        exception: error instanceof Error ? error.message : String(error),
    });
}

export function createRallarRemoteBrowserRtcProvider(
    options: RallarRemoteBrowserProviderOptions = {},
): RtcProvider {
    const fetchFn = options.fetch ?? fetch;

    return {
        connect: async (interaction, config, context): Promise<any> => {
            const remote = toRemoteConfig(interaction.request, config, context, options);
            const commandId = commandIdFor('connect', interaction);
            const command = toConnectCommand(commandId, interaction);
            const connectionName = toRtcConnectionName(interaction.request);

            try {
                const result = await executeRemoteCommand(remote, fetchFn, context, command);
                if (!result.ok) {
                    return toRtcFailureStatus(config, interaction, 'Remote RTC connect failed', {
                        connection: connectionName,
                        remote,
                        result,
                    });
                }

                context.rtcConnections[connectionName] = {
                    client: {
                        connect: async () => {
                            // The remote browser connection is already open after the connect command.
                        },
                        send: async () => {
                            throw new Error('Remote browser sends are executed through the provider.');
                        },
                        close: async () => {
                            await executeRemoteCommand(
                                remote,
                                fetchFn,
                                context,
                                toCloseCommand(`${commandId}-auto-close`, interaction),
                            );
                        },
                    },
                    remote: true,
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    request: interaction.request,
                    connectedAtEpochMs: Date.now(),
                    commandId,
                };
                context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
                context.rtcCloseEvents[connectionName] = context.rtcCloseEvents[connectionName] || [];

                return toRtcSuccessStatus(config, interaction, {
                    connection: connectionName,
                    connected: true,
                    provider: interaction.request.provider,
                    remote,
                    commandId,
                    result: resultDetails(result),
                });
            } catch (error) {
                return toFailureFromError(config, interaction, 'Remote RTC connect failed', error);
            }
        },

        send: async (interaction, config, context): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            if (!context.rtcConnections[connectionName]) {
                return toRtcFailureStatus(config, interaction, 'RTC connection is not open', {
                    connection: connectionName,
                });
            }

            const remote = toRemoteConfig(interaction.request, config, context, options);
            const commandId = commandIdFor('send', interaction);
            const command = toSendCommand(commandId, interaction);

            try {
                const result = await executeRemoteCommand(remote, fetchFn, context, command);
                if (!result.ok) {
                    return toRtcFailureStatus(config, interaction, 'Remote RTC send failed', {
                        connection: connectionName,
                        remote,
                        result,
                    });
                }

                const details = {
                    connection: connectionName,
                    sent: toRtcPayload(interaction.request),
                    provider: interaction.request.provider,
                    remote,
                    commandId,
                    result: resultDetails(result),
                };

                if (interaction.response?.messages) {
                    return waitWithRemoteEventSync(
                        remote,
                        fetchFn,
                        context,
                        () => waitForRtcMessages(interaction, config, context, details),
                    );
                }

                if (interaction.response?.message) {
                    return waitWithRemoteEventSync(
                        remote,
                        fetchFn,
                        context,
                        () => waitForRtcMessage(interaction, config, context, details),
                    );
                }

                return toRtcSuccessStatus(config, interaction, details);
            } catch (error) {
                return toFailureFromError(config, interaction, 'Remote RTC send failed', error);
            }
        },

        wait: async (interaction, config, context): Promise<any> => {
            const remote = toRemoteConfig(interaction.request, config, context, options);
            return waitWithRemoteEventSync(remote, fetchFn, context, () => {
                if (interaction.response?.close !== undefined) {
                    return waitForRtcClose(interaction, config, context, {
                        remote,
                    });
                }
                if (interaction.response?.messages) {
                    return waitForRtcMessages(interaction, config, context, {
                        remote,
                    });
                }
                return waitForRtcMessage(interaction, config, context, {
                    remote,
                });
            });
        },

        close: async (interaction, config, context): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const remote = toRemoteConfig(interaction.request, config, context, options);
            const commandId = commandIdFor('close', interaction);
            const command = toCloseCommand(commandId, interaction);

            try {
                const result = await executeRemoteCommand(remote, fetchFn, context, command);
                delete context.rtcConnections[connectionName];
                rememberRtcCloseEvent(connectionName, {
                    closeRequested: true,
                    closed: result.ok,
                    closedAtEpochMs: Date.now(),
                    provider: interaction.request.provider,
                    remote,
                    commandId,
                    result: resultDetails(result),
                }, context);

                if (!result.ok) {
                    return toRtcFailureStatus(config, interaction, 'Remote RTC close failed', {
                        connection: connectionName,
                        remote,
                        result,
                    });
                }

                return toRtcSuccessStatus(config, interaction, {
                    connection: connectionName,
                    closeRequested: true,
                    closed: true,
                    provider: interaction.request.provider,
                    remote,
                    commandId,
                    result: resultDetails(result),
                });
            } catch (error) {
                return toFailureFromError(config, interaction, 'Remote RTC close failed', error);
            }
        },
    };
}
