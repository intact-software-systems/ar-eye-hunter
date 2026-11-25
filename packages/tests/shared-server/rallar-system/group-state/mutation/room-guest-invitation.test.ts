import { expect, it } from 'vitest';
import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { createService, requireSnapshot, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';

it('rotates a room guest invitation for fifteen minutes at server time without renewing it on replay', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'market', 4);
    let now = 10_000;
    const service = createService({ runtimeRepository: runtime, nowEpochMs: () => now, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
    const first = { actorPrincipalId: 'alice', requestId: 'first', guestInvitationVerifier: 'a'.repeat(64) };
    await service.updateGroup(SCOPE, 'market', first);
    const read = async () => (await requireSnapshot(runtime, 'market')).group.guestInvitation;
    expect(await read()).toEqual({ verifier: first.guestInvitationVerifier, expiresAtEpochMs: 910_000 });
    now = 20_000;
    await service.updateGroup(SCOPE, 'market', first);
    expect((await read())?.expiresAtEpochMs).toBe(910_000);
    await service.updateGroup(SCOPE, 'market', { ...first, requestId: 'repeat-verifier' });
    expect((await read())?.expiresAtEpochMs).toBe(910_000);
    const second = { ...first, requestId: 'second', guestInvitationVerifier: 'b'.repeat(64) };
    await service.updateGroup(SCOPE, 'market', second);
    await service.updateGroup(SCOPE, 'market', first);
    expect(await read()).toEqual({ verifier: second.guestInvitationVerifier, expiresAtEpochMs: 920_000 });
});

it('denies an active admin and rejects malformed verifiers before changing the invitation', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'market');
    const service = createService({ runtimeRepository: runtime, nowEpochMs: 10_000, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
    await service.joinGroup(SCOPE, 'market', { actorPrincipalId: 'bob', requestId: 'join' });
    await service.setGroupMemberRole(SCOPE, 'market', 'bob', { actorPrincipalId: 'alice', requestId: 'admin', role: 'admin' });
    await expect(service.updateGroup(SCOPE, 'market', {
        actorPrincipalId: 'bob', requestId: 'issue', guestInvitationVerifier: 'a'.repeat(64)
    })).rejects.toThrow(/owner/i);
    await expect(service.updateGroup(SCOPE, 'market', {
        actorPrincipalId: 'alice', requestId: 'malformed', guestInvitationVerifier: 'invalid'
    })).rejects.toThrow(/verifier/i);
    expect((await requireSnapshot(runtime, 'market')).group.guestInvitation).toBeUndefined();
});

it('clears the invitation when the owner closes the room', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'market');
    const service = createService({ runtimeRepository: runtime, nowEpochMs: 10_000, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
    await service.updateGroup(SCOPE, 'market', {
        actorPrincipalId: 'alice', requestId: 'issue', guestInvitationVerifier: 'a'.repeat(64)
    });
    await service.updateGroup(SCOPE, 'market', { actorPrincipalId: 'alice', requestId: 'close', status: 'archived' });
    expect((await requireSnapshot(runtime, 'market')).group.guestInvitation).toBeUndefined();
});
