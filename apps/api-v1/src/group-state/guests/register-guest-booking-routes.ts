import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { authorizationDenied } from '@shared-server/http/request-auth-service.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { requireExactKeys, requireOneOf, requirePositiveInteger, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import type { Hono } from 'hono';
import { toApiMutationRouteFailure } from '../../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../../services/read-api-request-trace-id.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from '../group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from '../group-state-route-errors.ts';
import { readGroupStateRouteRequest } from '../read-group-state-route-request.ts';
import { readAdmittedGuestAccess } from './read-admitted-guest-access.ts';

export function requireGuestBookingApplication(dependencies: GroupStateRouteDependencies, app: string): void {
    if (!Object.hasOwn(dependencies.guestBookingByApplication, app) || dependencies.guestBookingByApplication[app] !== true) {
        throw authorizationDenied('Guest booking is disabled for this application.');
    }
}

export function registerGuestBookingRoutes(app: Hono, dependencies: GroupStateRouteDependencies): void {
    const path = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/session/guest';
    app.post(path + '/preview', async context => {
        context.header('Cache-Control', 'no-store');
        try {
            const room = { ...toGroupStateRouteScope(context), groupId: context.req.param('groupId')! };
            requireGuestBookingApplication(dependencies, room.applicationId);
            const body = requireRecord(await context.req.json(), 'Guest booking preview');
            requireExactKeys(body, ['guestSecret'], 'Guest booking preview');
            requireString(body.guestSecret, 'Guest secret');
            const guest = await toRoomGuestCredential(room, body.guestSecret);
            const preview = await dependencies.sessionDirectory.read(room, guest.clientId, 'guest-booking');
            if (!preview?.schedule.guestBooking) return context.json({ error: 'Guest booking unavailable.' }, 404);
            return context.json(preview);
        } catch (error) { return toGroupMutationErrorResponse(context, error); }
    });
    app.post(path + '/requests/:requestId', async context => {
        context.header('Cache-Control', 'no-store');
        try {
            const roomRef = { ...toGroupStateRouteScope(context), groupId: context.req.param('groupId')! };
            requireGuestBookingApplication(dependencies, roomRef.applicationId);
            const body = await readGroupStateRouteRequest<ApiJsonObject & { requestId?: string }>(context);
            requireExactKeys(body, ['requestId', 'action', 'expectedScheduleRevision', 'guestSecret'], 'Guest booking request');
            requireString(body.guestSecret, 'Guest secret');
            requirePositiveInteger(body.expectedScheduleRevision, 'Expected schedule revision');
            const action = requireOneOf(body.action, ['reserve', 'withdraw', 'claim'] as const, 'Guest booking action');
            const credential = await toRoomGuestCredential(roomRef, body.guestSecret);
            dependencies.groupAdmissionQuota.require({ family: 'join-admission', groupRef: roomRef, principalId: credential.clientId });
            const booking = { roomRef, principalId: credential.clientId, requestId: body.requestId,
                expectedScheduleRevision: Number(body.expectedScheduleRevision), traceId: readApiRequestTraceId(context) };
            const receipt = await dependencies.processGuestBooking(action === 'claim' ? { ...booking, action,
                guestTransport: { sessionId: credential.sessionId, accessTokenDigest: await hashAuthSecret(credential.accessToken) } } : { ...booking, action });
            receipt.foldLeft(failure => { throw toApiMutationRouteFailure(failure); });
            if (action !== 'claim') return context.json({ accepted: true });
            return context.json(await readAdmittedGuestAccess(dependencies, roomRef, credential));
        } catch (error) { return toGroupMutationErrorResponse(context, error); }
    });
}
