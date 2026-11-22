import { RallarRoomLobby } from '@shared-web/browser/rooms/lobby/rallar-room-lobby.ts';
import type { RoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import { ViewPushBrowser } from '../../api/view-push-browser.ts';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@shared-web/browser/api-client-config.ts', () => ({ readApiBaseUrl: () => 'http://api.test' }));
afterEach(() => vi.unstubAllGlobals());

const scope = { applicationId: 'courts', workspaceId: 'league' };
const roomRef = { ...scope, groupId: 'A' };
const session = { clientId: 'alice', username: 'alice', sessionId: 'session-alice', accessToken: 'test', expiresAtEpochMs: 9999999999999 };

it('recovers a missed held-seat deadline across socket reconnect and rejects another account’s view', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let view: RoomLobbyAccountView = { scope, principalId: 'alice', seat: { roomRef, status: 'away', deadlineEpochMs: null } };
    const reads: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
        reads.push(url);
        return Response.json(view);
    });
    const push = new ViewPushBrowser(() => session);
    const owner = new RallarRoomLobby({
        session: () => session, ws: push.ws, messages: push.messages, auth: { onChange: () => () => {} }
    }, scope);
    try {
        vi.useFakeTimers();
        try {
            await owner.start();
            expect(reads).toEqual(['http://api.test/api/room-lobbies/apps/courts/workspaces/league']);
            expect(owner.getState().view).toEqual(view);
            await vi.advanceTimersByTimeAsync(300000);
            expect(reads).toHaveLength(1);
        }
        finally {
            vi.useRealTimers();
        }
        view = { ...view, seat: { roomRef, status: 'away', deadlineEpochMs: 120100 } };
        push.reopen();
        await expect.poll(() => owner.getState().view?.seat?.deadlineEpochMs).toBe(120100);
        view = { ...view, principalId: 'bob' };
        await owner.refresh();
        expect(owner.getState().view).toBeNull();
        expect(owner.getState().error).toMatch(/account/i);
    }
    finally {
        owner.stop();
    }
});
