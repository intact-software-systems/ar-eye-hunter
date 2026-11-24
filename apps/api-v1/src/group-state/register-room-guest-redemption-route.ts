import type { Hono } from 'hono';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { roomGuestAccessMode } from '@shared/api/room-guest-access.ts';
import { hashRoomInvitationSecret, isGuestInvitationVerifier, isRoomGuestDisplayName, type RoomGuestRedemption } from '@shared/api/room-guest-invitation.ts';
import { ApiMutationRouteFailure, createApiMutationFailure, toApiMutationRouteFailure } from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest, type GroupStateRouteRequestContext } from './read-group-state-route-request.ts';

export function registerRoomGuestRedemptionRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/guests/requests/:requestId', async context => {
        context.header('Cache-Control', 'no-store');
        try {
            const roomRef = { ...toGroupStateRouteScope(context), groupId: context.req.param('groupId') };
            const request = await readGuestRedemption(context);
            const credential = await toRoomGuestCredential(roomRef, request.guestSecret);
            dependencies.groupAdmissionQuota.require({ family: 'join-admission', groupRef: roomRef, principalId: credential.clientId });
            const receipt = await dependencies.processGuestAdmission({
                roomRef, principalId: credential.clientId, invitationVerifier: await hashRoomInvitationSecret(request.invitationSecret),
                ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
                guestTransport: { sessionId: credential.sessionId, accessTokenDigest: await hashAuthSecret(credential.accessToken) },
                requestId: request.requestId, traceId: readApiRequestTraceId(context)
            });
            receipt.foldLeft(failure => { throw toApiMutationRouteFailure(failure); });
            // Replayed successes describe the original admission. A removed guest must not regain a credential.
            const current = await dependencies.groupStateService.readCurrentSnapshot(roomRef);
            const now = dependencies.nowEpochMs();
            const member = current?.members.find(candidate => candidate.principalId === credential.clientId);
            if (!current || !member?.guestLease || roomGuestAccessMode(current.group, member, now) === 'expired') {
                throw new ApiMutationRouteFailure(createApiMutationFailure({
                    code: 'guest-access-ended', status: 403, message: 'Guest access to this room has ended.'
                }));
            }
            return context.json({ ...credential, issuedAtEpochMs: member.guestLease.admittedAtEpochMs, expiresAtEpochMs: member.guestLease.expiresAtEpochMs });
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

async function readGuestRedemption(context: GroupStateRouteRequestContext): Promise<RoomGuestRedemption & { requestId: string }> {
    const request = await readGroupStateRouteRequest<RoomGuestRedemption & { requestId?: string }>(context);
    if (Object.keys(request).some(key => !['requestId', 'invitationSecret', 'guestSecret', 'displayName'].includes(key)) || !isGuestInvitationVerifier(request.invitationSecret) ||
        !isGuestInvitationVerifier(request.guestSecret) || request.invitationSecret === request.guestSecret) {
        throw new TypeError('Redemption requires distinct invitation and guest secrets.');
    }
    if (request.displayName !== undefined && !isRoomGuestDisplayName(request.displayName)) {
        throw new TypeError('Invalid guest display name.');
    }
    return request;
}
