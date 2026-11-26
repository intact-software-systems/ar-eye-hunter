import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { requestJson, type ProofSession } from '../../topology-replay/api-v1-rtc-topology-proof-api.mts';

/** The guest and registered player race different api-v1 writers sharing the same Postgres seat. */
export async function proveScheduledGuestReservations(owner: ProofSession, player: ProofSession): Promise<void> {
    const groups = '/api/state/apps/ar-eye-hunter/workspaces/' + crypto.randomUUID() + '/groups';
    const session = groups + '/pickup/session';
    const guest = session + '/guest';
    const guestSecret = randomBytes(32).toString('hex');
    const startsAtEpochMs = Date.now() + 21 * 86_400_000;
    const command = (path: string) => toApiMutationRequestPath(path, crypto.randomUUID());
    await requestJson(owner.apiBaseUrl, command(groups), { method: 'POST', session: owner, expectedStatus: 201,
        body: { groupId: 'pickup', displayName: 'Upcoming pickup', kind: 'room', joinMode: 'open',
            createdByPrincipalId: owner.clientId, retention: { mode: 'temporary' }, maxMembers: 2,
            scheduledStartAtEpochMs: startsAtEpochMs, guestBooking: true } });
    const decide = (action: 'reserve' | 'withdraw', expectedScheduleRevision: number) => ({
        action, expectedScheduleRevision, startsAtEpochMs: null
    });
    const [accountResult, guestResult] = await Promise.all([
        requestJson(owner.apiBaseUrl, command(session), { method: 'POST', session: player, expectedStatus: [200, 400],
            body: decide('reserve', 1) }),
        requestJson(player.apiBaseUrl, command(guest), { method: 'POST', expectedStatus: [200, 400],
            body: { guestSecret, action: 'reserve', expectedScheduleRevision: 1 } })
    ]);
    const guestWon = guestResult.accepted === true;
    assert.notEqual(accountResult.accepted === true, guestWon);
    const preview = (origin: string) => requestJson(origin, guest + '/preview', { method: 'POST', body: { guestSecret } });
    for (const origin of [owner.apiBaseUrl, player.apiBaseUrl]) {
        const view = await preview(origin);
        assert.equal(view.participation, guestWon ? 'reserved' : 'none');
        assert.equal(view.availableSeats, 0);
        assert.equal(view.canEnter, false);
    }
    if (!guestWon) {
        await requestJson(owner.apiBaseUrl, command(session), { method: 'POST', session: player, body: decide('withdraw', 1) });
        await requestJson(player.apiBaseUrl, command(guest), { method: 'POST', body: { guestSecret, action: 'reserve', expectedScheduleRevision: 1 } });
    }
    await requestJson(owner.apiBaseUrl, command(session), { method: 'POST', session: owner, body: {
        action: 'reschedule', expectedScheduleRevision: 1, startsAtEpochMs: startsAtEpochMs + 3_600_000
    } });
    const revised = await preview(player.apiBaseUrl);
    assert.equal(revised.participation, 'needs-confirmation');
    assert.equal(revised.availableSeats, 1);
    await requestJson(player.apiBaseUrl, command(guest), { method: 'POST', expectedStatus: 400,
        body: { guestSecret, action: 'reserve', expectedScheduleRevision: 1 } });
    await requestJson(player.apiBaseUrl, command(guest), { method: 'POST',
        body: { guestSecret, action: 'reserve', expectedScheduleRevision: 2 } });
    assert.equal((await preview(owner.apiBaseUrl)).participation, 'reserved');
}
