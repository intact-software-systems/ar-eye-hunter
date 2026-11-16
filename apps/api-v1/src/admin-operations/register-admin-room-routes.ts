import type { Context, Hono } from 'hono';

import { RequestAuthFailure, toAuthErrorResponse } from '@shared-server/http/request-auth-service.ts';
import type { ReadAdminRoomDirectory } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-directory.ts';
import type { ReadAdminRoomTopologyPlans } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-plans.ts';
import type { ReadAdminRoomTopologyWork } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-work.ts';
import type { AdminRoomDirectoryRequest } from '@shared/api/admin-rooms/admin-room-directory.ts';
import {
    ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    type AdminRoomTopologyPlansRequest
} from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import type { AdminRoomTopologyWorkRequest } from '@shared/api/admin-rooms/admin-room-topology-work.ts';
import { decodeAdminTopologyOutboxId } from '@shared/api/admin-rooms/decode-admin-room-topology-work.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import { requireApiAdminSession, type ApiAdminAuthDependencies } from '../services/admin-auth-service.ts';

export interface AdminRoomRouteDependencies extends ApiAdminAuthDependencies {
    readonly directory: Pick<ReadAdminRoomDirectory, 'read'>;
    readonly topologyWork: Pick<ReadAdminRoomTopologyWork, 'read'>;
    readonly topologyPlans: Pick<ReadAdminRoomTopologyPlans, 'read'>;
}

export function registerAdminRoomRoutes(app: Hono, dependencies: AdminRoomRouteDependencies): void {
    app.get(
        '/api/admin/operations/rooms/apps/:applicationId/workspaces/:workspaceId',
        (context) =>
            readAuthorizedRoomEvidence(context, dependencies, {
                parse: toDirectoryRequest,
                read: (request) => dependencies.directory.read(request)
            })
    );
    app.get(
        '/api/admin/operations/rooms/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology-work/:outboxId',
        (context) =>
            readAuthorizedRoomEvidence(context, dependencies, {
                parse: toTopologyWorkRequest,
                read: (request) => dependencies.topologyWork.read(request)
            })
    );
    app.get(
        '/api/admin/operations/rooms/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology-plans',
        (context) =>
            readAuthorizedRoomEvidence(context, dependencies, {
                parse: toTopologyPlansRequest,
                read: (request) => dependencies.topologyPlans.read(request)
            })
    );
}

interface AdminRoomReadOperation<Request, Result> {
    parse(request: Context['req']): Either<string, Request>;
    read(request: Request): Promise<Result>;
}

async function readAuthorizedRoomEvidence<Request, Result>(
    context: Context,
    dependencies: AdminRoomRouteDependencies,
    operation: AdminRoomReadOperation<Request, Result>
): Promise<Response> {
    context.header('Cache-Control', 'private, no-store');
    try {
        await requireApiAdminSession(context.req, dependencies);
        const request = operation.parse(context.req);
        if (request.left !== undefined) {
            return context.json({ error: request.left }, 400);
        }
        return context.json(await operation.read(request.right!));
    }
    catch (error) {
        return error instanceof RequestAuthFailure
            ? toAuthErrorResponse(context, error)
            : context.json({ error: 'Room inspection is unavailable' }, 500);
    }
}

function toDirectoryRequest(request: Context['req']): Either<string, AdminRoomDirectoryRequest> {
    try {
        const limit = decodePageLimit(request, DIRECTORY_PAGE_LIMIT);
        if (limit.left !== undefined) {
            return Either.ofLeft(limit.left);
        }
        const afterGroupId = request.query('afterGroupId');
        if ((request.queries('afterGroupId')?.length ?? 0) > 1) {
            return Either.ofLeft('Room directory cursor must occur once');
        }
        return Either.ofRight({
            scope: {
                applicationId: assertValidRallarRouteId(request.param('applicationId')),
                workspaceId: assertValidRallarRouteId(request.param('workspaceId'))
            },
            limit: limit.right!,
            afterGroupId: afterGroupId === undefined ? null : assertValidRallarRouteId(afterGroupId)
        });
    }
    catch {
        return Either.ofLeft('Room directory scope or cursor is invalid');
    }
}

function toTopologyWorkRequest(request: Context['req']): Either<string, AdminRoomTopologyWorkRequest> {
    try {
        return Either.ofRight({
            roomRef: {
                applicationId: assertValidRallarRouteId(request.param('applicationId')),
                workspaceId: assertValidRallarRouteId(request.param('workspaceId')),
                groupId: assertValidRallarRouteId(request.param('groupId'))
            },
            outboxId: decodeAdminTopologyOutboxId(request.param('outboxId'))
        });
    }
    catch {
        return Either.ofLeft('Topology work scope or receipt identity is invalid');
    }
}

interface PageLimitRule {
    readonly defaultLimit: number;
    readonly maxLimit: number;
    readonly refusal: string;
}

const DIRECTORY_PAGE_LIMIT: PageLimitRule = {
    defaultLimit: 50,
    maxLimit: 100,
    refusal: 'Room directory limit must be an integer from 1 through 100'
};

const TOPOLOGY_PLANS_PAGE_LIMIT: PageLimitRule = {
    defaultLimit: 50,
    maxLimit: ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    refusal: `Topology plans limit must be an integer from 1 through ${ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT}`
};

function decodePageLimit(request: Context['req'], rule: PageLimitRule): Either<string, number> {
    const rawLimit = request.query('limit') ?? String(rule.defaultLimit);
    const limit = Number(rawLimit);
    return /^[1-9]\d*$/.test(rawLimit) && limit <= rule.maxLimit && (request.queries('limit')?.length ?? 0) <= 1
        ? Either.ofRight(limit)
        : Either.ofLeft(rule.refusal);
}

function toTopologyPlansRequest(request: Context['req']): Either<string, AdminRoomTopologyPlansRequest> {
    const limit = decodePageLimit(request, TOPOLOGY_PLANS_PAGE_LIMIT);
    if (limit.left !== undefined) {
        return Either.ofLeft(limit.left);
    }
    const afterPublicationId = request.query('afterPublicationId');
    if ((request.queries('afterPublicationId')?.length ?? 0) > 1 || afterPublicationId === '') {
        return Either.ofLeft('Topology plans cursor must occur once and not be empty');
    }
    try {
        return Either.ofRight({
            roomRef: {
                applicationId: assertValidRallarRouteId(request.param('applicationId')),
                workspaceId: assertValidRallarRouteId(request.param('workspaceId')),
                groupId: assertValidRallarRouteId(request.param('groupId'))
            },
            limit: limit.right!,
            afterPublicationId: afterPublicationId === undefined
                ? null
                : decodeAdminTopologyOutboxId(afterPublicationId)
        });
    }
    catch {
        return Either.ofLeft('Topology plans scope or cursor is invalid');
    }
}
