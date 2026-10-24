import { createRelicGame, RELIC_PROTOCOL_VERSION } from '@relic-hunters/mod.ts';
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
    it('allows authenticated mode for an active room, but group-policy mode requires membership', async () => {
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
            expect(authorized.computed.result.status).toBe('initialized');
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, authorized.computed));
            await expect(fixture.service.readCurrentSnapshot(command, 'default-qbox-server')).rejects.toMatchObject({ result: { httpStatus: 403 } });
            await expect(fixture.service.readCurrentSnapshot({ ...command, authorization: 'authenticated' }, 'default-qbox-server'))
                .resolves.toMatchObject({ gameId: fixture.ref.groupId });
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
            const read = await fixture.service.read(fixture.service.capture(replaced, null, 'default-qbox-server'));
            expect(fixture.service.needsInitialState(read)).toBe(false);
            expect(fixture.service.compute(read).result).toMatchObject({ status: 'refused', code: 'invalid-session', httpStatus: 401 });
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
