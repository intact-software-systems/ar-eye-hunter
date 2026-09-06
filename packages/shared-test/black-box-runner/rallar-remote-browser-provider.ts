import { storeRemoteBrowserEvents } from './remote-browser/store-remote-browser-events.ts';
// deno-lint-ignore-file no-explicit-any
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestResult
} from '../rallar-bb-test/types.ts';
import {
    toCloseCommand,
    toConnectCommand,
    toCrdtCommand,
    toHealthCommand,
    toRallarRemoteBrowserCommandId,
    toRallarScopeFields,
    toSendCommand
} from './remote-browser/remote-browser-commands.ts';
import {
    type RtcProvider
} from './rtc-provider.ts';
import {
    rememberRtcCloseEvent,
    rememberRtcDiagnostic,
    toRtcConnectionName,
    toRtcExpectedConnectionName,
    toRtcFailureStatus,
    toRtcSuccessStatus,
    waitForRtcClose,
    waitForRtcDiagnostic,
    waitForRtcDiagnostics,
    waitForRtcHealth,
    waitForRtcMessage,
    waitForRtcMessages
} from './rtc/rtc-wait-expectations.ts';

export type RallarRemoteBrowserControlFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
) => Promise<Response>;

export interface RallarRemoteBrowserProviderOptions {
    readonly controlBaseUrl?: string;
    readonly runId?: string;
    readonly agentId?: string;
    readonly token?: string;
    readonly fetch?: RallarRemoteBrowserControlFetch;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
}

export interface RallarRemoteBrowserControlError {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
}

export interface RallarRemoteBrowserControlResultEnvelope {
    readonly kind: 'result';
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly ok: boolean;
    readonly result?: RallarBlackBoxTestResult;
    readonly error?: RallarRemoteBrowserControlError;
    readonly replayed?: boolean;
}

export interface RallarRemoteBrowserControlEventEnvelope {
    readonly kind: 'event' | 'diagnostic' | 'stats' | 'report';
    readonly runId: string;
    readonly agentId: string;
    readonly atEpochMs: number;
    readonly eventId?: string;
    readonly commandId?: string;
    readonly payload: unknown;
}

export interface RallarRemoteBrowserControlRunSnapshot {
    readonly runId: string;
    readonly results?: readonly RallarRemoteBrowserControlResultEnvelope[];
    readonly events?: readonly RallarRemoteBrowserControlEventEnvelope[];
}

export interface RallarRemoteBrowserConfig {
    readonly controlBaseUrl: string;
    readonly runId: string;
    readonly agentId: string;
    readonly token?: string;
    readonly pollIntervalMs: number;
    readonly timeoutMs: number;
}

export interface ReadRallarRemoteBrowserConfigInput {
    readonly request: any;
    readonly config: any;
    readonly context: any;
    readonly options?: RallarRemoteBrowserProviderOptions;
}

export interface ExecuteRallarRemoteBrowserCommandInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    readonly context: any;
    readonly command: RallarBlackBoxTestCommand;
}

interface RemoteBrowserConfigCandidates {
    readonly controlBaseUrls: readonly unknown[];
    readonly runIds: readonly unknown[];
    readonly agentIds: readonly unknown[];
    readonly tokens: readonly unknown[];
    readonly pollIntervalMs: unknown;
    readonly timeoutMs: unknown;
}

interface RemoteCommandResultInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    readonly context: any;
    readonly commandId: string;
}

interface WaitWithRemoteEventSyncInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    readonly context: any;
    readonly wait: () => Promise<any>;
}

interface RemoteHealthInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    readonly context: any;
    readonly interaction: any;
    readonly commandId: string;
}

interface RemoteRtcWaitInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    readonly context: any;
    readonly interaction: any;
    readonly config: any;
    readonly details?: any;
}

type RemoteRtcExpectation = 'close' | 'diagnostics' | 'diagnostic' | 'health' | 'messages' | 'message' | 'none';

interface RemoteRtcSendSubmission {
    readonly remote: RallarRemoteBrowserConfig;
    readonly command: RallarBlackBoxTestCommand;
    readonly result: RallarRemoteBrowserControlResultEnvelope;
    readonly connectionName: string;
    readonly sendStartedAtEpochMs: number;
    readonly sendEndedAtEpochMs: number;
}

interface RemoteRtcConnectCompletion {
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly connectionName: string;
    readonly result: RallarRemoteBrowserControlResultEnvelope;
    readonly connectStartedAtEpochMs: number;
    readonly connectedAtEpochMs: number;
}

interface RemoteRtcConnectedState {
    readonly connection: any;
    readonly details: any;
}

interface RemoteCrdtCompletion {
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly result: RallarRemoteBrowserControlResultEnvelope;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
}

interface RemoteRtcCloseCompletion {
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly connectionName: string;
    readonly result: RallarRemoteBrowserControlResultEnvelope;
}

interface RtcProviderFailureStatusInput {
    readonly config: any;
    readonly interaction: any;
    readonly result: string;
    readonly details?: any;
}

interface FailureFromErrorInput {
    readonly config: any;
    readonly interaction: any;
    readonly message: string;
    readonly error: unknown;
}

const DEFAULT_CONTROL_BASE_URL = 'http://localhost:5180';
const DEFAULT_AGENT_ID = 'visible-agent-local';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function readEnvironmentValue(key: string): string | undefined {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined>; }; })
        .process?.env;
    return env?.[key];
}

function firstString(values: readonly unknown[]): string | undefined {
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
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function authorizationHeaders(remote: RallarRemoteBrowserConfig): Record<string, string> {
    return remote.token
        ? {
            Authorization: `Bearer ${remote.token}`
        }
        : {};
}

export function readRallarRemoteBrowserConfig(input: ReadRallarRemoteBrowserConfigInput): RallarRemoteBrowserConfig {
    const { request, config, context } = input;
    const options = input.options ?? {};
    const remoteOptions = context.options?.rallarRemoteBrowser ?? context.options?.remoteBrowser ?? {};
    const control = request.control ?? {};
    return computeRemoteBrowserConfig({
        controlBaseUrls: [
            request.controlBaseUrl,
            request.controlServerUrl,
            control.baseUrl,
            config.controlBaseUrl,
            remoteOptions.controlBaseUrl,
            options.controlBaseUrl,
            readEnvironmentValue('RALLAR_BLACK_BOX_CONTROL_BASE_URL')
        ],
        runIds: [
            request.runId,
            request.controlRunId,
            control.runId,
            config.runId,
            remoteOptions.runId,
            options.runId,
            readEnvironmentValue('RALLAR_BLACK_BOX_RUN_ID')
        ],
        agentIds: [
            request.agentId,
            request.controlAgentId,
            control.agentId,
            config.agentId,
            remoteOptions.agentId,
            options.agentId,
            readEnvironmentValue('RALLAR_BLACK_BOX_AGENT_ID')
        ],
        tokens: [
            request.token,
            request.controlToken,
            control.token,
            config.token,
            remoteOptions.token,
            options.token,
            readEnvironmentValue('RALLAR_BLACK_BOX_CONTROL_TOKEN')
        ],
        pollIntervalMs: request.pollIntervalMs ?? control.pollIntervalMs ?? remoteOptions.pollIntervalMs ??
            options.pollIntervalMs,
        timeoutMs: request.timeoutMs ?? control.timeoutMs ?? remoteOptions.timeoutMs ?? options.timeoutMs
    });
}

function computeRemoteBrowserConfig(candidates: RemoteBrowserConfigCandidates): RallarRemoteBrowserConfig {
    return {
        controlBaseUrl: firstString(candidates.controlBaseUrls) ?? DEFAULT_CONTROL_BASE_URL,
        runId: firstString(candidates.runIds) ?? 'remote-browser-run',
        agentId: firstString(candidates.agentIds) ?? DEFAULT_AGENT_ID,
        token: firstString(candidates.tokens),
        pollIntervalMs: toNumber(candidates.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
        timeoutMs: toNumber(candidates.timeoutMs, DEFAULT_TIMEOUT_MS)
    };
}

function toCrdtProviderReportFields(interaction: any): any {
    return {
        provider: interaction.request.provider,
        action: interaction.request.action,
        connection: interaction.request.connection,
        handle: interaction.request.handle,
        documentName: interaction.request.name,
        applicationId: interaction.request.applicationId,
        workspaceId: interaction.request.workspaceId,
        documentId: interaction.request.documentId,
        documentType: interaction.request.documentType,
        scope: interaction.request.scope,
        roomRef: interaction.request.roomRef,
        transportStrategy: interaction.request.transport,
        durableCatchUp: interaction.request.durableCatchUp
    };
}

function toCrdtProviderSuccessStatus(config: any, interaction: any, details: any = {}): any {
    return {
        name: config.interactionName,
        status: 'SUCCESS',
        transport: 'CRDT',
        ...toCrdtProviderReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toCrdtProviderReportFields(interaction),
            ...details
        },
        ...config
    };
}

function toCrdtProviderFailureStatus(input: RtcProviderFailureStatusInput): any {
    const { config, interaction, result } = input;
    return {
        name: config.interactionName,
        status: 'FAILURE',
        result,
        transport: 'CRDT',
        ...toCrdtProviderReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toCrdtProviderReportFields(interaction),
            ...(input.details ?? {})
        },
        ...config
    };
}

async function readJson(response: Response): Promise<any> {
    return await response.json().catch(() => ({}));
}

async function enqueueCommand(
    remote: RallarRemoteBrowserConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    command: RallarBlackBoxTestCommand
): Promise<void> {
    const response = await fetchFn(
        joinUrl(
            remote.controlBaseUrl,
            `/runs/${encodeURIComponent(remote.runId)}/agents/${encodeURIComponent(remote.agentId)}/commands`
        ),
        {
            method: 'POST',
            signal: AbortSignal.timeout(remote.timeoutMs),
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(remote)
            },
            body: JSON.stringify({
                commandId: command.commandId,
                command
            })
        }
    );

    if (!response.ok) {
        const body = await readJson(response);
        throw new Error(
            `Control server rejected command ${command.commandId}: ${response.status} ${
                body.error ?? response.statusText
            }`
        );
    }
}

async function fetchRunSnapshot(
    remote: RallarRemoteBrowserConfig,
    fetchFn: RallarRemoteBrowserControlFetch
): Promise<RallarRemoteBrowserControlRunSnapshot | undefined> {
    const response = await fetchFn(joinUrl(remote.controlBaseUrl, `/runs/${encodeURIComponent(remote.runId)}`), {
        headers: authorizationHeaders(remote),
        signal: AbortSignal.timeout(remote.timeoutMs)
    });
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        const body = await readJson(response);
        throw new Error(`Control server run lookup failed: ${response.status} ${body.error ?? response.statusText}`);
    }
    return await readJson(response) as RallarRemoteBrowserControlRunSnapshot;
}

export async function syncRallarRemoteBrowserEvents(
    remote: RallarRemoteBrowserConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any
): Promise<RallarRemoteBrowserControlRunSnapshot | undefined> {
    const snapshot = await fetchRunSnapshot(remote, fetchFn);
    storeRemoteBrowserEvents(snapshot, context);
    return snapshot;
}

async function waitForCommandResult(
    input: RemoteCommandResultInput
): Promise<RallarRemoteBrowserControlResultEnvelope> {
    const { remote, fetchFn, context, commandId } = input;
    const startedAt = Date.now();
    while (Date.now() - startedAt <= remote.timeoutMs) {
        const snapshot = await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
        const result = snapshot?.results?.find((item) =>
            item.commandId === commandId && item.runId === remote.runId && item.agentId === remote.agentId
        );
        if (result) {
            return result;
        }
        await sleep(remote.pollIntervalMs);
    }

    throw new Error(`Timed out waiting for remote command result ${commandId}.`);
}

function resultDetails(result: RallarRemoteBrowserControlResultEnvelope): any {
    return result.result?.value ?? result.error?.details ?? result.error ?? result.result;
}

function toRemoteSendResult(
    status: string,
    connectionName: string,
    result: RallarRemoteBrowserControlResultEnvelope
): any {
    return {
        status,
        connection: connectionName,
        remoteResult: resultDetails(result)
    };
}

export async function executeRallarRemoteBrowserCommand(
    input: ExecuteRallarRemoteBrowserCommandInput
): Promise<RallarRemoteBrowserControlResultEnvelope> {
    const { remote, fetchFn, command } = input;
    await enqueueCommand(remote, fetchFn, command);
    return await waitForCommandResult({ ...input, commandId: command.commandId ?? '' });
}

async function waitWithRemoteEventSync(input: WaitWithRemoteEventSyncInput): Promise<any> {
    const { remote, fetchFn, context, wait } = input;
    await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
    const synchronization = new RemoteBrowserObservationSync({ kind: 'events', remote, fetchFn, context });
    synchronization.start();
    try {
        return await wait();
    }
    finally {
        await synchronization.stop();
    }
}

async function updateRemoteHealthDiagnostics(input: RemoteHealthInput): Promise<void> {
    const { remote, fetchFn, context, interaction, commandId } = input;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const result = await executeRallarRemoteBrowserCommand({
        remote,
        fetchFn,
        context,
        command: toHealthCommand(commandId, interaction)
    });
    if (!result.ok) {
        return;
    }

    const health = resultDetails(result);
    if (context.rtcConnections?.[connectionName]) {
        context.rtcConnections[connectionName].diagnostics = health;
    }
    rememberRtcDiagnostic(connectionName, {
        kind: 'diagnostic',
        topic: 'rallar.remote-browser.health',
        severity: 'info',
        atEpochMs: Date.now(),
        commandId,
        connection: connectionName,
        provider: 'rallar-remote-browser',
        data: health,
        event: result
    }, context);
}

async function waitForRemoteRtcHealth(input: RemoteRtcWaitInput): Promise<any> {
    const { remote, fetchFn, context, interaction, config } = input;
    const details = input.details ?? {};
    const commandIdPrefix = toRallarRemoteBrowserCommandId('health', interaction);
    await updateRemoteHealthDiagnostics({
        remote,
        fetchFn,
        context,
        interaction,
        commandId: `${commandIdPrefix}-health-0`
    }).catch(() => undefined);

    const synchronization = new RemoteBrowserObservationSync({
        kind: 'health',
        remote,
        fetchFn,
        context,
        interaction,
        commandIdPrefix
    });
    synchronization.start();
    try {
        return await waitForRtcHealth({ interaction, config, context, details: details });
    }
    finally {
        await synchronization.stop();
    }
}

function toRemoteRtcExpectation(response: any, phase: 'send' | 'wait'): RemoteRtcExpectation {
    if (phase === 'wait' && response?.close !== undefined) {
        return 'close';
    }
    if (phase === 'send' && response?.messages) {
        return 'messages';
    }
    if (response?.diagnostics) {
        return 'diagnostics';
    }
    if (response?.diagnostic) {
        return 'diagnostic';
    }
    if (response?.health !== undefined) {
        return 'health';
    }
    if (response?.messages) {
        return 'messages';
    }
    return response?.message ? 'message' : 'none';
}

async function waitForRemoteRtcObservation(input: RemoteRtcWaitInput, expectation: RemoteRtcExpectation): Promise<any> {
    if (expectation === 'health') {
        return waitForRemoteRtcHealth(input);
    }
    return waitWithRemoteEventSync({
        remote: input.remote,
        fetchFn: input.fetchFn,
        context: input.context,
        wait: () => waitForRemoteRtcMatch(input, expectation)
    });
}

function waitForRemoteRtcMatch(input: RemoteRtcWaitInput, expectation: RemoteRtcExpectation): Promise<any> {
    switch (expectation) {
        case 'close':
            return waitForRtcClose(input);
        case 'diagnostics':
            return waitForRtcDiagnostics(input);
        case 'diagnostic':
            return waitForRtcDiagnostic(input);
        case 'messages':
            return waitForRtcMessages(input);
        case 'message':
            return waitForRtcMessage(input);
        default:
            return Promise.resolve(toRtcFailureStatus({
                config: input.config,
                interaction: input.interaction,
                result:
                    'RTC wait expects expect.message, expect.messages, expect.diagnostic, expect.diagnostics, expect.health, or expect.close',
                details: { connection: toRtcExpectedConnectionName(input.interaction), remote: input.remote }
            }));
    }
}

function toRemoteRtcSendDetails(interaction: any, submission: RemoteRtcSendSubmission): any {
    const { remote, command, result, connectionName, sendStartedAtEpochMs, sendEndedAtEpochMs } = submission;
    return {
        connection: connectionName,
        sent: command.kind === 'rtc.send' ? command.send : undefined,
        provider: interaction.request.provider,
        remote,
        commandId: command.commandId,
        ...toRallarScopeFields(interaction.request),
        result: resultDetails(result),
        sendResult: toRemoteSendResult('sent', connectionName, result),
        sendStartedAtEpochMs,
        sendEndedAtEpochMs,
        sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
    };
}

function toRemoteRtcSendFailure(config: any, interaction: any, submission: RemoteRtcSendSubmission): any {
    const { remote, result, connectionName, sendStartedAtEpochMs, sendEndedAtEpochMs } = submission;
    return toRtcFailureStatus({
        config,
        interaction,
        result: 'Remote RTC send failed',
        details: {
            connection: connectionName,
            remote,
            result,
            sendResult: toRemoteSendResult('failed', connectionName, result),
            sendStartedAtEpochMs,
            sendEndedAtEpochMs,
            sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
        }
    });
}

function computeRemoteRtcConnectedState(
    interaction: any,
    completion: RemoteRtcConnectCompletion
): RemoteRtcConnectedState {
    const { remote, commandId, connectionName, result, connectStartedAtEpochMs, connectedAtEpochMs } = completion;
    const diagnostics = resultDetails(result);
    const metadata = {
        provider: interaction.request.provider,
        connectStartedAtEpochMs,
        connectedAtEpochMs,
        connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs,
        diagnostics,
        commandId
    };
    return {
        connection: {
            ...metadata,
            remote: true,
            actor: interaction.request.actor,
            roomId: interaction.request.roomId,
            request: interaction.request
        },
        details: {
            ...metadata,
            connection: connectionName,
            connected: true,
            remote,
            ...toRallarScopeFields(interaction.request),
            result: diagnostics
        }
    };
}

function storeRemoteRtcConnection(context: any, connectionName: string, connection: any): void {
    context.rtcConnections[connectionName] = connection;
    context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
    context.rtcDiagnostics = context.rtcDiagnostics || {};
    context.rtcDiagnostics[connectionName] = context.rtcDiagnostics[connectionName] || [];
    context.rtcCloseEvents[connectionName] = context.rtcCloseEvents[connectionName] || [];
}

function toRemoteRtcConnectFailure(config: any, interaction: any, completion: RemoteRtcConnectCompletion): any {
    const { remote, connectionName, result, connectStartedAtEpochMs, connectedAtEpochMs } = completion;
    return toRtcFailureStatus({
        config,
        interaction,
        result: 'Remote RTC connect failed',
        details: {
            connection: connectionName,
            remote,
            result,
            connectStartedAtEpochMs,
            connectFailedAtEpochMs: connectedAtEpochMs,
            connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs
        }
    });
}

function toRemoteCrdtStatus(config: any, interaction: any, completion: RemoteCrdtCompletion): any {
    const { remote, commandId, result, startedAtEpochMs, endedAtEpochMs } = completion;
    const details = {
        remote,
        commandId,
        result: result.ok ? resultDetails(result) : result,
        startedAtEpochMs,
        endedAtEpochMs,
        latencyMs: endedAtEpochMs - startedAtEpochMs
    };
    return result.ok
        ? toCrdtProviderSuccessStatus(config, interaction, details)
        : toCrdtProviderFailureStatus({ config, interaction, result: 'Remote CRDT command failed', details });
}

function toRemoteRtcCloseStatus(config: any, interaction: any, completion: RemoteRtcCloseCompletion): any {
    const { remote, commandId, connectionName, result } = completion;
    if (!result.ok) {
        return toRtcFailureStatus({
            config,
            interaction,
            result: 'Remote RTC close failed',
            details: { connection: connectionName, remote, result }
        });
    }
    return toRtcSuccessStatus(config, interaction, {
        connection: connectionName,
        closeRequested: true,
        closed: true,
        provider: interaction.request.provider,
        remote,
        commandId,
        result: resultDetails(result)
    });
}

function toFailureFromError(input: FailureFromErrorInput): any {
    const { config, interaction, message, error } = input;
    return toRtcFailureStatus({
        config,
        interaction,
        result: message,
        details: {
            exception: error instanceof Error ? error.message : String(error)
        }
    });
}

export function createRallarRemoteBrowserRtcProvider(options: RallarRemoteBrowserProviderOptions = {}): RtcProvider {
    const provider = new RallarRemoteBrowserRtcProvider(options, options.fetch ?? fetch);
    return {
        connect: provider.connect.bind(provider),
        send: provider.send.bind(provider),
        wait: provider.wait.bind(provider),
        command: provider.command.bind(provider),
        close: provider.close.bind(provider)
    };
}

namespace RemoteBrowserObservationSync {
    interface Connection {
        readonly remote: RallarRemoteBrowserConfig;
        readonly fetchFn: RallarRemoteBrowserControlFetch;
        readonly context: any;
    }
    export interface Events extends Connection {
        readonly kind: 'events';
    }
    export interface Health extends Connection {
        readonly kind: 'health';
        readonly interaction: any;
        readonly commandIdPrefix: string;
    }
    export type Input = Events | Health;
}

class RemoteBrowserObservationSync {
    private readonly input: RemoteBrowserObservationSync.Input;
    private interval: ReturnType<typeof setInterval> | undefined;
    private pending: Promise<void> = Promise.resolve();
    private syncing = false;
    private sequence = 0;
    private failure: Error | undefined;

    constructor(input: RemoteBrowserObservationSync.Input) {
        this.input = input;
    }

    start(): void {
        if (this.interval === undefined) {
            this.interval = setInterval(() => this.poll(), this.input.remote.pollIntervalMs);
        }
    }

    async stop(): Promise<void> {
        clearInterval(this.interval);
        this.interval = undefined;
        await this.pending;
        if (this.failure !== undefined) {
            throw this.failure;
        }
    }

    private poll(): void {
        if (this.interval === undefined || this.syncing || this.failure !== undefined) {
            return;
        }
        this.syncing = true;
        this.pending = this.readObservation().finally(() => {
            this.syncing = false;
        });
    }

    private async readObservation(): Promise<void> {
        const input = this.input;
        try {
            if (input.kind === 'health') {
                this.sequence++;
                await updateRemoteHealthDiagnostics({
                    remote: input.remote,
                    fetchFn: input.fetchFn,
                    context: input.context,
                    interaction: input.interaction,
                    commandId: `${input.commandIdPrefix}-health-${this.sequence}`
                });
            }
            else {
                await syncRallarRemoteBrowserEvents(input.remote, input.fetchFn, input.context);
            }
        }
        catch (error) {
            if (input.kind === 'events') {
                this.failure = error instanceof Error ? error : new Error(String(error));
            }
            // Health probes may recover on the next tick; the health waiter owns their deadline.
        }
    }
}

class RemoteRtcConnection {
    private readonly closeCommand: ExecuteRallarRemoteBrowserCommandInput;

    constructor(closeCommand: ExecuteRallarRemoteBrowserCommandInput) {
        this.closeCommand = closeCommand;
    }

    async close(): Promise<void> {
        const result = await executeRallarRemoteBrowserCommand(this.closeCommand);
        if (!result.ok) {
            throw new Error(result.error?.message ?? 'Remote RTC close failed');
        }
    }
}

class RallarRemoteBrowserRtcProvider implements RtcProvider {
    readonly options: RallarRemoteBrowserProviderOptions;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    constructor(options: RallarRemoteBrowserProviderOptions, fetchFn: RallarRemoteBrowserControlFetch) {
        this.options = options;
        this.fetchFn = fetchFn;
    }
    async connect(interaction: any, config: any, context: any): Promise<any> {
        const { options, fetchFn } = this;

        const remote = readRallarRemoteBrowserConfig({
            request: interaction.request,
            config,
            context,
            options
        });
        const commandId = toRallarRemoteBrowserCommandId('connect', interaction);
        const command = toConnectCommand(commandId, interaction);
        const connectionName = toRtcConnectionName(interaction.request);
        const connectStartedAtEpochMs = Date.now();

        try {
            const result = await executeRallarRemoteBrowserCommand({
                remote,
                fetchFn,
                context,
                command
            });
            const connectedAtEpochMs = Date.now();
            const completion = {
                remote,
                commandId,
                connectionName,
                result,
                connectStartedAtEpochMs,
                connectedAtEpochMs
            };
            if (!result.ok) {
                return toRemoteRtcConnectFailure(config, interaction, completion);
            }
            const connected = computeRemoteRtcConnectedState(interaction, completion);
            const client = new RemoteRtcConnection({
                remote,
                fetchFn,
                context,
                command: toCloseCommand(`${commandId}-auto-close`, interaction)
            });
            storeRemoteRtcConnection(context, connectionName, { client, ...connected.connection });
            return toRtcSuccessStatus(config, interaction, connected.details);
        }
        catch (error) {
            return toFailureFromError({
                config,
                interaction,
                message: 'Remote RTC connect failed',
                error
            });
        }
    }

    async send(interaction: any, config: any, context: any): Promise<any> {
        const { options, fetchFn } = this;

        const connectionName = toRtcConnectionName(interaction.request);
        if (!context.rtcConnections[connectionName]) {
            return toRtcFailureStatus({
                config,
                interaction,
                result: 'RTC connection is not open',
                details: {
                    connection: connectionName
                }
            });
        }

        const remote = readRallarRemoteBrowserConfig({
            request: interaction.request,
            config,
            context,
            options
        });
        const commandId = toRallarRemoteBrowserCommandId('send', interaction);
        const command = toSendCommand(commandId, interaction);

        try {
            const sendStartedAtEpochMs = Date.now();
            const result = await executeRallarRemoteBrowserCommand({
                remote,
                fetchFn,
                context,
                command
            });
            const sendEndedAtEpochMs = Date.now();
            const submission = { remote, command, result, connectionName, sendStartedAtEpochMs, sendEndedAtEpochMs };
            if (!result.ok) {
                return toRemoteRtcSendFailure(config, interaction, submission);
            }
            const details = toRemoteRtcSendDetails(interaction, submission);
            const expectation = toRemoteRtcExpectation(interaction.response, 'send');
            if (expectation === 'none') {
                return toRtcSuccessStatus(config, interaction, details);
            }
            return waitForRemoteRtcObservation({ remote, fetchFn, context, interaction, config, details }, expectation);
        }
        catch (error) {
            return toFailureFromError({
                config,
                interaction,
                message: 'Remote RTC send failed',
                error
            });
        }
    }

    async command(interaction: any, config: any, context: any): Promise<any> {
        const { options, fetchFn } = this;

        const remote = readRallarRemoteBrowserConfig({
            request: interaction.request,
            config,
            context,
            options
        });
        const action = String(interaction.request.action || 'open');
        const commandId = toRallarRemoteBrowserCommandId(`crdt-${action}`, interaction);

        try {
            const commandResult = toCrdtCommand(commandId, interaction);
            if (commandResult.right === undefined) {
                return toCrdtProviderFailureStatus({
                    config,
                    interaction,
                    result: 'Remote CRDT command failed',
                    details: { remote, commandId, error: commandResult.left?.message }
                });
            }
            const startedAtEpochMs = Date.now();
            const result = await executeRallarRemoteBrowserCommand({
                remote,
                fetchFn,
                context,
                command: commandResult.right
            });
            const endedAtEpochMs = Date.now();
            return toRemoteCrdtStatus(config, interaction, {
                remote,
                commandId,
                result,
                startedAtEpochMs,
                endedAtEpochMs
            });
        }
        catch (error) {
            return toCrdtProviderFailureStatus({
                config,
                interaction,
                result: 'Remote CRDT command failed',
                details: {
                    remote,
                    commandId,
                    error: error instanceof Error ? error.message : String(error)
                }
            });
        }
    }

    async wait(interaction: any, config: any, context: any): Promise<any> {
        const { options, fetchFn } = this;
        const remote = readRallarRemoteBrowserConfig({ request: interaction.request, config, context, options });
        const input = { remote, fetchFn, context, interaction, config, details: { remote } };
        const expectation = toRemoteRtcExpectation(interaction.response, 'wait');
        if (expectation === 'health') {
            return waitWithRemoteEventSync({ remote, fetchFn, context, wait: () => waitForRemoteRtcHealth(input) });
        }
        return waitForRemoteRtcObservation(input, expectation);
    }

    async close(interaction: any, config: any, context: any): Promise<any> {
        const { options, fetchFn } = this;

        const connectionName = toRtcConnectionName(interaction.request);
        const remote = readRallarRemoteBrowserConfig({
            request: interaction.request,
            config,
            context,
            options
        });
        const commandId = toRallarRemoteBrowserCommandId('close', interaction);
        const command = toCloseCommand(commandId, interaction);

        try {
            const result = await executeRallarRemoteBrowserCommand({
                remote,
                fetchFn,
                context,
                command
            });
            if (result.ok) {
                delete context.rtcConnections[connectionName];
            }
            rememberRtcCloseEvent(connectionName, {
                closeRequested: true,
                closed: result.ok,
                closedAtEpochMs: Date.now(),
                provider: interaction.request.provider,
                remote,
                commandId,
                result: resultDetails(result)
            }, context);

            return toRemoteRtcCloseStatus(config, interaction, { remote, commandId, connectionName, result });
        }
        catch (error) {
            return toFailureFromError({
                config,
                interaction,
                message: 'Remote RTC close failed',
                error
            });
        }
    }
}
