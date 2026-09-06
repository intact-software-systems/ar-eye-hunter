// deno-lint-ignore-file no-explicit-any
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult
} from '../rallar-bb-test/types.ts';
import {
    rememberRtcCloseEvent,
    rememberRtcDiagnostic,
    rememberRtcMessage,
    toRtcConnectionName,
    toRtcExpectedConnectionName,
    toRtcFailureStatus,
    toRtcPayload,
    toRtcSuccessStatus,
    waitForRtcClose,
    waitForRtcDiagnostic,
    waitForRtcDiagnostics,
    waitForRtcHealth,
    waitForRtcMessage,
    waitForRtcMessageCount,
    waitForRtcMessages,
    type RtcProvider
} from './rtc-provider.ts';

export type RallarRemoteBrowserControlFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
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
    const env = (globalThis as { process?: { env?: Record<string, string | undefined>; }; })
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

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function firstDefined(...values: readonly unknown[]): unknown {
    return values.find((value) => value !== undefined);
}

function toRallarScope(request: any): Record<string, unknown> | undefined {
    const rallar = asRecord(request.rallar);
    const scope = asRecord(firstDefined(request.scope, rallar.scope));
    const roomRef = asRecord(firstDefined(request.roomRef, rallar.roomRef));
    const applicationId = firstDefined(
        request.applicationId,
        rallar.applicationId,
        scope.applicationId,
        roomRef.applicationId
    );
    if (applicationId === undefined) {
        return undefined;
    }

    const workspaceId = firstDefined(
        request.workspaceId,
        rallar.workspaceId,
        scope.workspaceId,
        roomRef.workspaceId
    );

    return {
        applicationId: String(applicationId),
        ...(workspaceId !== undefined ? { workspaceId: String(workspaceId) } : {})
    };
}

function toRallarRoomRef(request: any): Record<string, unknown> | undefined {
    const rallar = asRecord(request.rallar);
    const explicitRoomRef = asRecord(firstDefined(request.roomRef, rallar.roomRef));
    if (explicitRoomRef.applicationId && explicitRoomRef.groupId) {
        return {
            applicationId: String(explicitRoomRef.applicationId),
            ...(explicitRoomRef.workspaceId !== undefined
                ? { workspaceId: String(explicitRoomRef.workspaceId) }
                : {}),
            groupId: String(explicitRoomRef.groupId)
        };
    }

    const scope = toRallarScope(request);
    const roomId = firstDefined(request.roomId, rallar.roomId);
    if (!scope?.applicationId || !roomId) {
        return undefined;
    }

    return {
        applicationId: scope.applicationId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        groupId: String(roomId)
    };
}

function toRallarScopeFields(request: any): Record<string, unknown> {
    const scope = toRallarScope(request);
    const roomRef = toRallarRoomRef(request);
    const rallar = asRecord(request.rallar);
    const minSnapshotVersion = firstDefined(
        request.minSnapshotVersion,
        rallar.minSnapshotVersion
    );

    return {
        ...(scope?.applicationId ? { applicationId: scope.applicationId } : {}),
        ...(scope?.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope ? { scope } : {}),
        ...(roomRef ? { roomRef } : {}),
        ...(minSnapshotVersion !== undefined ? { minSnapshotVersion } : {})
    };
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

function encodePath(value: string): string {
    return encodeURIComponent(value);
}

function authorizationHeaders(remote: RemoteProviderConfig): Record<string, string> {
    return remote.token
        ? {
            Authorization: `Bearer ${remote.token}`
        }
        : {};
}

function remoteState(context: any): {
    seenEventIds: Set<string>;
} {
    if (!context.rallarRemoteBrowser) {
        context.rallarRemoteBrowser = {
            seenEventIds: new Set<string>()
        };
    }
    return context.rallarRemoteBrowser;
}

export function resolveRallarRemoteBrowserConfig(
    request: any,
    config: any,
    context: any,
    options: RallarRemoteBrowserProviderOptions = {}
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
            envValue('RALLAR_BLACK_BOX_CONTROL_BASE_URL')
        ) ?? DEFAULT_CONTROL_BASE_URL,
        runId: firstString(
            request.runId,
            request.controlRunId,
            requestControl.runId,
            config.runId,
            remoteOptions.runId,
            options.runId,
            envValue('RALLAR_BLACK_BOX_RUN_ID')
        ) ?? 'remote-browser-run',
        agentId: firstString(
            request.agentId,
            request.controlAgentId,
            requestControl.agentId,
            config.agentId,
            remoteOptions.agentId,
            options.agentId,
            envValue('RALLAR_BLACK_BOX_AGENT_ID')
        ) ?? DEFAULT_AGENT_ID,
        token: firstString(
            request.token,
            request.controlToken,
            requestControl.token,
            config.token,
            remoteOptions.token,
            options.token,
            envValue('RALLAR_BLACK_BOX_CONTROL_TOKEN')
        ),
        pollIntervalMs: toNumber(
            request.pollIntervalMs ??
                requestControl.pollIntervalMs ??
                remoteOptions.pollIntervalMs ??
                options.pollIntervalMs,
            DEFAULT_POLL_INTERVAL_MS
        ),
        timeoutMs: toNumber(
            request.timeoutMs ??
                requestControl.timeoutMs ??
                remoteOptions.timeoutMs ??
                options.timeoutMs,
            DEFAULT_TIMEOUT_MS
        )
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
            request.actor
        ]
            .filter((value) => value !== undefined && value !== null && value !== '')
            .join('-')
    ) ?? `rallar-remote-browser-${action}-${Date.now()}`;
}

function toRemoteConfig(
    request: any,
    config: any,
    context: any,
    options: RallarRemoteBrowserProviderOptions
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
    const scopeFields = toRallarScopeFields(request);
    return {
        kind: 'rtc.connect',
        commandId,
        connection: toRtcConnectionName(request),
        actor: request.actor,
        roomId: request.roomId,
        ...scopeFields,
        transport: toTransport(request),
        readiness: request.readiness,
        rallar: {
            ...asRecord(request.rallar),
            ...scopeFields
        },
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request
        }
    };
}

function toSendCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    const scopeFields = toRallarScopeFields(request);
    const payload = toRtcPayload(request);
    const send = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? {
            ...payload,
            ...Object.fromEntries(
                Object.entries(scopeFields).filter(([key]) => !(key in payload))
            )
        }
        : {
            data: payload,
            ...scopeFields
        };
    return {
        kind: 'rtc.send',
        commandId,
        connection: toRtcConnectionName(request),
        send,
        expect: interaction.response?.message ?? interaction.response?.messages,
        ...scopeFields,
        transport: toTransport(request),
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request
        }
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
            blackBoxRunner: request
        }
    };
}

function toHealthCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    return {
        kind: 'health',
        commandId,
        timeoutMs: interaction.request?.timeoutMs,
        metadata: {
            connection: toRtcConnectionName(interaction.request ?? {}),
            blackBoxRunner: interaction.request
        }
    };
}

function toCrdtCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    const action = String(request.action || 'open');
    const metadata = {
        ...(request.parity ? { parity: request.parity } : {}),
        connection: toRtcConnectionName(request),
        blackBoxRunner: request
    };

    if (action === 'open') {
        return {
            kind: 'crdt.open',
            commandId,
            handle: request.handle,
            name: request.name,
            applicationId: request.applicationId,
            workspaceId: request.workspaceId,
            documentId: request.documentId,
            documentType: request.documentType,
            scope: request.scope,
            roomRef: request.roomRef,
            principalId: request.principalId,
            customScope: request.customScope,
            transport: request.transport,
            persist: request.persist,
            tabSync: request.tabSync,
            initialValue: request.initialValue,
            policies: request.policies,
            validation: request.validation,
            encryption: request.encryption,
            durableCatchUp: request.durableCatchUp,
            timeoutMs: request.timeoutMs,
            metadata
        } as RallarBlackBoxTestCommand;
    }

    if (action === 'apply') {
        return {
            kind: 'crdt.apply',
            commandId,
            handle: request.handle,
            batch: request.batch,
            timeoutMs: request.timeoutMs,
            metadata
        } as RallarBlackBoxTestCommand;
    }

    if (action === 'sync') {
        return {
            kind: 'crdt.sync',
            commandId,
            handle: request.handle,
            reason: request.reason,
            transport: request.transport,
            timeoutMs: request.timeoutMs,
            metadata
        } as RallarBlackBoxTestCommand;
    }

    if (action === 'wait') {
        return {
            kind: 'crdt.wait',
            commandId,
            handle: request.handle,
            intervalMs: request.intervalMs,
            stableForMs: request.stableForMs,
            sync: request.sync,
            conditions: request.conditions,
            timeoutMs: request.timeoutMs,
            metadata
        } as RallarBlackBoxTestCommand;
    }

    if (action === 'undo' || action === 'redo') {
        return {
            kind: action === 'undo' ? 'crdt.undo' : 'crdt.redo',
            commandId,
            handle: request.handle,
            targetOperationGroupId: request.targetOperationGroupId,
            operations: request.operations,
            operationGroupId: request.operationGroupId,
            timeoutMs: request.timeoutMs,
            metadata
        } as RallarBlackBoxTestCommand;
    }

    if (action === 'read' || action === 'health' || action === 'close' || action === 'destroy') {
        return {
            kind: `crdt.${action}`,
            commandId,
            handle: request.handle,
            timeoutMs: request.timeoutMs,
            metadata
        } as RallarBlackBoxTestCommand;
    }

    throw new Error('Unsupported CRDT action: ' + action);
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

function toCrdtProviderFailureStatus(config: any, interaction: any, result: string, details: any = {}): any {
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
            ...details
        },
        ...config
    };
}

async function readJson(response: Response): Promise<any> {
    return await response.json().catch(() => ({}));
}

async function enqueueCommand(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    command: RallarBlackBoxTestCommand
): Promise<void> {
    const response = await fetchFn(
        joinUrl(
            remote.controlBaseUrl,
            `/runs/${encodePath(remote.runId)}/agents/${encodePath(remote.agentId)}/commands`
        ),
        {
            method: 'POST',
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
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch
): Promise<ControlRunSnapshot | undefined> {
    const response = await fetchFn(joinUrl(remote.controlBaseUrl, `/runs/${encodePath(remote.runId)}`), {
        headers: authorizationHeaders(remote)
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
    }
    catch (_ignored) {
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

function toRemotePayloadRecord(payload: RallarBlackBoxTestEvent): Record<string, unknown> {
    return payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
        ? payload.payload as Record<string, unknown>
        : {};
}

function toRemoteRtcMessageData(payload: RallarBlackBoxTestEvent, connectionName: string): Record<string, unknown> {
    const payloadRecord = toRemotePayloadRecord(payload);
    const data = Object.prototype.hasOwnProperty.call(payloadRecord, 'data')
        ? payloadRecord.data
        : payload.payload;

    return {
        kind: 'message',
        topic: payload.topic,
        connection: connectionName,
        actor: payload.actor,
        transport: payload.transport,
        roomId: payloadRecord.roomId,
        roomRef: payloadRecord.roomRef,
        scope: payloadRecord.scope,
        applicationId: payloadRecord.applicationId,
        workspaceId: payloadRecord.workspaceId,
        laneId: payloadRecord.laneId,
        peerId: payloadRecord.peerId,
        remotePeerId: payloadRecord.remotePeerId,
        senderId: payloadRecord.senderId,
        typeId: payloadRecord.typeId,
        topicId: payloadRecord.topicId,
        contextId: payloadRecord.contextId,
        resourceId: payloadRecord.resourceId,
        data,
        event: payload
    };
}

function isRemoteRtcCloseEvent(payload: RallarBlackBoxTestEvent): boolean {
    return payload.kind === 'event' &&
        payload.transport !== 'ws' &&
        (
            payload.topic === 'rallar.bb.rtc.closed' ||
            payload.topic === 'rallar.browser.rtc.closed' ||
            payload.topic === 'rallar.browser.provider.closed'
        );
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
        if (payload?.kind === 'diagnostic') {
            const connectionName = payload.connection ?? 'default';
            const payloadRecord = payload.payload && typeof payload.payload === 'object'
                ? payload.payload as Record<string, unknown>
                : {};
            rememberRtcDiagnostic(connectionName, {
                kind: 'diagnostic',
                topic: payload.topic,
                severity: payload.severity ?? 'info',
                atEpochMs: payload.atEpochMs,
                commandId: payload.commandId,
                connection: connectionName,
                provider: 'rallar-remote-browser',
                actor: payload.actor,
                transport: payload.transport,
                roomId: payloadRecord.roomId,
                roomRef: payloadRecord.roomRef,
                scope: payloadRecord.scope,
                applicationId: payloadRecord.applicationId,
                workspaceId: payloadRecord.workspaceId,
                data: payloadRecord.data ?? payload.payload,
                error: payloadRecord.error,
                event: payload
            }, context);
            continue;
        }

        if (payload?.kind === 'message') {
            const connectionName = payload.connection ?? 'default';
            if (payload.transport === 'ws') {
                const payloadRecord = toRemotePayloadRecord(payload);
                const messagePayload = Object.prototype.hasOwnProperty.call(payloadRecord, 'data')
                    ? payloadRecord.data
                    : payload.payload;
                rememberRemoteWsMessage(connectionName, {
                    data: parseRemoteWsData(messagePayload),
                    receivedAtEpochMs: payload.atEpochMs,
                    provider: 'rallar-remote-browser',
                    commandId: payload.commandId
                }, context);
                continue;
            }

            const messageData = toRemoteRtcMessageData(payload, connectionName);
            rememberRtcMessage(connectionName, {
                data: messageData,
                receivedAtEpochMs: payload.atEpochMs,
                provider: 'rallar-remote-browser',
                actor: payload.actor,
                roomId: messageData.roomId,
                roomRef: messageData.roomRef,
                scope: messageData.scope,
                applicationId: messageData.applicationId,
                workspaceId: messageData.workspaceId,
                commandId: payload.commandId
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
                commandId: payload.commandId
            }, context);
        }

        if (payload && isRemoteRtcCloseEvent(payload)) {
            const connectionName = payload.connection ?? 'default';
            const closePayload = toRemotePayloadRecord(payload);
            rememberRtcCloseEvent(connectionName, {
                ...closePayload,
                closedAtEpochMs: payload.atEpochMs,
                provider: 'rallar-remote-browser',
                actor: payload.actor,
                transport: payload.transport,
                commandId: payload.commandId,
                event: payload
            }, context);
        }
    }
}

export async function syncRallarRemoteBrowserEvents(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any
): Promise<ControlRunSnapshot | undefined> {
    const snapshot = await fetchRunSnapshot(remote, fetchFn);
    syncRemoteEvents(snapshot, context);
    return snapshot;
}

async function syncEvents(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any
): Promise<ControlRunSnapshot | undefined> {
    return await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
}

async function waitForCommandResult(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    commandId: string
): Promise<ControlResultEnvelope> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= remote.timeoutMs) {
        const snapshot = await syncEvents(remote, fetchFn, context);
        const result = snapshot?.results?.find((item) => item.commandId === commandId);
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

function toRemoteSendResult(status: string, connectionName: string, result: ControlResultEnvelope): any {
    return {
        status,
        connection: connectionName,
        remoteResult: resultDetails(result)
    };
}

export async function executeRallarRemoteBrowserCommand(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    command: RallarBlackBoxTestCommand
): Promise<ControlResultEnvelope> {
    await enqueueCommand(remote, fetchFn, command);
    return await waitForCommandResult(remote, fetchFn, context, command.commandId ?? '');
}

async function executeRemoteCommand(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    command: RallarBlackBoxTestCommand
): Promise<ControlResultEnvelope> {
    return await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
}

function startEventSync(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any
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
    wait: () => Promise<any>
): Promise<any> {
    await syncEvents(remote, fetchFn, context);
    const interval = startEventSync(remote, fetchFn, context);
    try {
        return await wait();
    }
    finally {
        clearInterval(interval);
    }
}

async function updateRemoteHealthDiagnostics(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    interaction: any,
    commandId: string
): Promise<void> {
    const connectionName = toRtcExpectedConnectionName(interaction);
    const result = await executeRemoteCommand(
        remote,
        fetchFn,
        context,
        toHealthCommand(commandId, interaction)
    );
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

function startRemoteHealthSync(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    interaction: any,
    commandIdPrefix: string
): number {
    let syncing = false;
    let sequence = 0;
    return setInterval(() => {
        if (syncing) {
            return;
        }

        syncing = true;
        sequence += 1;
        void updateRemoteHealthDiagnostics(
            remote,
            fetchFn,
            context,
            interaction,
            `${commandIdPrefix}-health-${sequence}`
        )
            .catch(() => {
                // waitForRtcHealth reports missing health through its normal timeout diagnostics.
            })
            .finally(() => {
                syncing = false;
            });
    }, remote.pollIntervalMs) as unknown as number;
}

async function waitForRemoteRtcHealth(
    remote: RemoteProviderConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    interaction: any,
    config: any,
    details: any = {}
): Promise<any> {
    const commandIdPrefix = commandIdFor('health', interaction);
    await updateRemoteHealthDiagnostics(
        remote,
        fetchFn,
        context,
        interaction,
        `${commandIdPrefix}-health-0`
    ).catch(() => undefined);

    const interval = startRemoteHealthSync(
        remote,
        fetchFn,
        context,
        interaction,
        commandIdPrefix
    );
    try {
        return await waitForRtcHealth(interaction, config, context, details);
    }
    finally {
        clearInterval(interval);
    }
}

function toFailureFromError(config: any, interaction: any, message: string, error: unknown): any {
    return toRtcFailureStatus(config, interaction, message, {
        exception: error instanceof Error ? error.message : String(error)
    });
}

export function createRallarRemoteBrowserRtcProvider(
    options: RallarRemoteBrowserProviderOptions = {}
): RtcProvider {
    const fetchFn = options.fetch ?? fetch;

    return {
        connect: async (interaction, config, context): Promise<any> => {
            const remote = toRemoteConfig(interaction.request, config, context, options);
            const commandId = commandIdFor('connect', interaction);
            const command = toConnectCommand(commandId, interaction);
            const connectionName = toRtcConnectionName(interaction.request);
            const connectStartedAtEpochMs = Date.now();

            try {
                const result = await executeRemoteCommand(remote, fetchFn, context, command);
                const connectedAtEpochMs = Date.now();
                if (!result.ok) {
                    return toRtcFailureStatus(config, interaction, 'Remote RTC connect failed', {
                        connection: connectionName,
                        remote,
                        result,
                        connectStartedAtEpochMs,
                        connectFailedAtEpochMs: connectedAtEpochMs,
                        connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs
                    });
                }

                const diagnostics = resultDetails(result);
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
                                toCloseCommand(`${commandId}-auto-close`, interaction)
                            );
                        }
                    },
                    remote: true,
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    request: interaction.request,
                    connectStartedAtEpochMs,
                    connectedAtEpochMs,
                    connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs,
                    diagnostics,
                    commandId
                };
                context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
                context.rtcDiagnostics = context.rtcDiagnostics || {};
                context.rtcDiagnostics[connectionName] = context.rtcDiagnostics[connectionName] || [];
                context.rtcCloseEvents[connectionName] = context.rtcCloseEvents[connectionName] || [];

                return toRtcSuccessStatus(config, interaction, {
                    connection: connectionName,
                    connected: true,
                    provider: interaction.request.provider,
                    remote,
                    commandId,
                    ...toRallarScopeFields(interaction.request),
                    result: diagnostics,
                    diagnostics,
                    connectStartedAtEpochMs,
                    connectedAtEpochMs,
                    connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs
                });
            }
            catch (error) {
                return toFailureFromError(config, interaction, 'Remote RTC connect failed', error);
            }
        },

        send: async (interaction, config, context): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            if (!context.rtcConnections[connectionName]) {
                return toRtcFailureStatus(config, interaction, 'RTC connection is not open', {
                    connection: connectionName
                });
            }

            const remote = toRemoteConfig(interaction.request, config, context, options);
            const commandId = commandIdFor('send', interaction);
            const command = toSendCommand(commandId, interaction);

            try {
                const sendStartedAtEpochMs = Date.now();
                const result = await executeRemoteCommand(remote, fetchFn, context, command);
                const sendEndedAtEpochMs = Date.now();
                if (!result.ok) {
                    return toRtcFailureStatus(config, interaction, 'Remote RTC send failed', {
                        connection: connectionName,
                        remote,
                        result,
                        sendResult: toRemoteSendResult('failed', connectionName, result),
                        sendStartedAtEpochMs,
                        sendEndedAtEpochMs,
                        sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
                    });
                }

                const sent = command.kind === 'rtc.send' ? command.send : undefined;
                const details = {
                    connection: connectionName,
                    sent,
                    provider: interaction.request.provider,
                    remote,
                    commandId,
                    ...toRallarScopeFields(interaction.request),
                    result: resultDetails(result),
                    sendResult: toRemoteSendResult('sent', connectionName, result),
                    sendStartedAtEpochMs,
                    sendEndedAtEpochMs,
                    sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
                };

                // Before `message`, which resolves on its first match.
                if (interaction.response?.count !== undefined) {
                    return waitWithRemoteEventSync(
                        remote,
                        fetchFn,
                        context,
                        () => waitForRtcMessageCount({ interaction, config, context, details })
                    );
                }

                if (interaction.response?.messages) {
                    return waitWithRemoteEventSync(
                        remote,
                        fetchFn,
                        context,
                        () => waitForRtcMessages(interaction, config, context, details)
                    );
                }

                if (interaction.response?.diagnostics) {
                    return waitWithRemoteEventSync(
                        remote,
                        fetchFn,
                        context,
                        () => waitForRtcDiagnostics(interaction, config, context, details)
                    );
                }

                if (interaction.response?.diagnostic) {
                    return waitWithRemoteEventSync(
                        remote,
                        fetchFn,
                        context,
                        () => waitForRtcDiagnostic(interaction, config, context, details)
                    );
                }

                if (interaction.response?.health !== undefined) {
                    return await waitForRemoteRtcHealth(
                        remote,
                        fetchFn,
                        context,
                        interaction,
                        config,
                        details
                    );
                }

                if (interaction.response?.message) {
                    return waitWithRemoteEventSync(
                        remote,
                        fetchFn,
                        context,
                        () => waitForRtcMessage(interaction, config, context, details)
                    );
                }

                return toRtcSuccessStatus(config, interaction, details);
            }
            catch (error) {
                return toFailureFromError(config, interaction, 'Remote RTC send failed', error);
            }
        },

        command: async (interaction, config, context): Promise<any> => {
            const remote = toRemoteConfig(interaction.request, config, context, options);
            const action = String(interaction.request.action || 'open');
            const commandId = commandIdFor(`crdt-${action}`, interaction);

            try {
                const command = toCrdtCommand(commandId, interaction);
                const startedAtEpochMs = Date.now();
                const result = await executeRemoteCommand(remote, fetchFn, context, command);
                const endedAtEpochMs = Date.now();
                if (!result.ok) {
                    return toCrdtProviderFailureStatus(config, interaction, 'Remote CRDT command failed', {
                        remote,
                        commandId,
                        result,
                        startedAtEpochMs,
                        endedAtEpochMs,
                        latencyMs: endedAtEpochMs - startedAtEpochMs
                    });
                }

                return toCrdtProviderSuccessStatus(config, interaction, {
                    remote,
                    commandId,
                    result: resultDetails(result),
                    startedAtEpochMs,
                    endedAtEpochMs,
                    latencyMs: endedAtEpochMs - startedAtEpochMs
                });
            }
            catch (error) {
                return toCrdtProviderFailureStatus(config, interaction, 'Remote CRDT command failed', {
                    remote,
                    commandId,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        },

        wait: async (interaction, config, context): Promise<any> => {
            const remote = toRemoteConfig(interaction.request, config, context, options);
            return waitWithRemoteEventSync(remote, fetchFn, context, () => {
                if (interaction.response?.close !== undefined) {
                    return waitForRtcClose(interaction, config, context, {
                        remote
                    });
                }
                if (interaction.response?.diagnostics) {
                    return waitForRtcDiagnostics(interaction, config, context, {
                        remote
                    });
                }
                if (interaction.response?.diagnostic) {
                    return waitForRtcDiagnostic(interaction, config, context, {
                        remote
                    });
                }
                if (interaction.response?.health !== undefined) {
                    return waitForRemoteRtcHealth(
                        remote,
                        fetchFn,
                        context,
                        interaction,
                        config,
                        {
                            remote
                        }
                    );
                }
                // Before `message`, which resolves on its first match.
                if (interaction.response?.count !== undefined) {
                    return waitForRtcMessageCount({
                        interaction,
                        config,
                        context,
                        details: { remote }
                    });
                }
                if (interaction.response?.messages) {
                    return waitForRtcMessages(interaction, config, context, {
                        remote
                    });
                }
                if (interaction.response?.message) {
                    return waitForRtcMessage(interaction, config, context, {
                        remote
                    });
                }

                return Promise.resolve(toRtcFailureStatus(
                    config,
                    interaction,
                    'RTC wait expects expect.message, expect.messages, expect.count, expect.diagnostic, ' +
                        'expect.diagnostics, expect.health, or expect.close',
                    {
                        connection: toRtcExpectedConnectionName(interaction),
                        remote
                    }
                ));
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
                    result: resultDetails(result)
                }, context);

                if (!result.ok) {
                    return toRtcFailureStatus(config, interaction, 'Remote RTC close failed', {
                        connection: connectionName,
                        remote,
                        result
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
            catch (error) {
                return toFailureFromError(config, interaction, 'Remote RTC close failed', error);
            }
        }
    };
}
