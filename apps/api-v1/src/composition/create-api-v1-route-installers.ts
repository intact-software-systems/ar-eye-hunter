import type { Hono } from 'jsr:@hono/hono@4.11.9';

import { readGroupGraphDiagnostic, readScopedGlobalGraphDiagnostic } from '@shared-graph/graph-diagnostics-service.ts';
import type { RallarServerRouteInstaller } from '@shared-server/rallar-facade/rallar-server-application.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { ApiConfig } from '@shared/api/api-config.ts';
import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';

import {
    registerAdminOperationsRoutes,
    type AdminOperationsRouteService
} from '../admin-operations/register-admin-operations-routes.ts';
import type {
    ApiV1GroupAdmissionConfiguration,
    ApiV1IceConfiguration,
    ApiV1OperatorTokenConfiguration
} from '../configuration/api-v1-configuration.ts';
import { createApiCrdtDocumentAccessAuthorizer } from '../crdt/create-api-crdt-document-authorizer.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';
import * as crdtAdminRoutes from '../crdt/register-crdt-admin-routes.ts';
import * as adminSupportRoutes from '../routes/admin-support-routes.ts';
import * as configRoutes from '../routes/config-route.ts';
import * as graphTopologyRoutes from '../routes/graph-topology-routes.ts';
import * as iceRoutes from '../routes/ice-route.ts';
import * as spaStatisticsRoutes from '../routes/spa-statistics-routes.ts';
import {
    createStateSnapshotReadRouteRegistrars,
    type ApiV1StateSnapshotRouteRuntime
} from '../routes/state-snapshot-read/create-state-snapshot-read-route-registrars.ts';
import * as swaggerRoutes from '../routes/swagger-routes.ts';
import * as wsRoutes from '../routes/ws-routes.ts';
import { requireApiAuthSession, requireWsAuthSession } from '../services/request-auth-service.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1TopologyServices } from './create-api-v1-topology-services.ts';

export interface ApiV1WsAuthRequestFacts {
    readonly requestId: string;
}

export interface ApiV1RouteAuthRequest {
    readonly header: (name: string) => string | undefined;
}

export interface ApiV1RouteWsAuthRequest {
    readonly sessionId: string;
    readonly ticket?: string;
}

export interface ApiV1RouteInstallerRuntime extends ApiV1StateSnapshotRouteRuntime {
    readonly wsQBoxServerService: Pick<ApiV1Runtime['wsQBoxServerService'], 'socket'>;
    readonly appAuthInboxService: configRoutes.ConfigRouteDependencies['appAuthInbox'];
    readonly appClientInboxService: Pick<
        ApiV1Runtime['appClientInboxService'],
        | 'enqueueAuthorisedWsClientConnect'
        | 'processAuthenticatedEntryUntilCompletion'
    >;
    readonly topologyInboxService: Pick<
        ApiV1Runtime['topologyInboxService'],
        | 'processAuthenticatedEntryUntilCompletion'
        | 'processAuthenticatedEntryUntilCompletionResult'
        | 'processAuthenticatedHttpEntryUntilCompletionResult'
    >;
    readonly groupsRepository: Pick<ApiV1Runtime['groupsRepository'], 'readSnapshot'>;
    readonly clientsRepository: Pick<ApiV1Runtime['clientsRepository'], 'readSnapshot'>;
}

export interface ApiV1RouteInstallerTopology {
    readonly topologyQuery: graphTopologyRoutes.GraphTopologyRouteQuery;
    readonly topologyPlanning: graphTopologyRoutes.GraphTopologyRoutePlanning;
    readonly adminClientIds: readonly string[];
    readonly groupStateRepository: Readonly<{
        readLifecyclePolicy: graphTopologyRoutes.GraphTopologyRouteDependencies['readLifecyclePolicy'];
    }>;
}

export interface ApiV1RouteInstallerAdminServices {
    readonly operations: AdminOperationsRouteService;
    readonly support: adminSupportRoutes.AdminSupportRouteUseCases;
    readonly statistics: spaStatisticsRoutes.SpaStatisticsRouteService;
}

export interface CreateApiV1RouteInstallersInput<
    Runtime extends ApiV1RouteInstallerRuntime = ApiV1Runtime,
    Topology extends ApiV1RouteInstallerTopology = ApiV1TopologyServices,
> {
    readonly runtime: Runtime;
    readonly topology: Topology;
    readonly admin: ApiV1RouteInstallerAdminServices;
    readonly crdtLogRepository: RallarCrdtAdminReadRepository;
    readonly crdtMutations: CrdtAdminMutations;
    readonly authUserRepository: AuthUserRepository;
    readonly authentication: configRoutes.ConfigRouteDependencies['authentication'];
    readonly operatorToken: ApiV1OperatorTokenConfiguration;
    readonly publicConfiguration: ApiConfig;
    readonly ice: ApiV1IceConfiguration;
    readonly groupAdmission: ApiV1GroupAdmissionConfiguration;
    readonly strictReadAuthorization: boolean;
    readonly nowEpochMs: () => number;
    readonly createTokenId: () => string;
    readonly createWsAuthRequestFacts: () => ApiV1WsAuthRequestFacts;
}

export interface ApiV1RouteInstallers {
    readonly ws: RallarServerRouteInstaller<Hono>;
    readonly rest: readonly RallarServerRouteInstaller<Hono>[];
}

export interface ApiV1RouteInstallerOperations<Runtime extends ApiV1RouteInstallerRuntime> {
    readonly requireApiAuthSession: (
        request: ApiV1RouteAuthRequest,
        repository: Runtime['authSessionRepository']
    ) => Promise<IssuedAuthSession>;
    readonly requireWsAuthSession: (
        input: ApiV1RouteWsAuthRequest,
        appAuthInbox: Runtime['appAuthInboxService'],
        facts: ApiV1WsAuthRequestFacts
    ) => Promise<IssuedAuthSession>;
}

interface ApiV1RouteConstruction<
    Runtime extends ApiV1RouteInstallerRuntime,
    Topology extends ApiV1RouteInstallerTopology,
> {
    readonly input: CreateApiV1RouteInstallersInput<Runtime, Topology>;
    readonly operations: ApiV1RouteInstallerOperations<Runtime>;
    readonly requireSession: (
        request: ApiV1RouteAuthRequest
    ) => Promise<IssuedAuthSession>;
    readonly snapshots: ReturnType<typeof createStateSnapshotReadRouteRegistrars>;
    readonly authorizeCrdtDocumentAccess: ReturnType<typeof createApiCrdtDocumentAccessAuthorizer>;
}

export function createApiV1RouteInstallers(
    input: CreateApiV1RouteInstallersInput
): ApiV1RouteInstallers {
    return constructApiV1RouteInstallers<ApiV1Runtime, ApiV1TopologyServices>(
        input,
        PRODUCTION_OPERATIONS
    );
}

export function constructApiV1RouteInstallers<
    Runtime extends ApiV1RouteInstallerRuntime,
    Topology extends ApiV1RouteInstallerTopology,
>(
    input: CreateApiV1RouteInstallersInput<Runtime, Topology>,
    operations: ApiV1RouteInstallerOperations<Runtime>
): ApiV1RouteInstallers {
    const construction = createApiV1RouteConstruction(input, operations);
    return {
        ws: createApiV1WsRouteInstaller(construction),
        rest: [
            ...createApiV1StateRouteInstallers(construction),
            ...createApiV1AdministrationRouteInstallers(construction)
        ]
    };
}

function createApiV1RouteConstruction<
    Runtime extends ApiV1RouteInstallerRuntime,
    Topology extends ApiV1RouteInstallerTopology,
>(
    input: CreateApiV1RouteInstallersInput<Runtime, Topology>,
    operations: ApiV1RouteInstallerOperations<Runtime>
): ApiV1RouteConstruction<Runtime, Topology> {
    const { runtime } = input;
    const requireSession = (request: ApiV1RouteAuthRequest) =>
        operations.requireApiAuthSession(request, runtime.authSessionRepository);
    const snapshots = createStateSnapshotReadRouteRegistrars(runtime, {
        requireApiAuthSession: operations.requireApiAuthSession
    }, {
        groupAdmission: input.groupAdmission,
        strictReadAuthorization: input.strictReadAuthorization
    });
    const authorizeCrdtDocumentAccess = createApiCrdtDocumentAccessAuthorizer({
        readGroupSnapshot: (ref) => runtime.groupsRepository.readSnapshot(ref),
        readClientSnapshot: (ref) => runtime.clientsRepository.readSnapshot(ref),
        nowEpochMs: input.nowEpochMs
    });
    return {
        input,
        operations,
        requireSession,
        snapshots,
        authorizeCrdtDocumentAccess
    };
}

function createApiV1WsRouteInstaller<
    Runtime extends ApiV1RouteInstallerRuntime,
    Topology extends ApiV1RouteInstallerTopology,
>(
    construction: ApiV1RouteConstruction<Runtime, Topology>
): RallarServerRouteInstaller<Hono> {
    const { input, operations } = construction;
    return (app) =>
        wsRoutes.registerWsRoutes(app, {
            socketServer: input.runtime.wsQBoxServerService.socket,
            appClientInboxService: input.runtime.appClientInboxService,
            requireWsAuthSession: (request) =>
                operations.requireWsAuthSession(
                    request,
                    input.runtime.appAuthInboxService,
                    input.createWsAuthRequestFacts()
                )
        });
}

function createApiV1StateRouteInstallers<
    Runtime extends ApiV1RouteInstallerRuntime,
    Topology extends ApiV1RouteInstallerTopology,
>(
    construction: ApiV1RouteConstruction<Runtime, Topology>
): readonly RallarServerRouteInstaller<Hono>[] {
    const { input, requireSession, snapshots } = construction;
    return [
        (app) =>
            configRoutes.registerConfigRoutes(app, {
                requireApiAuthSession: requireSession,
                now: input.nowEpochMs,
                createTokenId: input.createTokenId,
                appAuthInbox: input.runtime.appAuthInboxService,
                authUserRepository: input.authUserRepository,
                authentication: input.authentication,
                operatorToken: input.operatorToken,
                publicConfiguration: input.publicConfiguration
            }),
        (app) =>
            iceRoutes.registerIceRoutes(app, {
                requireApiAuthSession: requireSession,
                configuration: input.ice,
                nowEpochMs: input.nowEpochMs
            }),
        snapshots.client,
        snapshots.group,
        (app) =>
            spaStatisticsRoutes.registerSpaStatisticsRoutes(app, {
                statistics: input.admin.statistics,
                requireApiAuthSession: requireSession
            }),
        (app) =>
            graphTopologyRoutes.registerGraphTopologyRoutes(app, {
                groupStateService: snapshots.graphGroupStateService,
                graphDiagnostics: {
                    readScopedGlobalGraphDiagnostic,
                    readGroupGraphDiagnostic
                },
                topologyQuery: input.topology.topologyQuery,
                topologyPlanning: input.topology.topologyPlanning,
                processTopologyAppInbox: (authority, enqueue) =>
                    graphTopologyRoutes.processTopologyAppInbox(
                        input.runtime.topologyInboxService,
                        authority,
                        enqueue
                    ),
                requireApiAuthSession: requireSession,
                adminClientIds: input.topology.adminClientIds,
                readLifecyclePolicy: (ref) => input.topology.groupStateRepository.readLifecyclePolicy(ref),
                strictReadAuthorization: input.strictReadAuthorization,
                now: input.nowEpochMs
            })
    ];
}

function createApiV1AdministrationRouteInstallers<
    Runtime extends ApiV1RouteInstallerRuntime,
    Topology extends ApiV1RouteInstallerTopology,
>(
    construction: ApiV1RouteConstruction<Runtime, Topology>
): readonly RallarServerRouteInstaller<Hono>[] {
    const { authorizeCrdtDocumentAccess, input, requireSession } = construction;
    return [
        (app) =>
            crdtAdminRoutes.registerCrdtAdminRoutes(app, {
                repository: input.crdtLogRepository,
                crdtAdminMutations: input.crdtMutations,
                adminClientIds: input.topology.adminClientIds,
                requireApiAdminSession: async (context) => await requireSession(context.req),
                requireApiUserSession: async (context) => await requireSession(context.req),
                authorizeCatchUp: ({ document, session }) =>
                    authorizeCrdtDocumentAccess({
                        document,
                        actorPrincipalId: session.username,
                        sessionId: session.sessionId
                    })
            }),
        (app) =>
            registerAdminOperationsRoutes(app, {
                adminClientIds: input.topology.adminClientIds,
                operations: input.admin.operations,
                requireApiAuthSession: requireSession
            }),
        (app) =>
            adminSupportRoutes.init(app, {
                adminClientIds: input.topology.adminClientIds,
                support: input.admin.support,
                requireApiAuthSession: requireSession
            }),
        swaggerRoutes.installApiDocumentationRoutes
    ];
}

const PRODUCTION_OPERATIONS: ApiV1RouteInstallerOperations<ApiV1Runtime> = {
    requireApiAuthSession,
    requireWsAuthSession
};
