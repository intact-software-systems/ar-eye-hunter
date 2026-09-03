import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type {
    GraphDiagnosticReadOptions,
    GraphDiagnosticReadResponse,
    GroupTopologyConfigView,
    GroupTopologyManagementView,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';

import { type AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type {
    GroupLifecyclePolicyRead
} from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { canUpdateGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-governance-policy.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { canReadGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    toTopologyAppInboxCommand,
    toTopologyHttpMutationSemanticHash
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import type { TopologyAppInboxRequestPayload } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts';
import type { TopologyAppInboxResult } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import type { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { toApiMutationRouteFailure } from './api-mutation-route-failure.ts';
import { readApiMutationRouteRequestId } from './api-mutation-route-ingress.ts';
import {
    decodePutTopologyConfigBody,
    decodePutTopologyOverrideBody,
    decodeReconfigureTopologyBody
} from './graph-topology-request-codec.ts';
import {
    toGraphTopologyErrorResponse as toErrorResponse,
    toGraphTopologyMutationErrorResponse as toMutationErrorResponse
} from './graph-topology-route-errors.ts';
import { readGroupFormationView } from './group-formation-view-read.ts';

const GROUP_TOPOLOGY_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology';

export type ProcessTopologyAppInbox = (
    authority: IssuedAuthSession,
    reservation: TopologyInboxService.HttpCommandReservation
) => Promise<TopologyAppInboxResult>;

export interface GraphTopologyAppInboxService {
    processAuthenticatedHttpEntryUntilCompletionResult(
        reservation: TopologyInboxService.HttpCommandReservation,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>>;
}

export interface GraphTopologyGroupStateService {
    readCurrentSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
}

export interface GraphTopologyRouteGraphDiagnostics {
    readScopedGlobalGraphDiagnostic(
        scope: StateScope,
        options: GraphDiagnosticReadOptions
    ): Either<string, GraphDiagnosticReadResponse>;
    readGroupGraphDiagnostic(
        groupRef: GroupRef,
        options: GraphDiagnosticReadOptions
    ): Either<string, GraphDiagnosticReadResponse>;
}

export interface GraphTopologyRouteQuery {
    readTopologyView(groupRef: GroupRef): Promise<GroupTopologyManagementView>;
    readConfig(groupRef: GroupRef): Promise<GroupTopologyConfigView>;
    readOverride(groupRef: GroupRef): Promise<StoredGroupTopologyOverride | undefined>;
}

export interface GraphTopologyRoutePlanning {
    readTopologyPlanningAuthority(
        input: Readonly<{
            groupRef: GroupRef;
            requestOptions?: undefined;
            knownGroup?: GroupSnapshot;
            snapshotSelection: 'prefer-current' | 'preserve-known-revision';
        }>
    ): Promise<GroupTopologyPlanningAuthority>;
}

export interface GraphTopologyRouteDependencies {
    readonly groupStateService: GraphTopologyGroupStateService;
    readonly graphDiagnostics: GraphTopologyRouteGraphDiagnostics;
    readonly topologyQuery: GraphTopologyRouteQuery;
    readonly topologyPlanning: GraphTopologyRoutePlanning;
    readonly processTopologyAppInbox: ProcessTopologyAppInbox;
    readonly requireApiAuthSession: (
        req: { header(name: string): string | undefined; }
    ) => Promise<IssuedAuthSession>;
    readonly adminClientIds: readonly string[];
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    /** The planned slot's stored topology-input fingerprint; null before a planning cycle stored one. */
    readonly readPlannedLayoutFingerprint: (ref: GroupRef) => Promise<string | null>;
    readonly strictReadAuthorization: boolean;
    readonly now: () => number;
}

interface WriteTopologyAppInboxCommandInput {
    readonly dependencies: GraphTopologyRouteDependencies;
    readonly authSession: IssuedAuthSession;
    readonly groupRef: GroupRef;
    readonly requestId: string;
    readonly payload: TopologyAppInboxRequestPayload;
}

export function registerGraphTopologyRoutes(
    app: Hono,
    dependencies: GraphTopologyRouteDependencies
): void {
    const deps = dependencies;

    app.get('/api/state/apps/:applicationId/workspaces/:workspaceId/graphs/global', async (c) => {
        try {
            await assertCanReadScopedGlobalGraph(c.req, deps);
            const result = deps.graphDiagnostics.readScopedGlobalGraphDiagnostic(
                toScope(c),
                readGraphOptions(c)
            );
            return toGraphDiagnosticResponse(c, result);
        }
        catch (error) {
            return toErrorResponse(c, error);
        }
    });

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/graphs/latest',
        async (c) => {
            try {
                const groupRef = toGroupRef(c);
                const snapshot = await readCurrentGroupSnapshot(groupRef, deps);
                await assertCanReadGroupSnapshot(c.req, deps, snapshot);
                return toGraphDiagnosticResponse(
                    c,
                    deps.graphDiagnostics.readGroupGraphDiagnostic(groupRef, readGraphOptions(c))
                );
            }
            catch (error) {
                return toErrorResponse(c, error);
            }
        }
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology',
        async (c) => {
            try {
                const groupRef = toGroupRef(c);
                const snapshot = await readCurrentGroupSnapshot(groupRef, deps);
                await assertCanReadGroupSnapshot(c.req, deps, snapshot);
                return c.json(await deps.topologyQuery.readTopologyView(groupRef));
            }
            catch (error) {
                return toErrorResponse(c, error);
            }
        }
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/formation',
        async (c) => {
            try {
                const groupRef = toGroupRef(c);
                const snapshot = await readCurrentGroupSnapshot(groupRef, deps);
                await assertCanReadGroupSnapshot(c.req, deps, snapshot);
                return c.json(await readGroupFormationView(groupRef, snapshot, deps));
            }
            catch (error) {
                return toErrorResponse(c, error);
            }
        }
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config',
        async (c) => {
            try {
                const groupRef = toGroupRef(c);
                const snapshot = await readCurrentGroupSnapshot(groupRef, deps);
                await assertCanReadGroupSnapshot(c.req, deps, snapshot);
                return c.json(await deps.topologyQuery.readConfig(groupRef));
            }
            catch (error) {
                return toErrorResponse(c, error);
            }
        }
    );

    app.put(
        `${GROUP_TOPOLOGY_PATH}/config/requests/:requestId`,
        async (c) => {
            try {
                const { authSession, groupRef } = await assertCanManageGroupRef(
                    c.req,
                    deps,
                    toGroupRef(c)
                );
                const body = await readJsonBody(c, decodePutTopologyConfigBody);
                return c.json(
                    await writeTopologyAppInboxCommand({
                        dependencies: deps,
                        authSession,
                        groupRef,
                        requestId: requireRequestId(c, body.raw),
                        payload: { operation: 'putConfig', config: body.value.config }
                    })
                );
            }
            catch (error) {
                return toMutationErrorResponse(c, error);
            }
        }
    );

    app.delete(
        `${GROUP_TOPOLOGY_PATH}/config/requests/:requestId`,
        async (c) => {
            try {
                const { authSession, groupRef } = await assertCanManageGroupRef(
                    c.req,
                    deps,
                    toGroupRef(c)
                );
                const body = await readOptionalJsonBody<JsonWireValue>(c, {}, (value) => value);
                return c.json(
                    await writeTopologyAppInboxCommand({
                        dependencies: deps,
                        authSession,
                        groupRef,
                        requestId: requireRequestId(c, body.raw),
                        payload: { operation: 'deleteConfig', target: 'config' }
                    })
                );
            }
            catch (error) {
                return toMutationErrorResponse(c, error);
            }
        }
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override',
        async (c) => {
            try {
                const groupRef = toGroupRef(c);
                const snapshot = await readCurrentGroupSnapshot(groupRef, deps);
                await assertCanReadGroupSnapshot(c.req, deps, snapshot);
                return c.json(await deps.topologyQuery.readOverride(groupRef) ?? {});
            }
            catch (error) {
                return toErrorResponse(c, error);
            }
        }
    );

    app.put(
        `${GROUP_TOPOLOGY_PATH}/override/requests/:requestId`,
        (context) => handlePutTopologyOverride(context, deps)
    );

    app.delete(
        `${GROUP_TOPOLOGY_PATH}/override/requests/:requestId`,
        async (c) => {
            try {
                const { authSession, groupRef } = await assertCanManageGroupRef(
                    c.req,
                    deps,
                    toGroupRef(c)
                );
                const body = await readOptionalJsonBody<JsonWireValue>(c, {}, (value) => value);
                return c.json(
                    await writeTopologyAppInboxCommand({
                        dependencies: deps,
                        authSession,
                        groupRef,
                        requestId: requireRequestId(c, body.raw),
                        payload: { operation: 'deleteOverride', target: 'override' }
                    })
                );
            }
            catch (error) {
                return toMutationErrorResponse(c, error);
            }
        }
    );

    app.post(
        `${GROUP_TOPOLOGY_PATH}/reconfigure/requests/:requestId`,
        async (c) => {
            try {
                const { authSession, groupRef } = await assertCanManageGroupRef(
                    c.req,
                    deps,
                    toGroupRef(c)
                );
                const body = await readOptionalJsonBody(c, {}, decodeReconfigureTopologyBody);
                return c.json(
                    await writeTopologyAppInboxCommand({
                        dependencies: deps,
                        authSession,
                        groupRef,
                        requestId: requireRequestId(c, body.raw),
                        payload: {
                            operation: 'reconfigureTopology',
                            requestOptions: body.value.options ?? {},
                            publish: body.value.publish ?? true
                        }
                    })
                );
            }
            catch (error) {
                return toMutationErrorResponse(c, error);
            }
        }
    );
}

async function handlePutTopologyOverride(
    context: Context,
    dependencies: GraphTopologyRouteDependencies
): Promise<Response> {
    try {
        const { authSession, groupRef } = await assertCanManageGroupRef(
            context.req,
            dependencies,
            toGroupRef(context)
        );
        const body = await readJsonBody(context, decodePutTopologyOverrideBody);
        return context.json(
            await writeTopologyAppInboxCommand({
                dependencies,
                authSession,
                groupRef,
                requestId: requireRequestId(context, body.raw),
                payload: {
                    operation: 'putOverride',
                    config: body.value.config,
                    ttlMs: body.value.expiresAtEpochMs === undefined ? body.value.ttlMs ?? null : null,
                    expiresAtEpochMs: body.value.expiresAtEpochMs ?? null
                }
            })
        );
    }
    catch (error) {
        return toMutationErrorResponse(context, error);
    }
}

async function readCurrentGroupSnapshot(
    groupRef: GroupRef,
    deps: GraphTopologyRouteDependencies
): Promise<GroupSnapshot> {
    const snapshot = await deps.groupStateService.readCurrentSnapshot(groupRef);
    if (!snapshot) {
        throw new Error(`Group not found: ${groupRef.groupId}`);
    }
    return snapshot;
}
async function assertCanReadGroupSnapshot(
    req: { header(name: string): string | undefined; },
    deps: GraphTopologyRouteDependencies,
    snapshot: GroupSnapshot
): Promise<void> {
    if (!deps.strictReadAuthorization) {
        return;
    }
    const authSession = await deps.requireApiAuthSession(req);
    const result = canReadGroupSnapshot({
        snapshot,
        actor: { principalId: authSession.clientId }
    });
    if (!result.allowed) {
        throw new GroupPolicyDeniedError(result);
    }
}

async function assertCanReadScopedGlobalGraph(
    req: { header(name: string): string | undefined; },
    deps: GraphTopologyRouteDependencies
): Promise<void> {
    if (!deps.strictReadAuthorization) {
        return;
    }
    await deps.requireApiAuthSession(req);
}

async function assertCanManageGroupRef(
    req: { header(name: string): string | undefined; },
    deps: GraphTopologyRouteDependencies,
    groupRef: GroupRef
): Promise<
    Readonly<{
        authSession: IssuedAuthSession;
        groupRef: GroupRef;
        snapshot: GroupSnapshot;
    }>
> {
    const authSession = await deps.requireApiAuthSession(req);
    const snapshot = await readCurrentGroupSnapshot(groupRef, deps);
    if (deps.adminClientIds.includes(authSession.clientId)) {
        return { authSession, groupRef, snapshot };
    }

    const result = canUpdateGroupSnapshot({
        snapshot,
        actor: { principalId: authSession.clientId }
    });
    if (!result.allowed) {
        throw new GroupPolicyDeniedError(result);
    }

    return { authSession, groupRef, snapshot };
}

function toGraphDiagnosticResponse(
    c: Context,
    result: Either<string, GraphDiagnosticReadResponse>
): Response {
    if (result.left !== undefined) {
        return c.json({ error: result.left }, graphDiagnosticErrorStatus(result.left));
    }
    return c.json(result.right);
}

function graphDiagnosticErrorStatus(message: string): 400 | 404 {
    return message.includes('No cached graph diagnostic') ||
            message.toLowerCase().includes('not found')
        ? 404
        : 400;
}

function readGraphOptions(c: {
    req: { query(name: string): string | undefined; };
}): GraphDiagnosticReadOptions {
    const refresh = readGraphDiagnosticRefreshMode(c.req.query('refresh'));

    return {
        includeMeasured: readBooleanQuery(c.req.query('includeMeasured')),
        refresh
    };
}

function readBooleanQuery(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === 'true' || value === '1';
}

interface DecodedJsonBody<T> {
    readonly raw: JsonWireValue;
    readonly value: T;
}

async function readJsonBody<T>(
    c: Context,
    decode: (value: JsonWireValue) => T
): Promise<DecodedJsonBody<T>> {
    try {
        const raw = await c.req.json<JsonWireValue>();
        return { raw, value: decode(raw) };
    }
    catch {
        throw topologyRequestError('Malformed JSON request body');
    }
}

async function readOptionalJsonBody<T>(
    c: Context,
    fallback: T,
    decode: (value: JsonWireValue) => T
): Promise<DecodedJsonBody<T>> {
    try {
        const raw = await c.req.text();
        if (raw.trim().length === 0) {
            return { raw: {}, value: fallback };
        }
        const parsed: JsonWireValue = JSON.parse(raw);
        return { raw: parsed, value: decode(parsed) };
    }
    catch {
        throw topologyRequestError('Malformed JSON request body');
    }
}

function requireRequestId(
    c: Context,
    body: JsonWireValue
): string {
    return readApiMutationRouteRequestId({
        requestId: c.req.param('requestId'),
        idempotencyKey: c.req.header('Idempotency-Key'),
        mutationBody: body
    });
}

function readGraphDiagnosticRefreshMode(
    value: string | undefined
): GraphDiagnosticReadOptions['refresh'] {
    const refresh = value ?? 'if-missing';
    switch (refresh) {
        case 'never':
        case 'if-missing':
        case 'always':
            return refresh;
        default:
            throw new Error(`Invalid graph refresh mode: ${value}`);
    }
}

function topologyRequestError(message: string): Error & { status: number; } {
    return Object.assign(new Error(message), { status: 400 });
}

async function writeTopologyAppInboxCommand(
    input: WriteTopologyAppInboxCommandInput
): Promise<TopologyAppInboxResult> {
    const semanticHash = await toTopologyHttpMutationSemanticHash({
        principalId: input.authSession.clientId,
        groupRef: input.groupRef,
        requestId: input.requestId,
        payload: input.payload
    });
    return await input.dependencies.processTopologyAppInbox(input.authSession, {
        operation: input.payload.operation,
        requestId: input.requestId,
        callerId: input.authSession.clientId,
        groupRef: input.groupRef,
        semanticHash,
        materialize: async () =>
            await toTopologyAppInboxCommand({
                actor: {
                    principalId: input.authSession.clientId,
                    sessionId: input.authSession.sessionId
                },
                groupRef: input.groupRef,
                requestId: input.requestId,
                capturedAtEpochMs: input.dependencies.now(),
                payload: input.payload
            })
    });
}

export async function processTopologyAppInbox(
    service: GraphTopologyAppInboxService,
    authority: IssuedAuthSession,
    reservation: TopologyInboxService.HttpCommandReservation
): Promise<TopologyAppInboxResult> {
    const result = await service.processAuthenticatedHttpEntryUntilCompletionResult(
        reservation,
        authority
    );
    return result.fold(
        (error) => {
            throw toApiMutationRouteFailure(error);
        },
        (value): TopologyAppInboxResult => value
    );
}

function toScope(c: {
    req: { param(key: 'applicationId' | 'workspaceId'): string; };
}): StateScope {
    return {
        applicationId: c.req.param('applicationId'),
        workspaceId: c.req.param('workspaceId')
    };
}

function toGroupRef(c: {
    req: { param(key: 'applicationId' | 'workspaceId' | 'groupId'): string; };
}): GroupRef {
    return {
        ...toScope(c),
        groupId: c.req.param('groupId')
    };
}
