import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { readRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { hashRoomInvitationSecret, isRoomGuestAccess, ROOM_GUEST_LIFETIME_MS } from '@shared/api/room-guests/invitation.ts';
import { GUEST_PLAY_TIMELINE } from '@shared/api/room-guests/access.ts';
import { requestJson, type ApiV1RtcTopologyProofApi } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';
import type { ManagedClusterProof } from './run-managed-cluster-proof.mts';

interface GuestCutoffRestartInput extends Pick<ManagedClusterProof.ScenarioInput, 'plans' | 'controls'> {
    readonly users: ApiV1RtcTopologyProofApi;
}

/** Crash the sole queue worker across the four-hour admission boundary. No deadline rows are edited by the test. */
export async function proveGuestCutoffRestart({ plans, controls, users }: GuestCutoffRestartInput): Promise<void> {
    const [worker] = plans;
    assert.ok(worker);
    const origin = worker.baseUrl;
    const preload = fileURLToPath(new URL('./guest-admission-clock-preload.mts', import.meta.url));
    await controls.stop(worker.port, 'crash');
    await controls.restart(worker.port, { ...worker, logPath: worker.logPath + '.guest-admission',
        env: { ...worker.env, BUN_OPTIONS: '--preload=' + preload } });
    const owner = await users.login({ principal: 'alice', label: 'guest-cutoff-owner',
        apiBaseUrl: origin, wsBaseUrl: origin.replace(/^http/, 'ws') });
    const room = { applicationId: 'guest-cutoff-proof', workspaceId: crypto.randomUUID(), groupId: 'market', proofId: crypto.randomUUID() };
    const groups = '/api/state/apps/' + room.applicationId + '/workspaces/' + room.workspaceId + '/groups';
    const group = groups + '/' + room.groupId;
    const mutation = (path: string) => toApiMutationRequestPath(path, crypto.randomUUID());
    await requestJson(origin, mutation(groups), { method: 'POST', session: owner, expectedStatus: 201,
        body: { groupId: room.groupId, displayName: 'Cutoff proof', kind: 'room', joinMode: 'invite-only', maxMembers: 2, createdByPrincipalId: owner.clientId } });
    const invitationSecret = randomBytes(32).toString('hex');
    await requestJson(origin, mutation(group), { method: 'PUT', session: owner, body: { guestInvitationVerifier: await hashRoomInvitationSecret(invitationSecret) } });
    const guest = await requestJson(origin, mutation(group + '/guests'), { method: 'POST', body: { invitationSecret, guestSecret: randomBytes(32).toString('hex') } });
    assert.ok(isRoomGuestAccess(guest), 'Guest credential must carry a valid four-hour lease.');
    assert.equal(guest.expiresAtEpochMs - guest.issuedAtEpochMs, ROOM_GUEST_LIFETIME_MS);
    await controls.stop(worker.port, 'crash');
    await controls.restart(worker.port, { ...worker, logPath: worker.logPath + '.guest-round' });
    await users.connectPresence({ ...room, actor: owner });
    await requestJson(origin, mutation(group + '/director/appoint'), { method: 'POST', session: owner, body: {} });
    const remaining = guest.expiresAtEpochMs - Date.now();
    assert.ok(remaining > 0 && remaining < 60_000, 'Round must start before the guest lease expires.');
    await requestJson(origin, mutation(group), { method: 'PUT', session: owner, body: { roomClock: {
        name: GUEST_PLAY_TIMELINE, operation: 'advance-phase', phase: 'playing', expectedRevision: 0, expectedDirectorEpoch: 1,
        durationMs: remaining + 18_000, participantPrincipalIds: [guest.clientId]
    } } });
    const readSnapshot = async () => {
        const snapshot = await requestJson(origin, group, { method: 'GET', session: owner });
        validateAuthoritativeGroupSnapshot(snapshot, room);
        return snapshot;
    };
    const readGuestStatus = async () => {
        const response = await fetch(origin + group, { headers: { authorization: 'Bearer ' + guest.accessToken, 'x-client-id': guest.clientId } });
        await response.body?.cancel();
        return response.status;
    };
    const occurrence = readRoomTimeline((await readSnapshot()).group.metadata, GUEST_PLAY_TIMELINE);
    const held = occurrence?.guestParticipants?.find(entry => entry.principalId === guest.clientId);
    assert.ok(held && held.leaseExpiresAtEpochMs === guest.expiresAtEpochMs && held.endsAtEpochMs > held.leaseExpiresAtEpochMs);
    await controls.stop(worker.port, 'crash');
    await Bun.sleep(Math.max(0, held.leaseExpiresAtEpochMs - Date.now() + 1));
    await controls.restart(worker.port, { ...worker, logPath: worker.logPath + '.guest-recovered' });
    assert.equal(await readGuestStatus(), 200, 'A restarted server must authorize the current guest during the frozen round.');
    const recovered = await readSnapshot();
    assert.deepEqual(readRoomTimeline(recovered.group.metadata, GUEST_PLAY_TIMELINE)?.guestParticipants, [held]);
    assert.equal(recovered.members.find(member => member.principalId === guest.clientId)?.status, 'active');
    await Bun.sleep(Math.max(0, held.endsAtEpochMs - Date.now() + 1));
    assert.equal(await readGuestStatus(), 403, 'Authorization must stop at the original recorded cutoff.');
    const recovery = AbortSignal.timeout(20_000);
    while ((await readSnapshot()).members.find(member => member.principalId === guest.clientId)?.status !== 'left') {
        recovery.throwIfAborted();
        await Bun.sleep(100);
    }
}
