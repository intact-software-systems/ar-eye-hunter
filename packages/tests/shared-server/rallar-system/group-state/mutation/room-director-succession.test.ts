import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { expect, it } from 'vitest';
import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { createService, requireSnapshot, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';

async function createCourt() {
    const database = new GroupBarrierRepository();
    const base = Date.now();
    database.nowEpochMs = () => base;
    await seedOpenGroup(database, 'court');
    const writerAt = (offset: number) => createService({
        runtimeRepository: database, nowEpochMs: base + offset, attemptCount: 4, injectedRandomId: () => crypto.randomUUID(), timing: undefined
    });
    const writer = writerAt(2000);
    const owner = { actorPrincipalId: 'alice', actorSessionId: 'alice-session' };
    const player = { actorPrincipalId: 'bob', actorSessionId: 'bob-session' };
    await writer.joinGroup(SCOPE, 'court', { actorPrincipalId: 'bob', requestId: 'join-bob' });
    for (const actor of [owner, player]) {
        await writer.connectPresenceSession(SCOPE, 'court', actor.actorSessionId, {
            ...actor, principalId: actor.actorPrincipalId, generationId: 'presence-' + actor.actorPrincipalId,
            connectionGenerationId: 'socket-' + actor.actorPrincipalId, publicationKey: null, requestId: 'connect-' + actor.actorPrincipalId
        });
    }
    const metadata = async () => (await requireSnapshot(database, 'court')).group.metadata;
    return { writer, writerAt, base, owner, player, metadata };
}

it('serializes appointments and opens the deputy window on director disconnect', async () => {
    const { writer, writerAt, base, owner, player, metadata } = await createCourt();
    await writer.appointDirector(SCOPE, 'court', { ...owner, requestId: 'configure', succession: {
        operation: 'configure', expectedDirectorEpoch: 0, expectedRevision: 0, reconnectWindowMs: 100, deputyWindowMs: 150,
        deputyPrincipalId: 'alice'
    } });
    expect(await metadata()).toHaveProperty('rallarDirectorSuccession.deputyPrincipalId', 'alice');
    const appoint = { operation: 'appoint', expectedDirectorEpoch: 0, targetPrincipalId: 'bob', targetSessionId: 'bob-session' } as const;
    const race = await Promise.allSettled(['replace-one', 'replace-two'].map(requestId =>
        writerAt(2000).appointDirector(SCOPE, 'court', { ...owner, requestId, succession: appoint })));
    expect(race.filter(result => result.status === 'fulfilled'), race.map(result => result.status === 'rejected' ? String(result.reason) : 'applied').join(', ')).toHaveLength(1);
    expect(readRallarGroupDirectorAppointment(await metadata())).toMatchObject({ principalId: 'bob', sessionId: 'bob-session', epoch: 1 });
    await writer.disconnectPresenceSession(SCOPE, 'court', player.actorSessionId, {
        actorPrincipalId: 'bob', principalId: 'bob', generationId: 'presence-bob', reason: 'closed', requestId: 'director-disconnect'
    });
    expect(await metadata()).toHaveProperty('rallarDirectorSuccession.loss.reconnectUntilEpochMs', base + 2100);
    const claim = { operation: 'claim-deputy', expectedDirectorEpoch: 1 } as const;
    await expect(writerAt(2099).appointDirector(SCOPE, 'court', { ...owner, requestId: 'too-early', succession: claim })).rejects.toThrow();
    await writerAt(2100).appointDirector(SCOPE, 'court', { ...owner, requestId: 'deputy-claim', succession: claim });
    expect(readRallarGroupDirectorAppointment(await metadata())).toMatchObject({ principalId: 'alice', epoch: 2 });
    await expect(writerAt(2101).appointDirector(SCOPE, 'court', { ...player, requestId: 'unfenced' })).rejects.toThrow();
});

it('admits a specifically appointed spectator and refuses a session from another account', async () => {
    const { writer, owner } = await createCourt();
    await writer.updateGroup(SCOPE, 'court', { ...owner, requestId: 'allow-spectators', maxSpectators: 1 });
    const spectator = { actorPrincipalId: 'sam', actorSessionId: 'sam-browser' };
    await writer.joinGroup(SCOPE, 'court', { ...spectator, participation: 'spectator', requestId: 'watch' });
    await writer.connectPresenceSession(SCOPE, 'court', spectator.actorSessionId, {
        ...spectator, principalId: 'sam', generationId: 'sam-generation', connectionGenerationId: 'sam-socket', publicationKey: null, requestId: 'arrive'
    });
    const appoint = { operation: 'appoint', expectedDirectorEpoch: 0, targetPrincipalId: 'sam', targetSessionId: 'sam-browser' } as const;
    await expect(writer.appointDirector(SCOPE, 'court', { ...owner, requestId: 'wrong-session', succession: {
        ...appoint, targetSessionId: 'bob-session'
    } })).rejects.toMatchObject({ code: 'group-mutation-rejected' });
    await writer.appointDirector(SCOPE, 'court', { ...owner, requestId: 'appoint-spectator', succession: appoint });
    await writer.updateGroup(SCOPE, 'court', { ...spectator, requestId: 'start-program', roomClock: {
        operation: 'publish-schedule', name: 'court-program', expectedDirectorEpoch: 1, expectedRevision: 0,
        phases: [{ phase: 'game', startsAtEpochMs: 2000 }]
    } });
});

it('settles a silent lease expiration from the stored expiry, without a disconnect or sweep', async () => {
    const { writer, writerAt, base, owner, player, metadata } = await createCourt();
    await writerAt(2010).connectPresenceSession(SCOPE, 'court', player.actorSessionId, {
        ...player, principalId: 'bob', generationId: 'short-lease', connectionGenerationId: 'socket-bob',
        publicationKey: null, expiresAtEpochMs: base + 2400, requestId: 'short-lease'
    });
    await writer.appointDirector(SCOPE, 'court', { ...owner, requestId: 'configure', succession: {
        operation: 'configure', expectedDirectorEpoch: 0, expectedRevision: 0, reconnectWindowMs: 100, deputyWindowMs: 150, deputyPrincipalId: 'alice'
    } });
    await writerAt(2020).appointDirector(SCOPE, 'court', { ...owner, requestId: 'appointment', succession: {
        operation: 'appoint', expectedDirectorEpoch: 0, targetPrincipalId: 'bob', targetSessionId: 'bob-session'
    } });
    const claim = { operation: 'claim-deputy', expectedDirectorEpoch: 1 } as const;
    await expect(writerAt(2499).appointDirector(SCOPE, 'court', { ...owner, succession: claim, requestId: 'early' })).rejects.toThrow();
    const replacement = { ...owner, requestId: 'claim', succession: claim };
    await writerAt(2500).appointDirector(SCOPE, 'court', replacement);
    await writerAt(2510).appointDirector(SCOPE, 'court', replacement);
    expect(readRallarGroupDirectorAppointment(await metadata())).toMatchObject({ principalId: 'alice', epoch: 2 });
});

it('preserves the epoch through metadata writes and revokes a departed director even after rejoining', async () => {
    const { writer, writerAt, owner, player, metadata } = await createCourt();
    await writer.appointDirector(SCOPE, 'court', { ...owner, requestId: 'appointment', succession: {
        operation: 'appoint', expectedDirectorEpoch: 0, targetPrincipalId: 'bob', targetSessionId: 'bob-session'
    } });
    await writer.updateGroup(SCOPE, 'court', { ...owner, requestId: 'merge', metadata: { venue: 'Court A' } });
    expect(readRallarGroupDirectorAppointment(await metadata())).toMatchObject({ epoch: 1 });
    await writer.banGroupMember(SCOPE, 'court', 'bob', { ...owner, requestId: 'ban' });
    await writer.unbanGroupMember(SCOPE, 'court', 'bob', { ...owner, requestId: 'readmit' });
    await writer.joinGroup(SCOPE, 'court', { ...player, requestId: 'rejoin' });
    await writerAt(2010).connectPresenceSession(SCOPE, 'court', player.actorSessionId, {
        ...player, principalId: 'bob', generationId: 'rejoin', connectionGenerationId: 'socket-bob', publicationKey: null, requestId: 'reconnect'
    });
    await expect(writerAt(2011).updateGroup(SCOPE, 'court', { ...player, requestId: 'stale-command', roomClock: {
        operation: 'publish-schedule', name: 'program', expectedRevision: 0, expectedDirectorEpoch: 1, phases: [{ phase: 'game', startsAtEpochMs: 100 }]
    } })).rejects.toMatchObject({ code: 'room-director-changed' });
});
