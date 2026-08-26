import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { encodeAppInboxCommand } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type {
    ClientInstanceUpsertAppInboxPayload,
    ClientPrincipalUpsertAppInboxPayload,
    ClientSessionConnectAppInboxPayload,
    ClientSessionDisconnectAppInboxPayload,
    ClientSessionHeartbeatAppInboxPayload
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import { validateClientMutationRequest } from '@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type {
    StateSyncCacheHydrationInput,
    StateSyncCacheHydrationResult
} from '@shared-server/rallar-system/state-sync/state-sync-cache-hydration.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';
import { authorizationDenied } from '../services/request-auth-service.ts';
import { toApiMutationFailureResponse, toApiMutationRouteFailure } from './api-mutation-route-failure.ts';
import { readApiMutationRouteRequestId } from './api-mutation-route-ingress.ts';
import { readClientStateRouteScope } from './read-client-state-route-scope.ts';

const CLIENT_PRINCIPAL_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId';
const CLIENT_INSTANCE_PATH = `${CLIENT_PRINCIPAL_PATH}/instances/:clientInstanceId`;
const CLIENT_SESSION_PATH = `${CLIENT_INSTANCE_PATH}/sessions/:sessionId`;

export type ProcessClientAppInbox = (
    enqueue: AppInboxEnqueueInput,
    authority: IssuedAuthSession
) => Promise<Either<AppInboxFailure, ClientStateWritten>>;

export interface ClientStateMutationRouteDependencies {
    readonly requireApiAuthSession: (
        request: Readonly<{
            header(name: string): string | undefined;
        }>
    ) => Promise<IssuedAuthSession>;
    readonly hydrateStateSyncSnapshotCaches: (
        input: StateSyncCacheHydrationInput
    ) => Promise<StateSyncCacheHydrationResult>;
    readonly processClientAppInbox: ProcessClientAppInbox;
}

export function registerClientStateMutationRoutes(
    app: Hono,
    dependencies: ClientStateMutationRouteDependencies
): void {
    app.put(
        `${CLIENT_PRINCIPAL_PATH}/principal/requests/:requestId`,
        (context) => handleClientPrincipalUpsert(context, dependencies)
    );
    app.put(
        `${CLIENT_INSTANCE_PATH}/requests/:requestId`,
        (context) => handleClientInstanceUpsert(context, dependencies)
    );
    app.put(
        `${CLIENT_SESSION_PATH}/requests/:requestId`,
        (context) => handleClientSessionConnect(context, dependencies)
    );
    app.post(
        `${CLIENT_SESSION_PATH}/heartbeat/requests/:requestId`,
        (context) => handleClientSessionHeartbeat(context, dependencies)
    );
    app.post(
        `${CLIENT_SESSION_PATH}/disconnect/requests/:requestId`,
        (context) => handleClientSessionDisconnect(context, dependencies)
    );
}

async function handleClientPrincipalUpsert(
    context: Context,
    dependencies: ClientStateMutationRouteDependencies
): Promise<Response> {
    try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = readClientStateRouteScope(context);
        const principalId = context.req.param('principalId');
        assertSelfPrincipal(authSession.clientId, principalId);
        const requestBody = await readRequestWithRequestId(context);
        validateClientMutationRequest('upsertPrincipal', requestBody);
        const request = withActor(requestBody, authSession);
        return await processClientMutation(
            context,
            {
                dependencies,
                authority: authSession,
                enqueue: {
                    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                    topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                    resourceId: request.requestId,
                    contextId: toAuthenticatedClientMutationContextId({
                        scope,
                        principalId,
                        callerClientId: authSession.clientId,
                        callerSessionId: authSession.sessionId
                    }),
                    senderId: authSession.clientId,
                    data: encodeAppInboxCommand(
                        { scope, principalId, request } satisfies ClientPrincipalUpsertAppInboxPayload,
                        'Client principal upsert AppInbox command'
                    )
                }
            }
        );
    }
    catch (error) {
        return toClientMutationFailure(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function handleClientInstanceUpsert(
    context: Context,
    dependencies: ClientStateMutationRouteDependencies
): Promise<Response> {
    try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = readClientStateRouteScope(context);
        const principalId = context.req.param('principalId');
        const clientInstanceId = context.req.param('clientInstanceId');
        assertSelfPrincipal(authSession.clientId, principalId);
        const requestBody = await readRequestWithRequestId(context);
        validateClientMutationRequest('upsertInstance', requestBody);
        const request = withActor(requestBody, authSession);
        return await processClientMutation(
            context,
            {
                dependencies,
                authority: authSession,
                enqueue: {
                    type: AppInboxType.CLIENT_INSTANCE_UPSERT,
                    topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
                    resourceId: request.requestId,
                    contextId: toAuthenticatedClientMutationContextId({
                        scope,
                        principalId,
                        callerClientId: authSession.clientId,
                        callerSessionId: authSession.sessionId
                    }),
                    senderId: authSession.clientId,
                    data: encodeAppInboxCommand(
                        {
                            scope,
                            principalId,
                            clientInstanceId,
                            request
                        } satisfies ClientInstanceUpsertAppInboxPayload,
                        'Client instance upsert AppInbox command'
                    )
                }
            }
        );
    }
    catch (error) {
        return toClientMutationFailure(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function handleClientSessionConnect(
    context: Context,
    dependencies: ClientStateMutationRouteDependencies
): Promise<Response> {
    try {
        const { authSession, route } = await readAuthenticatedClientSessionRoute(
            context,
            dependencies
        );
        const requestBody = await readRequestWithRequestId(context);
        validateClientMutationRequest('connectSession', requestBody);
        const request = withActor(requestBody, authSession);
        return await processClientMutation(
            context,
            {
                dependencies,
                authority: authSession,
                enqueue: toClientSessionEnqueue({
                    type: AppInboxType.CLIENT_SESSION_CONNECT,
                    route,
                    authSession,
                    request
                })
            }
        );
    }
    catch (error) {
        return toClientMutationFailure(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function handleClientSessionHeartbeat(
    context: Context,
    dependencies: ClientStateMutationRouteDependencies
): Promise<Response> {
    try {
        const { authSession, route } = await readAuthenticatedClientSessionRoute(
            context,
            dependencies
        );
        const requestBody = await readRequestWithRequestId(context);
        validateClientMutationRequest('heartbeatSession', requestBody);
        const request = withActor(requestBody, authSession);
        return await processClientMutation(
            context,
            {
                dependencies,
                authority: authSession,
                enqueue: toClientSessionEnqueue({
                    type: AppInboxType.CLIENT_SESSION_HEARTBEAT,
                    route,
                    authSession,
                    request
                })
            }
        );
    }
    catch (error) {
        return toClientMutationFailure(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function handleClientSessionDisconnect(
    context: Context,
    dependencies: ClientStateMutationRouteDependencies
): Promise<Response> {
    try {
        const { authSession, route } = await readAuthenticatedClientSessionRoute(
            context,
            dependencies
        );
        const requestBody = await readRequestWithRequestId(context);
        validateClientMutationRequest('disconnectSession', requestBody);
        const request = withActor(requestBody, authSession);
        return await processClientMutation(
            context,
            {
                dependencies,
                authority: authSession,
                enqueue: toClientSessionEnqueue({
                    type: AppInboxType.CLIENT_SESSION_DISCONNECT,
                    route,
                    authSession,
                    request
                })
            }
        );
    }
    catch (error) {
        return toClientMutationFailure(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

interface AuthenticatedClientSessionRoute {
    readonly authSession: IssuedAuthSession;
    readonly route: ClientSessionRoute;
}

interface ClientSessionRoute {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly sessionId: string;
}

async function readAuthenticatedClientSessionRoute(
    context: Context,
    dependencies: ClientStateMutationRouteDependencies
): Promise<AuthenticatedClientSessionRoute> {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const route = readClientSessionRoute(context);
    assertSelfSession(authSession, route.principalId, route.sessionId);
    return { authSession, route };
}

interface ClientSessionPayloadByType {
    [AppInboxType.CLIENT_SESSION_CONNECT]: ClientSessionConnectAppInboxPayload;
    [AppInboxType.CLIENT_SESSION_HEARTBEAT]: ClientSessionHeartbeatAppInboxPayload;
    [AppInboxType.CLIENT_SESSION_DISCONNECT]: ClientSessionDisconnectAppInboxPayload;
}

type ClientSessionAppInboxType = keyof ClientSessionPayloadByType;

interface ClientSessionEnqueueInput<Type extends ClientSessionAppInboxType> {
    readonly type: Type;
    readonly route: ClientSessionRoute;
    readonly authSession: IssuedAuthSession;
    readonly request: ClientSessionPayloadByType[Type]['request'];
}

function toClientSessionEnqueue<Type extends ClientSessionAppInboxType>(
    input: ClientSessionEnqueueInput<Type>
): AppInboxEnqueueInput {
    const command = {
        ...input.route,
        request: input.request
    };
    return {
        type: input.type,
        topicId: input.type,
        resourceId: input.request.requestId,
        contextId: toAuthenticatedClientMutationContextId({
            scope: input.route.scope,
            principalId: input.route.principalId,
            callerClientId: input.authSession.clientId,
            callerSessionId: input.authSession.sessionId
        }),
        senderId: input.authSession.clientId,
        data: encodeAppInboxCommand(command, toClientSessionCommandLabel(input.type))
    };
}

function toClientSessionCommandLabel(type: ClientSessionAppInboxType): string {
    switch (type) {
        case AppInboxType.CLIENT_SESSION_CONNECT:
            return 'Client session connect AppInbox command';
        case AppInboxType.CLIENT_SESSION_HEARTBEAT:
            return 'Client session heartbeat AppInbox command';
        case AppInboxType.CLIENT_SESSION_DISCONNECT:
            return 'Client session disconnect AppInbox command';
    }
}
interface ProcessClientMutationInput {
    readonly dependencies: ClientStateMutationRouteDependencies;
    readonly authority: IssuedAuthSession;
    readonly enqueue: AppInboxEnqueueInput;
}

async function processClientMutation(
    context: Context,
    input: ProcessClientMutationInput
): Promise<Response> {
    const result = await input.dependencies.processClientAppInbox(
        input.enqueue,
        input.authority
    );
    if (result.left !== undefined) {
        throw toApiMutationRouteFailure(result.left);
    }
    const written = result.right;
    if (written === undefined) {
        throw new Error('Client AppInbox mutation result is unavailable');
    }
    const snapshot = written.result.snapshot;
    await hydrateClientMutationSnapshot(input.dependencies, snapshot);
    return context.json(snapshot);
}

async function hydrateClientMutationSnapshot(
    dependencies: ClientStateMutationRouteDependencies,
    snapshot: ClientSnapshot
): Promise<void> {
    try {
        await dependencies.hydrateStateSyncSnapshotCaches({ clients: [snapshot] });
    }
    catch (error) {
        console.warn('Failed to hydrate client mutation snapshot cache', error);
    }
}

function toClientMutationFailure(context: Context, error: Error): Response {
    return toApiMutationFailureResponse(
        context,
        error
    );
}

function readClientSessionRoute(context: Context): ClientSessionRoute {
    return {
        scope: readClientStateRouteScope(context),
        principalId: context.req.param('principalId'),
        clientInstanceId: context.req.param('clientInstanceId'),
        sessionId: context.req.param('sessionId')
    };
}

interface ClientMutationRequestBody extends JsonWireObject {
    readonly requestId: string;
}

async function readRequestWithRequestId(context: Context): Promise<ClientMutationRequestBody> {
    const requestBody = decodeJsonWireValue(await context.req.json(), 'Client request');
    if (!isClientMutationRequestBody(requestBody)) {
        throw new ClientMutationRejectedError('Client request must be a plain object');
    }
    const requestId = readApiMutationRouteRequestId({
        requestId: context.req.param('requestId'),
        idempotencyKey: context.req.header('idempotency-key'),
        mutationBody: requestBody
    });
    return { ...requestBody, requestId: String(requestId) };
}

function isClientMutationRequestBody(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type AuthenticatedClientMutationRequest<T extends JsonWireObject> =
    & T
    & Readonly<{
        actorPrincipalId: string;
        actorSessionId: string;
    }>;

function withActor<T extends JsonWireObject>(
    request: T,
    authSession: Readonly<{ clientId: string; sessionId: string; }>
): AuthenticatedClientMutationRequest<T> {
    return {
        ...request,
        actorPrincipalId: authSession.clientId,
        actorSessionId: authSession.sessionId
    };
}

function assertSelfPrincipal(clientId: string, principalId: string): void {
    if (clientId !== principalId) {
        throw authorizationDenied('Forbidden: principal id does not match authenticated client');
    }
}

function assertSelfSession(
    authSession: Readonly<{ clientId: string; sessionId: string; }>,
    principalId: string,
    sessionId: string
): void {
    assertSelfPrincipal(authSession.clientId, principalId);
    if (authSession.sessionId !== sessionId) {
        throw authorizationDenied('Forbidden: session id does not match authenticated session');
    }
}
