import { describe, expect, it } from 'vitest';

import {
    deriveArenaLinkState,
    deriveArenaPresenceNotices,
    type ArenaLinkState,
} from '../../../apps/ar-eye-hunter-v1/src/game/squadLink.ts';

describe('AR Eye Hunter squad link awareness', () => {
    it('maps transport state to player-facing squad link labels', () => {
        expect(deriveArenaLinkState({
            connectionState: 'signed-out',
            networkEnabled: false,
            roomSelected: false,
            playerCount: 0,
            rtcLanes: [],
        })).toMatchObject({
            tone: 'offline',
            label: 'Offline preview',
            actionNeeded: true,
        });

        expect(deriveArenaLinkState({
            connectionState: 'connected',
            networkEnabled: true,
            roomSelected: true,
            playerCount: 1,
            rtcLanes: [],
        })).toMatchObject({
            tone: 'live',
            label: 'Solo arena',
            detail: 'No squadmates linked yet.',
        });

        expect(deriveArenaLinkState({
            connectionState: 'connected',
            networkEnabled: true,
            roomSelected: true,
            playerCount: 3,
            rtcLanes: [{ laneId: 'motion', status: 'partial', readyPeers: 1, notReadyPeers: 1 }],
        })).toMatchObject({
            tone: 'forming',
            label: 'Squad link forming',
            playerCount: 3,
        });

        expect(deriveArenaLinkState({
            connectionState: 'connected',
            networkEnabled: true,
            roomSelected: true,
            playerCount: 2,
            rtcLanes: [{ laneId: 'motion', status: 'open', readyPeers: 1, notReadyPeers: 0 }],
        })).toMatchObject({
            tone: 'live',
            label: '2 hunters linked',
            actionNeeded: false,
        });

        expect(deriveArenaLinkState({
            connectionState: 'connected',
            networkEnabled: true,
            roomSelected: true,
            playerCount: 2,
            rtcLanes: [{ laneId: 'motion', status: 'closed', readyPeers: 0, notReadyPeers: 1 }],
            wsTicketBackoffStatus: 'cooldown',
        })).toMatchObject({
            tone: 'rejoining',
            label: 'Rejoining arena...',
            actionNeeded: false,
        });
    });

    it('emits friendly notices for joins, leaves, link transitions, and host changes once', () => {
        const previousLink: ArenaLinkState = {
            tone: 'forming',
            label: 'Squad link forming',
            detail: 'Syncing squad movement.',
            playerCount: 1,
            actionNeeded: false,
        };
        const nextLink: ArenaLinkState = {
            tone: 'live',
            label: '2 hunters linked',
            detail: 'Movement is live.',
            playerCount: 2,
            actionNeeded: false,
        };

        const notices = deriveArenaPresenceNotices({
            previousPlayers: [{ sessionId: 'alice', username: 'Alice' }],
            nextPlayers: [
                { sessionId: 'alice', username: 'Alice' },
                { sessionId: 'bob', username: 'Bob' },
            ],
            previousLink,
            nextLink,
            previousDirectorLabel: 'peer mode',
            nextDirectorLabel: 'you',
            nowEpochMs: 1_000,
        });

        expect(notices.map((notice) => notice.message)).toEqual([
            'Bob entered the arena',
            'Squad linked',
            'You run this arena',
        ]);

        expect(deriveArenaPresenceNotices({
            previousPlayers: [
                { sessionId: 'alice', username: 'Alice' },
                { sessionId: 'bob', username: 'Bob' },
            ],
            nextPlayers: [
                { sessionId: 'alice', username: 'Alice' },
                { sessionId: 'bob', username: 'Bob' },
            ],
            previousLink: nextLink,
            nextLink,
            previousDirectorLabel: 'you',
            nextDirectorLabel: 'you',
            nowEpochMs: 1_100,
        })).toEqual([]);

        expect(deriveArenaPresenceNotices({
            previousPlayers: [
                { sessionId: 'alice', username: 'Alice' },
                { sessionId: 'bob', username: 'Bob' },
            ],
            nextPlayers: [{ sessionId: 'alice', username: 'Alice' }],
            previousLink: nextLink,
            nextLink: previousLink,
            previousDirectorLabel: 'you',
            nextDirectorLabel: 'peer mode',
            nowEpochMs: 1_200,
        }).map((notice) => notice.message)).toEqual([
            'Bob lost signal',
            'Squad link forming',
            'Arena host is changing',
        ]);
    });
});
