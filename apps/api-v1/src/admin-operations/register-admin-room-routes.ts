import type { Context, Hono } from 'jsr:@hono/hono@4.11.9';

import { RequestAuthFailure, toAuthErrorResponse } from '@shared-server/http/request-auth-service.ts';
import type { ReadAdminRoomDirectory } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-directory.ts';
import type { ReadAdminRoomTopologyWork } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-work.ts';
import type { AdminRoomDirectoryRequest } from '@shared/api/admin-rooms/admin-room-directory.ts';
import type { AdminRoomTopologyWorkRequest } from '@shared/api/admin-rooms/admin-room-topology-work.ts';
import { decodeAdminTopologyOutboxId } from '@shared/api/admin-rooms/decode-admin-room-topology-work.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import { requireApiAdminSession, type ApiAdminAuthDependencies } from '../services/admin-auth-service.ts';

export interface AdminRoomRouteDependencies extends ApiAdminAuthDependencies {
    readonly directory: Pick<ReadAdminRoomDirectory, 'read'>;
    readonly topologyWork: Pick<ReadAdminRoomTopologyWork, 'read'>;
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
        const rawLimit = request.query('limit') ?? '50';
        const limit = Number(rawLimit);
        if (!/^[1-9]\d*$/.test(rawLimit) || limit > 100 || (request.queries('limit')?.length ?? 0) > 1) {
            return Either.ofLeft('Room directory limit must be an integer from 1 through 100');
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
            limit,
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
