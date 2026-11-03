import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { RallarGameMatchRoutingRuntime } from '@shared-web/game/match/rallar-game-match-routing-runtime.ts';
import { RallarGameMatchStatusRuntime } from '@shared-web/game/match/rallar-game-match-status-runtime.ts';

import { createGameRoomStateFixture } from '../rallar-game-room-state-fixture.ts';

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null }));
afterEach(() => vi.unstubAllGlobals());

it('awaits the configured presence handler before sequential subscribers and propagates their failure', async () => {
    const roomRef = { applicationId: 'presence-test', workspaceId: 'default', groupId: 'room' };
    const room = createGameRoomStateFixture(roomRef, [{
        principalId: 'alice',
        username: 'alice',
        role: 'member',
        status: 'active',
        isOwner: false,
        isOnline: true,
        sessionIds: ['peer-a'],
        topicGrants: {}
    }]);
    const facade = createRallarFacade();
    const status = new RallarGameMatchStatusRuntime({
        protocol: 'presence-test',
        topicId: 'presence-test',
        readRoomTarget: () => ({ roomRef }),
        readLocalPeerId: () => 'peer-a',
        readDirectorStatus: () => facade.director.status(),
        readAppointmentEligibility: () => ({ allowed: false, status: 'not-ready', policy: 'none' })
    });
    const received: string[] = [];
    const configured = Promise.withResolvers<void>();
    const subscriber = Promise.withResolvers<void>();
    const routing = new RallarGameMatchRoutingRuntime({
        status,
        readRoomTarget: () => ({ roomRef }),
        readLocalPeerId: () => 'peer-a',
        config: {
            protocol: 'presence-test',
            topicId: 'presence-test',
            rallar: { ...facade, rooms: { ...facade.rooms, state: () => room } },
            onPresence: async () => {
                received.push('configured');
                await configured.promise;
            }
        }
    });
    routing.onPresence(async () => {
        received.push('first');
        await subscriber.promise;
    });
    routing.onPresence(() => {
        received.push('failed');
        throw new Error('subscriber failed');
    });
    routing.onPresence(() => {
        received.push('last');
    });
    const envelope = {
        protocol: 'presence-test',
        kind: 'presence',
        roomRef,
        senderId: 'peer-a',
        senderGenerationId: 'generation-peer-a',
        seq: 1,
        sentAtEpochMs: 1,
        directorEpoch: 0,
        payload: { x: 2 }
    };
    const delivery = routing.handleRealtimeInputOrPresence({
        peerId: 'peer-a',
        laneId: 'presence',
        data: envelope,
        event: new MessageEvent('message', { data: envelope }),
        receivedAtEpochMs: 1
    });
    expect(received).toEqual(['configured']);
    configured.resolve();
    await vi.waitFor(() => expect(received).toEqual(['configured', 'first']));
    subscriber.resolve();
    await expect(delivery).rejects.toThrow('subscriber failed');
    expect(received).toEqual(['configured', 'first', 'failed']);
});
