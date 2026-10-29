import { createRelicGame, RELIC_PROTOCOL_VERSION } from '@relic-hunters/mod.ts';
import { captureRelicGameCommand } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { createTestAuthSession } from '../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import {
    commitMutation,
    prepareMutation,
    requireMutationWrite
} from '../shared-server/rallar-system/group-state/retention/group-retention-database-fixture.ts';
import {
    createGameFixture,
    prepareGameWrite,
    refreshGamePresence
} from './relic-game-database-fixture.ts';

describe('Relic current authority', () => {
    it('requires active membership for reads and mutations in both authorization modes', async () => {
        const fixture = await createGameFixture();
        try {
            const visitor = createTestAuthSession('visitor');
            await new AuthSessionPersistence(fixture.runtime).putSession(visitor);
            const command = {
                ...fixture.command,
                actor: {
                    clientId: visitor.clientId,
                    sessionId: visitor.sessionId,
                    issuedAtEpochMs: visitor.issuedAtEpochMs
                }
            };
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            expect((await prepareGameWrite(fixture, command, initial)).computed.result).toMatchObject({ status: 'refused', httpStatus: 403 });
            const authorized = await prepareGameWrite(fixture, { ...command, authorization: 'authenticated' }, initial);
            expect(authorized.computed.result).toMatchObject({ status: 'refused', code: 'active-membership-required' });
            expect(fixture.service.needsInitialState(authorized.read)).toBe(false);
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            await expect(fixture.service.readCurrentSnapshot(command, 'default-qbox-server')).rejects.toMatchObject({ result: { httpStatus: 403 } });
            await expect(fixture.service.readCurrentSnapshot({ ...command, authorization: 'authenticated' }, 'default-qbox-server'))
                .rejects.toMatchObject({ result: { httpStatus: 403 } });
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('refuses spectator initialization, commands and resets in both modes before proposing state', async () => {
        const fixture = await createGameFixture();
        try {
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            for (const authorization of ['authenticated', 'group-policy'] as const) {
                for (const operation of ['ensure', 'reset', 'command'] as const) {
                    const command = {
                        ...fixture.command,
                        authorization,
                        operation,
                        move: operation === 'command'
                            ? {
                                protocolVersion: RELIC_PROTOCOL_VERSION,
                                kind: 'join-expedition' as const,
                                gameId: fixture.ref.groupId,
                                username: fixture.owner.username
                            }
                            : null
                    };
                    const read = await fixture.service.read(fixture.service.capture(captureRelicGameCommand(command), initial, 'default-qbox-server'));
                    if (!read.group) {
                        throw new Error('Expected room');
                    }
                    const spectator = {
                        ...read,
                        group: {
                            ...read.group,
                            snapshot: {
                                ...read.group.snapshot,
                                members: read.group.snapshot.members.map((member) => ({ ...member, role: 'spectator' as const }))
                            }
                        }
                    };
                    expect(fixture.service.needsInitialState(spectator)).toBe(false);
                    const computed = fixture.service.compute({ ...spectator, attemptCount: 2, traceId: 'spectator-retry' });
                    expect(computed.result).toMatchObject({ status: 'refused', code: 'spectator-read-only' });
                    expect(computed.save).toBeNull();
                    expect(computed.outboxWrites).toEqual([]);
                }
            }
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('reads a spectator room without creating a save and rechecks a removed membership', async () => {
        const fixture = await createGameFixture();
        try {
            const visitor = createTestAuthSession('watcher');
            await new AuthSessionPersistence(fixture.runtime).putSession(visitor);
            const admitted = await prepareMutation(
                fixture,
                mutationDescriptor({
                    operation: 'upsertMember',
                    scope: fixture.ref,
                    groupId: fixture.ref.groupId,
                    targetPrincipalId: visitor.clientId,
                    request: { requestId: 'watcher-admit', status: 'active', role: 'spectator', actorPrincipalId: fixture.owner.clientId }
                })
            );
            await commitMutation(fixture, requireMutationWrite(admitted.computed));
            const command = {
                ...fixture.command,
                authorization: 'authenticated' as const,
                actor: { clientId: visitor.clientId, sessionId: visitor.sessionId, issuedAtEpochMs: visitor.issuedAtEpochMs }
            };
            await expect(fixture.service.readCurrentSnapshot(command, 'default-qbox-server')).resolves.toBeNull();
            expect((await prepareGameWrite(fixture, command, null)).computed.result).toMatchObject({ code: 'spectator-read-only' });
            const initialized = await prepareGameWrite(fixture, fixture.command, createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs));
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, initialized.computed));
            const snapshot = await fixture.service.readCurrentSnapshot(command, 'default-qbox-server');
            expect(snapshot?.players).toEqual([]);
            expect(snapshot).not.toHaveProperty('pendingActions');
            expect(snapshot?.relics.every((relic) => relic.roomId === '' && relic.value === 0 && relic.name === 'Unknown relic')).toBe(true);
            const removed = await prepareMutation(
                fixture,
                mutationDescriptor({
                    operation: 'upsertMember',
                    scope: fixture.ref,
                    groupId: fixture.ref.groupId,
                    targetPrincipalId: visitor.clientId,
                    request: { requestId: 'watcher-remove', status: 'removed', actorPrincipalId: fixture.owner.clientId }
                })
            );
            await commitMutation(fixture, requireMutationWrite(removed.computed));
            await expect(fixture.service.readCurrentSnapshot(command, 'default-qbox-server')).rejects.toMatchObject({ result: { httpStatus: 403 } });
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('requires a live room session for commands and owner permission for resets', async () => {
        const fixture = await createGameFixture();
        try {
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const command = {
                ...fixture.command,
                operation: 'command' as const,
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    kind: 'join-expedition' as const,
                    gameId: fixture.ref.groupId,
                    username: fixture.owner.username
                }
            };
            expect((await prepareGameWrite(fixture, command, initial)).computed.result).toMatchObject({ status: 'refused', httpStatus: 403 });
            const connected = await prepareMutation(
                fixture,
                mutationDescriptor({
                    operation: 'connectPresence',
                    scope: fixture.ref,
                    groupId: fixture.ref.groupId,
                    sessionId: fixture.owner.sessionId,
                    request: {
                        requestId: 'owner-connect',
                        principalId: fixture.owner.clientId,
                        generationId: 'owner-generation',
                        connectionGenerationId: 'owner-connection',
                        connectedAtEpochMs: fixture.nowEpochMs,
                        lastHeartbeatAtEpochMs: fixture.nowEpochMs,
                        expiresAtEpochMs: fixture.nowEpochMs + 60_000,
                        actorPrincipalId: fixture.owner.clientId
                    }
                })
            );
            await commitMutation(fixture, requireMutationWrite(connected.computed));
            await refreshGamePresence(fixture);
            expect((await prepareGameWrite(fixture, command, initial)).computed.result).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
            expect((await prepareGameWrite(fixture, { ...fixture.command, operation: 'reset' }, initial)).computed.result.status).toBe('applied');
            const visitor = createTestAuthSession('visitor');
            await new AuthSessionPersistence(fixture.runtime).putSession(visitor);
            const member = await prepareMutation(
                fixture,
                mutationDescriptor({
                    operation: 'upsertMember',
                    scope: fixture.ref,
                    groupId: fixture.ref.groupId,
                    targetPrincipalId: visitor.clientId,
                    request: { requestId: 'member-visitor', status: 'active', actorPrincipalId: fixture.owner.clientId }
                })
            );
            await commitMutation(fixture, requireMutationWrite(member.computed));
            const denied = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'reset',
                actor: {
                    clientId: visitor.clientId,
                    sessionId: visitor.sessionId,
                    issuedAtEpochMs: visitor.issuedAtEpochMs
                }
            }, initial);
            expect(denied.computed.result).toMatchObject({ status: 'refused', httpStatus: 403 });
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('rejects a revoked or replaced issued session before creating a proposal or save', async () => {
        const fixture = await createGameFixture();
        try {
            const replaced = { ...fixture.command, actor: { ...fixture.command.actor, issuedAtEpochMs: fixture.owner.issuedAtEpochMs + 1 } };
            const read = await fixture.service.read(fixture.service.capture(captureRelicGameCommand(replaced), null, 'default-qbox-server'));
            expect(fixture.service.needsInitialState(read)).toBe(false);
            expect(fixture.service.compute({ ...read, attemptCount: 1, traceId: 'trace-relic-game-authorization' }).result).toMatchObject({
                status: 'refused',
                code: 'invalid-session',
                httpStatus: 401
            });
            await new AuthSessionPersistence(fixture.runtime).deleteSession(fixture.owner);
            await expect(fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server'))
                .rejects.toMatchObject({ result: { code: 'invalid-session' } });
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    });
});
