import { readRoomGuestSession } from '@shared-server/http/room-guest-request.ts';
import type { ReadAdminRoomTopologyPlans } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-plans.ts';
import type { ReadAdminRoomTopologyWork } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-work.ts';
import type { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { registerRoomLobbyReadRoute } from '../room-lobbies/register-room-lobby-read-route.ts';
import {
    registerTournamentRoutes,
    type TournamentRouteDependencies
} from '../tournaments/register-tournament-routes.ts';
import { registerViewWatchRoutes, type ViewWatchRouteDependencies } from '../view-watch/register-view-watch-routes.ts';

import { readGroupGraphDiagnostic, readScopedGlobalGraphDiagnostic } from '@shared-graph/graph-diagnostics-service.ts';
import type { RallarServerRouteInstaller } from '@shared-server/rallar-server/rallar-server-application.ts';
import type { AdminOperationUseCases } from '@shared-server/rallar-system/admin-operations/admin-operation-use-cases.ts';
import type { ReadAdminRoomDirectory } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-directory.ts';
import type { AdminSupportUseCases } from '@shared-server/rallar-system/admin-support/admin-support-contracts.ts';
import type { AuthPasswordDerivationAdmission } from '@shared-server/rallar-system/auth/credentials/auth-password-derivation-admission.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import type { PersistedWebSocketTicket } from '@shared-server/rallar-system/auth/persistence/persisted-auth-ticket.ts';
import type { ApiConfigResponse } from '@shared/api/api-config.ts';
import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';

import { registerAdminOperationsRoutes } from '../admin-operations/register-admin-operations-routes.ts';
import { registerAdminRoomRoutes } from '../admin-operations/register-admin-room-routes.ts';
import type {
    ApiV1GroupAdmissionConfiguration,
    ApiV1GroupConfiguration,
    ApiV1IceConfiguration,
    ApiV1OperatorTokenConfiguration
} from '../configuration/api-v1-configuration.ts';
import { createApiCrdtDocumentAccessAuthorizer } from '../crdt/create-api-crdt-document-authorizer.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';
import * as crdtAdminRoutes from '../crdt/register-crdt-admin-routes.ts';
import { registerFriendsRoutes, type FriendsRouteDependencies } from '../friends/register-friends-routes.ts';
import {
    registerMatchmakingRoutes,
    type MatchmakingRouteDependencies
} from '../matchmaking/register-matchmaking-routes.ts';
import { registerPartyRoutes, type PartyRouteDependencies } from '../parties/register-party-routes.ts';
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
import { requireApiAuthSession } from '../services/request-auth-service.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1TopologyServices } from './create-api-v1-topology-services.ts';

export interface ApiV1RouteAuthRequest {
    readonly header: (name: string) => string | undefined;
}

export interface ApiV1RouteInstallerRuntime extends ApiV1StateSnapshotRouteRuntime {
    readonly viewWatches: { readonly mutate: ViewWatchRouteDependencies['mutation']; };
    readonly wsQBoxServerService: Pick<ApiV1Runtime['wsQBoxServerService'], 'socket'>;
    readonly appAuthInboxService: configRoutes.ConfigRouteDependencies['appAuthInbox'];
    readonly passwordDerivationAdmission: AuthPasswordDerivationAdmission;
    readonly appClientInboxService: Pick<
        ApiV1Runtime['appClientInboxService'],
        | 'writeAuthorisedWsClientConnect'
        | 'enqueueAuthorisedWsClientDisconnect'
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
    readonly rtcTopologyExecutionRepository: Pick<
        ApiV1Runtime['rtcTopologyExecutionRepository'],
        'readTopologyReshapeGate'
    >;
}

export interface ApiV1RouteInstallerTopology {
    readonly topologyQuery: graphTopologyRoutes.GraphTopologyRouteQuery;
    readonly topologyPlanning: graphTopologyRoutes.GraphTopologyRoutePlanning;
    readonly adminClientIds: readonly string[];
    readonly groupStateRepository:
        & Pick<ApiV1TopologyServices['groupStateRepository'], 'findLobbyCommitmentEntry' | 'readLobbyOccupancy'>
        & Readonly<{
            readLifecyclePolicy: graphTopologyRoutes.GraphTopologyRouteDependencies['readLifecyclePolicy'];
        }>;
    readonly readPlannedLayoutFingerprint:
        graphTopologyRoutes.GraphTopologyRouteDependencies['readPlannedLayoutFingerprint'];
}

export interface ApiV1RouteInstallerAdminServices {
    readonly rooms: Pick<ReadAdminRoomDirectory, 'read'>;
    readonly topologyWork: Pick<ReadAdminRoomTopologyWork, 'read'>;
    readonly topologyPlans: Pick<ReadAdminRoomTopologyPlans, 'read'>;
    readonly operations: AdminOperationUseCases;
    readonly support: AdminSupportUseCases;
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
    readonly friends: Omit<FriendsRouteDependencies, 'requireSession'>;
    readonly matchmaking: Omit<MatchmakingRouteDependencies, 'requireSession'>;
    readonly tournaments: Omit<TournamentRouteDependencies, 'requireSession'>;
    readonly parties: Omit<PartyRouteDependencies, 'requireSession'>;
    readonly authUserRepository: AuthUserRepository;
    readonly authentication: configRoutes.ConfigRouteDependencies['authentication'];
    readonly operatorToken: ApiV1OperatorTokenConfiguration;
    readonly publicConfiguration: ApiConfigResponse;
    readonly ice: ApiV1IceConfiguration;
    readonly temporaryRoomPolicies: ApiV1GroupConfiguration['temporaryRoomPoliciesByApplication'];
    readonly groupAdmission: ApiV1GroupAdmissionConfiguration;
    readonly groupDefaultMaxMembers: number | null;
    readonly strictReadAuthorization: boolean;
    readonly nowEpochMs: () => number;
    readonly createTokenId: () => string;
}

export interface ApiV1RouteInstallers {
    readonly webSocket: RallarServerRouteInstaller<Hono>;
    readonly rest: readonly RallarServerRouteInstaller<Hono>[];
}

export interface ApiV1RouteInstallerOperations<Runtime extends ApiV1RouteInstallerRuntime> {
    readonly requireApiAuthSession: (
        request: ApiV1RouteAuthRequest,
        repository: Runtime['authSessionRepository']
    ) => Promise<IssuedAuthSession>;
    readonly readWsConnectTicket: (
        ticketDigest: string,
        repository: Runtime['authSessionRepository']
    ) => Promise<PersistedWebSocketTicket | undefined>;
    readonly readWsConnectSession: (
        sessionId: string,
        repository: Runtime['authSessionRepository']
    ) => Promise<PersistedAuthSession | undefined>;
    readonly upgradeWebSocket: wsRoutes.RegisterWsRoutesInput['upgradeWebSocket'];
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
    function installApiV1RestRoutes(app: Hono): void {
        registerApiV1StateRoutes(app, construction);
        registerViewWatchRoutes(app, {
            mutation: input.runtime.viewWatches.mutate,
            requireSession: construction.requireSession
        });
        registerFriendsRoutes(app, { ...input.friends, requireSession: construction.requireSession });
        registerRoomLobbyReadRoute(app, {
            requireSession: construction.requireSession,
            read: async (scope, principalId) => {
                const entry = await input.topology.groupStateRepository.findLobbyCommitmentEntry(scope, principalId);
                return entry?.value ?? { scope, principalId, seat: null };
            }
        });
        registerMatchmakingRoutes(app, { ...input.matchmaking, requireSession: construction.requireSession });
        registerTournamentRoutes(app, { ...input.tournaments, requireSession: construction.requireSession });
        registerPartyRoutes(app, { ...input.parties, requireSession: construction.requireSession });
        registerApiV1AdministrationRoutes(app, construction);
    }
    return {
        webSocket: createApiV1WsRouteInstaller(construction),
        rest: [installApiV1RestRoutes]
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
        readLobbyOccupancy: (rooms, now) => input.topology.groupStateRepository.readLobbyOccupancy(rooms, now),
        requireApiAuthSession: operations.requireApiAuthSession
    }, {
        temporaryRoomPolicies: input.temporaryRoomPolicies,
        groupAdmission: input.groupAdmission,
        strictReadAuthorization: input.strictReadAuthorization,
        groupDefaultMaxMembers: input.groupDefaultMaxMembers,
        nowEpochMs: input.nowEpochMs
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
            serverPeerId: input.publicConfiguration.clockPeerId ?? input.publicConfiguration.serverPeerId,
            socketServer: input.runtime.wsQBoxServerService.socket,
            readGuestRoom: (ref) => input.runtime.groupsRepository.readSnapshot(ref),
            appClientInboxService: input.runtime.appClientInboxService,
            readWsConnectTicket: (ticketDigest) =>
                operations.readWsConnectTicket(ticketDigest, input.runtime.authSessionRepository),
            readWsConnectSession: (sessionId) =>
                operations.readWsConnectSession(sessionId, input.runtime.authSessionRepository),
            upgradeWebSocket: operations.upgradeWebSocket,
            nowEpochMs: input.nowEpochMs
        });
}

function registerApiV1StateRoutes<
    Runtime extends ApiV1RouteInstallerRuntime,
    Topology extends ApiV1RouteInstallerTopology,
>(app: Hono, construction: ApiV1RouteConstruction<Runtime, Topology>): void {
    const { input, requireSession, snapshots } = construction;
    const requireTransportSession = async (request: ApiV1RouteAuthRequest) =>
        await readRoomGuestSession({
            request,
            readSnapshot: (ref) => input.runtime.groupsRepository.readSnapshot(ref),
            nowEpochMs: input.nowEpochMs
        }) ?? await requireSession(request);
    configRoutes.registerConfigRoutes(app, {
        requireTransportSession,
        requireApiAuthSession: requireSession,
        now: input.nowEpochMs,
        createTokenId: input.createTokenId,
        appAuthInbox: input.runtime.appAuthInboxService,
        passwordDerivationAdmission: input.runtime.passwordDerivationAdmission,
        authUserRepository: input.authUserRepository,
        authentication: input.authentication,
        operatorToken: input.operatorToken,
        publicConfiguration: input.publicConfiguration
    });
    iceRoutes.registerIceRoutes(app, {
        requireApiAuthSession: requireTransportSession,
        configuration: input.ice,
        nowEpochMs: input.nowEpochMs
    });
    snapshots.client(app);
    snapshots.group(app);
    spaStatisticsRoutes.registerSpaStatisticsRoutes(app, {
        statistics: input.admin.statistics,
        requireApiAuthSession: requireSession
    });
    graphTopologyRoutes.registerGraphTopologyRoutes(app, {
        groupStateService: snapshots.graphGroupStateService,
        graphDiagnostics: {
            readScopedGlobalGraphDiagnostic,
            readGroupGraphDiagnostic
        },
        topologyQuery: input.topology.topologyQuery,
        topologyPlanning: input.topology.topologyPlanning,
        processTopologyAppInbox: (authority, enqueue) =>
            graphTopologyRoutes.processTopologyAppInbox(input.runtime.topologyInboxService, authority, enqueue),
        requireApiAuthSession: requireSession,
        adminClientIds: input.topology.adminClientIds,
        readLifecyclePolicy: (ref) => input.topology.groupStateRepository.readLifecyclePolicy(ref),
        readPlannedLayoutFingerprint: input.topology.readPlannedLayoutFingerprint,
        reshapeGates: input.runtime.rtcTopologyExecutionRepository,
        strictReadAuthorization: input.strictReadAuthorization,
        now: input.nowEpochMs
    });
}

function registerApiV1AdministrationRoutes<
    Runtime extends ApiV1RouteInstallerRuntime,
    Topology extends ApiV1RouteInstallerTopology,
>(app: Hono, construction: ApiV1RouteConstruction<Runtime, Topology>): void {
    const { authorizeCrdtDocumentAccess, input, requireSession } = construction;
    crdtAdminRoutes.registerCrdtAdminRoutes(app, {
        repository: input.crdtLogRepository,
        crdtAdminMutations: input.crdtMutations,
        adminClientIds: input.topology.adminClientIds,
        requireApiAdminSession: async (context) => await requireSession(context.req),
        requireApiUserSession: async (context) => await requireSession(context.req),
        authorizeCatchUp: ({ document, session }) =>
            authorizeCrdtDocumentAccess({ document, actorPrincipalId: session.username, sessionId: session.sessionId })
    });
    registerAdminRoomRoutes(app, {
        directory: input.admin.rooms,
        topologyWork: input.admin.topologyWork,
        topologyPlans: input.admin.topologyPlans,
        adminClientIds: input.topology.adminClientIds,
        requireApiAuthSession: requireSession
    });
    registerAdminOperationsRoutes(app, {
        adminClientIds: input.topology.adminClientIds,
        operations: input.admin.operations,
        requireApiAuthSession: requireSession
    });
    adminSupportRoutes.registerAdminSupportRoutes(app, {
        adminClientIds: input.topology.adminClientIds,
        support: input.admin.support,
        requireApiAuthSession: requireSession
    });
    swaggerRoutes.installApiDocumentationRoutes(app);
}

const PRODUCTION_OPERATIONS: ApiV1RouteInstallerOperations<ApiV1Runtime> = {
    requireApiAuthSession,
    readWsConnectTicket: async (ticketDigest, repository) =>
        (await repository.findWebSocketTicketByDigestEntry(ticketDigest))?.value,
    readWsConnectSession: (sessionId, repository) => repository.findBySessionId(sessionId),
    upgradeWebSocket
};
