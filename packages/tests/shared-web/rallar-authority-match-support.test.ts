import { describe, expect, it, vi } from 'vitest';
import {
    createRallarAuthorityBrowserMatch,
    type RallarGameAuthorityClientHandle,
} from '@shared-web/game/mod.ts';
import type { RallarGameAuthorityRef } from '@shared/rallar-game/mod.ts';

type Command = Readonly<{ kind: 'claim'; id: string }>;
type Snapshot = Readonly<{ tick: number }>;
type Event = Readonly<{ kind: 'claimed' }>;
type Presence = Readonly<{ ready: boolean }>;

const authority: RallarGameAuthorityRef = {
    kind: 'server',
    id: 'server-1',
    epoch: 3,
};

describe('Rallar authority browser match support', () => {
    it('delegates commands to Rallar Game Authority client', async () => {
        const client = fakeAuthorityClient();
        const match = createRallarAuthorityBrowserMatch<
            Command,
            Snapshot,
            Event,
            Presence
        >({
            rallar: {} as never,
            protocol: 'example.authority.v1',
            topicId: 'room.example.authority',
            matchId: 'match-1',
            authority,
        }, {
            createAuthorityClient: () => client,
        });

        await expect(match.submitCommand({ kind: 'claim', id: 'relic-1' }))
            .resolves.toEqual({ status: 'sent', transport: 'ws', seq: 1 });
        expect(client.sendCommand).toHaveBeenCalledWith(
            { kind: 'claim', id: 'relic-1' },
            undefined,
        );
    });

    it('derives standings from app-provided server-authority metrics', () => {
        const client = fakeAuthorityClient();
        const match = createRallarAuthorityBrowserMatch<
            Command,
            Snapshot,
            Event,
            Presence
        >({
            rallar: {} as never,
            protocol: 'example.authority.v1',
            topicId: 'room.example.authority',
            matchId: 'match-1',
            authority,
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            readStandingRows: () => [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    metrics: { points: 5 },
                },
            ],
        }, {
            createAuthorityClient: () => client,
        });

        expect(match.standings()).toMatchObject([
            { participantId: 'principal-a', rank: 1 },
        ]);
    });
});

function fakeAuthorityClient(): RallarGameAuthorityClientHandle<
    Command,
    Snapshot,
    Event,
    Presence
> {
    return {
        start: vi.fn(async () => ({
            phase: 'ready',
            protocol: 'example.authority.v1',
            topicId: 'room.example.authority',
            roomId: 'room-1',
            localPeerId: 'session-a',
            authority,
            started: true,
            stopped: false,
            pendingCommandCount: 0,
            peerAssist: {
                enabled: false,
                snapshotRepairEnabled: false,
                readyPeerIds: [],
            },
            updatedAtEpochMs: 1_000,
        })),
        stop: vi.fn(),
        status: vi.fn(() => ({
            phase: 'ready',
            protocol: 'example.authority.v1',
            topicId: 'room.example.authority',
            roomId: 'room-1',
            localPeerId: 'session-a',
            authority,
            started: true,
            stopped: false,
            pendingCommandCount: 0,
            peerAssist: {
                enabled: false,
                snapshotRepairEnabled: false,
                readyPeerIds: [],
            },
            updatedAtEpochMs: 1_000,
        })),
        diagnostics: vi.fn(),
        sendCommand: vi.fn(async () => ({
            status: 'sent',
            transport: 'ws',
            seq: 1,
        })),
        requestSync: vi.fn(),
        publishPresence: vi.fn(),
        publishSnapshotRepair: vi.fn(),
        onStatus: vi.fn(() => () => undefined),
    };
}
