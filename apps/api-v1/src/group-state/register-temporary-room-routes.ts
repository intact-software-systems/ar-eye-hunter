import type { Hono } from 'hono';
import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import type { CreateTemporaryRoom } from '@shared/api/room-guests/temporary-room.ts';
import { countGroupPlayers } from '@shared/api/group-spectating.ts';
import { hashRoomInvitationSecret, isGuestInvitationVerifier, isRoomGuestDisplayName } from '@shared/api/room-guests/invitation.ts';
import { resolveTemporaryRoomCapacity } from '@shared/api/room-guests/temporary-room-policy.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import { toApiMutationRateLimitResponse, toApiMutationRouteFailure } from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest, type GroupStateRouteRequestContext } from './read-group-state-route-request.ts';
import { readAdmittedGuestAccess } from './read-admitted-guest-access.ts';

async function readCreation(context: GroupStateRouteRequestContext) {
    const request = await readGroupStateRouteRequest<CreateTemporaryRoom & { requestId?: string }>(context);
    if (!isGuestInvitationVerifier(request.guestSecret) || !isGuestInvitationVerifier(request.invitationVerifier) ||
        request.guestSecret === request.invitationVerifier ||
        (request.displayName !== undefined && !isRoomGuestDisplayName(request.displayName)) ||
        Object.keys(request).some(key => !['requestId', 'guestSecret', 'invitationVerifier', 'displayName', 'capacity'].includes(key))) {
        throw new TypeError('Invalid temporary room creation request.');
    }
    return request;
}

export function registerTemporaryRoomRoutes(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post('/api/state/apps/:applicationId/workspaces/:workspaceId/temporary-rooms/requests/:requestId', async context => {
        context.header('Cache-Control', 'no-store');
        try {
            const scope = toGroupStateRouteScope(context);
            const policies = dependencies.temporaryRoomPolicies;
            const policy = Object.hasOwn(policies, scope.applicationId) ? policies[scope.applicationId] : undefined;
            if (!policy) return context.json({ error: 'Temporary room creation is disabled.' }, 403);
            const request = await readCreation(context);
            const capacity = resolveTemporaryRoomCapacity(policy, request.capacity);
            const digest = await hashRoomInvitationSecret(JSON.stringify(['temporary-room', scope.applicationId, scope.workspaceId, request.requestId, request.guestSecret]));
            const roomRef = { ...scope, groupId: 'temporary-' + digest };
            const credential = await toRoomGuestCredential(roomRef, request.guestSecret);
            const existing = await dependencies.groupStateService.readCurrentSnapshot(roomRef);
            if (!existing) {
                const limiter = readRateLimiter('temporary-room-creation', scope.applicationId,
                    new RateLimiterPolicy(policy.creationWindowMs, policy.creationLimit));
                if (!limiter.allow()) return toApiMutationRateLimitResponse(context, 'Temporary room creation limit reached.', policy.creationWindowMs);
            }
            const receipt = await dependencies.processTemporaryRoomCreation({
                roomRef, principalId: credential.clientId, requestId: request.requestId,
                traceId: readApiRequestTraceId(context), capacity, invitationVerifier: request.invitationVerifier,
                ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
                lifetimeMs: policy.lifetimeMs, emptyReturnWindowMs: policy.emptyReturnWindowMs,
                guestTransport: { sessionId: credential.sessionId, accessTokenDigest: await hashAuthSecret(credential.accessToken) }
            });
            receipt.foldLeft(failure => { throw toApiMutationRouteFailure(failure); });
            return context.json({ room: roomRef, access: await readAdmittedGuestAccess(dependencies, roomRef, credential) });
        } catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });

    app.post('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/guests/preview', async context => {
        context.header('Cache-Control', 'no-store');
        try {
            const request: unknown = await context.req.json();
            if (!request || typeof request !== 'object' || !('invitationSecret' in request) ||
                !isGuestInvitationVerifier(request.invitationSecret) || Object.keys(request).length !== 1) {
                throw new TypeError('Preview requires an invitation secret.');
            }
            const verifier = await hashRoomInvitationSecret(request.invitationSecret);
            const roomRef = { ...toGroupStateRouteScope(context), groupId: context.req.param('groupId') };
            const snapshot = await dependencies.groupStateService.readCurrentSnapshot(roomRef);
            const group = snapshot?.group;
            const now = dependencies.nowEpochMs();
            if (!snapshot || !group || group.kind !== 'room' || group.status !== 'active' ||
                group.guestInvitation?.verifier !== verifier || group.guestInvitation.expiresAtEpochMs <= now ||
                (group.expiresAtEpochMs !== null && group.expiresAtEpochMs <= now) ||
                (group.purgeAfterEpochMs !== null && group.purgeAfterEpochMs <= now)) {
                return context.json({ error: 'Invitation unavailable.' }, 404);
            }
            const capacity = group.maxMembers ?? dependencies.groupDefaultMaxMembers;
            return context.json({ displayName: group.displayName, capacity,
                availableSeats: capacity === null ? null : Math.max(0, capacity - countGroupPlayers(snapshot)) });
        } catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}
