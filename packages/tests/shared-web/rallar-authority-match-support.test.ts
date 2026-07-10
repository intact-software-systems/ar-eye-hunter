import { describe, expect, it, vi } from 'vitest';
import {
    createRallarAuthorityBrowserMatch,
    type RallarGameAuthorityClientConfig,
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
    it('delegates authority-client configuration, lifecycle, and commands', async () => {
        const client = fakeAuthorityClient();
        const config = authorityMatchConfig();
        let receivedConfig: RallarGameAuthorityClientConfig<
            Command,
            Snapshot,
            Event,
            Presence
        > | undefined;
        const match = createRallarAuthorityBrowserMatch<
            Command,
            Snapshot,
            Event,
            Presence
        >(config, {
            createAuthorityClient: (factoryConfig) => {
                receivedConfig = factoryConfig;
                return client;
            },
        });

        expect(receivedConfig).toBe(config);
        await expect(match.start()).resolves.toMatchObject({ phase: 'ready' });
        match.stop();
        expect(match.status()).toMatchObject({ phase: 'ready' });
        expect(match.diagnostics()).toBeUndefined();
        expect(client.start).toHaveBeenCalledOnce();
        expect(client.stop).toHaveBeenCalledOnce();
        expect(client.status).toHaveBeenCalledOnce();
        expect(client.diagnostics).toHaveBeenCalledOnce();

        await expect(match.submitCommand({ kind: 'claim', id: 'relic-1' }, {
            key: 'command-1',
        }))
            .resolves.toEqual({ status: 'sent', transport: 'ws', seq: 1 });
        expect(client.sendCommand).toHaveBeenCalledWith(
            { kind: 'claim', id: 'relic-1' },
            { key: 'command-1' },
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
            ...authorityMatchConfig(),
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

function authorityMatchConfig(): RallarGameAuthorityClientConfig<
    Command,
    Snapshot,
    Event,
    Presence
> {
    return {
        rallar: {} as never,
        protocol: 'example.authority.v1',
        topicId: 'room.example.authority',
        authority,
    };
}

function fakeAuthorityClient(): RallarGameAuthorityClientHandle<
    Command,
    Snapshot,
    Event,
    Presence
> {
    return {
        start: vi.fn(async () => ({
            phase: 'ready' as const,
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
            phase: 'ready' as const,
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
            status: 'sent' as const,
            transport: 'ws' as const,
            seq: 1,
        })),
        requestSync: vi.fn(),
        publishPresence: vi.fn(),
        publishSnapshotRepair: vi.fn(),
        onStatus: vi.fn(() => () => undefined),
    };
}
