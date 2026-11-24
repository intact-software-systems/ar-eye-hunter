import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAuthSessionApiHttpError, createAuthSessionGroupSnapshot } from '../auth-session-contract-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from './browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();
installFakeBroadcastChannelPerTest();
beforeEach(resetAuthSessionContractMocks);

afterEach(() => vi.restoreAllMocks());

async function guestRound(now = 1_600) {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const pointReads = await import('@shared-web/browser/state-read/point-read.ts');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const room = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'town' };
    const guest = { ...mocks.ctx.session, guestRoom: room, expiresAtEpochMs: 1_500 };
    let stored: typeof guest | undefined = guest;
    mocks.readSession.mockImplementation(() => stored);
    mocks.clearSession.mockImplementation(() => { stored = undefined; });
    const snapshot = createAuthSessionGroupSnapshot(room.groupId, [guest.clientId]);
    const member = { ...snapshot.members[0], guestLease: { admittedAtEpochMs: 500, expiresAtEpochMs: 1_500 } };
    const round = { name: 'guest-play', phase: 'playing', startedAtRevision: 1, status: 'running', revision: 1, endsAtEpochMs: 3_000,
        guestParticipants: [{ principalId: guest.clientId, leaseExpiresAtEpochMs: 1_500, endsAtEpochMs: 3_000 }] };
    const active = { ...snapshot, causalRevision: {groupRevision: 1, presenceRevision: 1}, members: [member], group: { ...snapshot.group, kind: 'room' as const, metadata: { rallarRoomClocks: [round] } } };
    const read = vi.spyOn(pointReads, 'readStateGroupSnapshot').mockResolvedValue({
        snapshot: active, source: 'durable', groupRevision: 1, presenceRevision: 1
    });
    const facade = createRallarFacade();
    expect(facade.auth.restore()).toEqual(guest);
    const closed = (groupRevision: number) => ({ ...active, group: { ...active.group, metadata: {} },
        causalRevision: { ...active.causalRevision, groupRevision } });
    return { facade, guest, room, read, active, closed, stored: () => stored };
}

it('keeps a connected guest in the current occurrence from admission expiry until cutoff', async () => {
    const { facade, stored, read, room, guest } = await guestRound(1_000);
    await facade.connect();
    await vi.advanceTimersByTimeAsync(499);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledWith('town', room, expect.objectContaining({ authSession: guest }));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(facade.isConnected()).toBe(true);
    expect(stored()).toEqual(guest);
    await vi.advanceTimersByTimeAsync(1);
    expect(stored()).toBeUndefined();
    expect(facade.isConnected()).toBe(false);
});

it('reconnects with the original credential after the verification transport fails', async () => {
    const { facade, guest, read, stored } = await guestRound();
    read.mockRejectedValueOnce(new TypeError('Temporary transport interruption'));
    await expect(facade.connect()).rejects.toThrow('Temporary transport interruption');
    expect(facade.isConnected()).toBe(false);
    expect(stored()).toEqual(guest);
    await facade.connect();
    expect(facade.isConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_400);
    expect(stored()).toBeUndefined();
});

it.each([0, 2])('resolves room revision %i arriving during durable verification of revision 1', async revision => {
    const { facade, active, closed, read, stored } = await guestRound();
    const started = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    read.mockImplementationOnce(async () => {
        started.resolve();
        await received.promise;
        return { snapshot: active, source: 'durable', groupRevision: 1, presenceRevision: 1 };
    });
    const connecting = facade.connect();
    await started.promise;
    for (const [notify] of mocks.onCacheChange.mock.calls) await notify({ clients: [], groups: [closed(revision)] });
    received.resolve();
    if (revision === 2) {
        await expect(connecting).rejects.toThrow();
    } else {
        await connecting;
        expect(facade.isConnected()).toBe(true);
        await vi.advanceTimersByTimeAsync(1_400);
    }
    expect(stored()).toBeUndefined();
});

it.each(['snapshot', 'policy-close'])('ends the finishing guest on early close delivered by %s', async event => {
    const { facade, read, closed, stored } = await guestRound();
    await facade.connect();
    if (event === 'policy-close') {
        read.mockRejectedValueOnce(createAuthSessionApiHttpError(403, 'Room access ended'));
        for (const [, listener] of mocks.webSocket.onWebsocketCallbacksDo.mock.calls) {
            listener.onClose?.(new CloseEvent('close', { code: 1008 }));
        }
    } else {
        for (const [notify] of mocks.onCacheChange.mock.calls) await notify({ clients: [], groups: [closed(2)] });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toBeUndefined();
    expect(facade.isConnected()).toBe(false);
});
