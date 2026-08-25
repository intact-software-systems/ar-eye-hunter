import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import {
    validateAuthoritativeClientSnapshot,
    validateAuthoritativeGroupSnapshot
} from '@shared/api/authoritative-state-validation.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { CommandsOrchestrator, type CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import {
    isStateWorkflowNotFoundError,
    requireStateWorkflowResult,
    toApiMutationWorkflowRequestId,
    tolerateStateWorkflowNotFound
} from '@shared-web/browser/state-read/state-workflow-support.ts';
import { ApiHttpError } from '../api/http-error.ts';
import { defaultStateScope } from '../api/state-http-path.ts';
import { roomGroupStateHttpApi } from '../rooms/room-group-state-http-api.ts';
import {
    connectStateClientSession,
    heartbeatStateClientSession,
    type HeartbeatStateClientSessionHttpInput
} from './client-session-http-api.ts';

export const DEFAULT_STATE_HEARTBEAT_TTL_MSECS = 120000;

export type StateHeartbeatWorkflowValue = ClientSnapshot | GroupSnapshot | undefined;

export interface RefreshStateHeartbeatOptions {
    readonly generationId: string;
    readonly scope?: StateScope;
    readonly authSession?: AuthSession;
    readonly heartbeatAtEpochMs?: number;
    readonly ttlMs?: number;
    readonly policies?: CommandsOrchestratorPolicies<StateHeartbeatWorkflowValue>;
}

export interface RefreshStateHeartbeatResult {
    readonly client: ClientSnapshot;
    readonly groups: GroupSnapshot[];
    readonly missingGroups: GroupSnapshot[];
    readonly heartbeatAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

interface HeartbeatClientWithPresenceRepairInput {
    readonly clientData: ClientInfo;
    readonly request: HeartbeatStateClientSessionHttpInput['request'];
    readonly requestId: string;
    readonly repairRequestId: string;
    readonly scope: StateScope;
    readonly authSession: AuthSession | undefined;
    readonly signal?: AbortSignal;
}

interface ClientHeartbeatRequestInput {
    readonly clientData: ClientInfo;
    readonly generationId: string;
    readonly heartbeatAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

interface HeartbeatResultInput {
    readonly results: ReadonlyMap<StateHeartbeatKey, StateHeartbeatWorkflowValue>;
    readonly joinedGroups: readonly GroupSnapshot[];
    readonly scope: StateScope;
    readonly heartbeatAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

type StateHeartbeatKey = 'client' | `group:${string}`;
type HeartbeatCommandPolicy = CommandsOrchestratorPolicies<StateHeartbeatWorkflowValue>['command'];
type HeartbeatRetryError = Parameters<NonNullable<NonNullable<HeartbeatCommandPolicy>['shouldRetry']>>[0];

export async function refreshStateHeartbeat(
    clientData: ClientInfo,
    joinedGroups: readonly GroupSnapshot[],
    options: RefreshStateHeartbeatOptions
): Promise<RefreshStateHeartbeatResult> {
    const scope = options.scope ?? defaultStateScope();
    const heartbeatAtEpochMs = options.heartbeatAtEpochMs ?? Date.now();
    const expiresAtEpochMs = heartbeatAtEpochMs + (options.ttlMs ?? DEFAULT_STATE_HEARTBEAT_TTL_MSECS);
    const clientRequestId = toApiMutationWorkflowRequestId();
    const repairRequestId = toApiMutationWorkflowRequestId();
    const flow = CommandsOrchestrator.withPolicies<StateHeartbeatKey, StateHeartbeatWorkflowValue>(
        options.policies ?? {}
    );
    const commandPolicy = options.policies?.command;

    const results = await flow
        .sequential(
            flow.commandStep(
                'client',
                (signal) =>
                    heartbeatClientWithPresenceRepair({
                        clientData,
                        request: clientHeartbeatRequest({
                            clientData,
                            generationId: options.generationId,
                            heartbeatAtEpochMs,
                            expiresAtEpochMs
                        }),
                        requestId: clientRequestId,
                        repairRequestId,
                        scope,
                        authSession: options.authSession,
                        signal
                    }),
                { shouldRetry: (error, attempt) => shouldRetryHeartbeat(error, attempt, commandPolicy) }
            )
        )
        .parallel(...joinedGroups.map((snapshot) =>
            groupHeartbeatStep({
                flow,
                snapshot,
                clientData,
                generationId: options.generationId,
                heartbeatAtEpochMs,
                expiresAtEpochMs,
                scope,
                authSession: options.authSession,
                commandPolicy
            })
        ))
        .run();

    return heartbeatResult({
        results,
        joinedGroups,
        scope,
        heartbeatAtEpochMs,
        expiresAtEpochMs
    });
}

interface GroupHeartbeatStepInput {
    readonly flow: ReturnType<typeof CommandsOrchestrator.withPolicies<StateHeartbeatKey, StateHeartbeatWorkflowValue>>;
    readonly snapshot: GroupSnapshot;
    readonly clientData: ClientInfo;
    readonly generationId: string;
    readonly heartbeatAtEpochMs: number;
    readonly expiresAtEpochMs: number;
    readonly scope: StateScope;
    readonly authSession: AuthSession | undefined;
    readonly commandPolicy: HeartbeatCommandPolicy;
}

function groupHeartbeatStep(input: GroupHeartbeatStepInput) {
    const groupId = input.snapshot.group.groupId;
    const requestId = toApiMutationWorkflowRequestId();
    const generationId = input.snapshot.activeSessions.find(
        (session) => session.sessionId === input.clientData.sessionId
    )?.generationId ?? input.generationId;
    return input.flow.commandStep(
        `group:${groupId}`,
        (signal) =>
            roomGroupStateHttpApi.heartbeatPresence({
                groupId,
                sessionId: input.clientData.sessionId,
                request: {
                    generationId,
                    principalId: input.clientData.clientId,
                    actorPrincipalId: input.clientData.clientId,
                    actorSessionId: input.clientData.sessionId,
                    lastHeartbeatAtEpochMs: input.heartbeatAtEpochMs,
                    expiresAtEpochMs: input.expiresAtEpochMs
                },
                options: { requestId, signal, authSession: input.authSession },
                scope: input.scope
            }),
        {
            errorOnNull: false,
            shouldRetry: (error, attempt) => shouldRetryHeartbeat(error, attempt, input.commandPolicy),
            fallback: (error) => tolerateStateWorkflowNotFound(error, undefined)
        }
    );
}

async function heartbeatClientWithPresenceRepair(
    input: HeartbeatClientWithPresenceRepairInput
): Promise<ClientSnapshot> {
    try {
        return await heartbeatStateClientSession({
            principalId: input.clientData.clientId,
            clientInstanceId: input.clientData.clientId,
            sessionId: input.clientData.sessionId,
            request: input.request,
            options: { requestId: input.requestId, signal: input.signal, authSession: input.authSession },
            scope: input.scope
        });
    }
    catch (error) {
        if (!isStateWorkflowNotFoundError(error)) {
            throw error;
        }
    }

    return await connectStateClientSession({
        principalId: input.clientData.clientId,
        clientInstanceId: input.clientData.clientId,
        sessionId: input.clientData.sessionId,
        request: {
            generationId: input.request.generationId,
            actorPrincipalId: input.request.actorPrincipalId ?? input.clientData.clientId,
            actorSessionId: input.request.actorSessionId ?? input.clientData.sessionId,
            presenceState: input.request.presenceState ?? 'online',
            transport: 'ws',
            connectionId: input.request.generationId,
            connectedAtEpochMs: input.request.lastHeartbeatAtEpochMs,
            lastHeartbeatAtEpochMs: input.request.lastHeartbeatAtEpochMs,
            expiresAtEpochMs: input.request.expiresAtEpochMs
        },
        options: { requestId: input.repairRequestId, signal: input.signal, authSession: input.authSession },
        scope: input.scope
    });
}

function clientHeartbeatRequest(
    input: ClientHeartbeatRequestInput
): HeartbeatStateClientSessionHttpInput['request'] {
    return {
        generationId: input.generationId,
        actorPrincipalId: input.clientData.clientId,
        actorSessionId: input.clientData.sessionId,
        presenceState: 'online',
        lastHeartbeatAtEpochMs: input.heartbeatAtEpochMs,
        expiresAtEpochMs: input.expiresAtEpochMs
    };
}

function heartbeatResult(input: HeartbeatResultInput): RefreshStateHeartbeatResult {
    const client = requireStateWorkflowResult(input.results, 'client');
    validateAuthoritativeClientSnapshot(client, input.scope);
    const groups: GroupSnapshot[] = [];
    const missingGroups: GroupSnapshot[] = [];
    for (const snapshot of input.joinedGroups) {
        const result = input.results.get(`group:${snapshot.group.groupId}`);
        if (result === undefined) {
            missingGroups.push(snapshot);
        }
        else {
            validateAuthoritativeGroupSnapshot(result, input.scope);
            groups.push(result);
        }
    }
    return {
        client,
        groups,
        missingGroups,
        heartbeatAtEpochMs: input.heartbeatAtEpochMs,
        expiresAtEpochMs: input.expiresAtEpochMs
    };
}

function shouldRetryHeartbeat(
    error: HeartbeatRetryError,
    attempt: number,
    commandPolicy: HeartbeatCommandPolicy
): boolean {
    if (isStateWorkflowNotFoundError(error)) {
        return false;
    }
    if (error instanceof ApiHttpError && error.status === 401) {
        return false;
    }
    return commandPolicy?.shouldRetry?.(error, attempt) ?? true;
}
