// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import {
    ArenaRuntimeTestHarness,
    arenaSnapshot,
    freshDirectorStatus,
    mockRallar,
    waitForState
} from './arena-runtime-test-harness.ts';

import { createRallarGameEnvelope } from '@shared-web/game/mod.ts';

import { useArenaPresentation } from '../../../apps/ar-eye-hunter-v1/src/arena-ui/arena-presentation.tsx';
import type { ArenaSnapshot } from '../../../apps/ar-eye-hunter-v1/src/game/arena-contracts.ts';
import { createArenaRallarGameMatch } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';

const arena = new ArenaRuntimeTestHarness();
beforeEach(() => arena.reset());
afterEach(() => arena.dispose());

describe('accepted arena state and local prediction', () => {
    it('does not replace a director match with a higher-revision peer prediction', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const accepted = activeSnapshot(10, 50_000);
        await receiveSnapshot(accepted);
        await act(async () => arena.current?.publishArenaSnapshot(arenaSnapshot(100)));
        expect(arena.current?.arenaSnapshot?.match?.matchId).toBe('match-1');
        expect(arena.current?.arenaSnapshot?.revision).toBe(10);
    });

    it('does not promote speculation while a previously local director is stale', async () => {
        mockRallar.director.status.mockReturnValue({ ...freshDirectorStatus(), isFresh: false });
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const accepted = activeSnapshot(10, 50_000);
        await receiveSnapshot(accepted);
        await act(async () => arena.current?.publishArenaSnapshot(arenaSnapshot(100)));
        expect(arena.current?.arenaSnapshot?.match?.matchId).toBe('match-1');
    });

    it('renders a newly started minute from the current clock after an idle lobby', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const element = document.createElement('div');
        const root = createRoot(element);
        let now = 1_000;
        let snapshot: ArenaSnapshot | undefined;
        function PresentationProbe() {
            if (!arena.current) {
                throw new Error('The arena must be connected before presentation mounts.');
            }
            const presentation = useArenaPresentation({ ...arena.current, arenaSnapshot: snapshot }, () => now);
            return createElement('output', null, String(presentation.matchRemainingMs));
        }
        try {
            await act(async () => root.render(createElement(PresentationProbe)));
            now = 2_161_000;
            snapshot = activeSnapshot(10, now);
            await act(async () => root.render(createElement(PresentationProbe)));
            expect(element.textContent).toBe('60000');
        }
        finally {
            await act(async () => root.unmount());
        }
    });
});

async function receiveSnapshot(snapshot: ArenaSnapshot): Promise<void> {
    const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
    if (!config?.onSnapshot) {
        throw new Error('Connected game must register snapshot reception.');
    }
    await act(async () =>
        config.onSnapshot?.(createRallarGameEnvelope({
            protocol: 'ar-eye-hunter.v1',
            kind: 'snapshot',
            roomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'players', groupId: 'arena-1' },
            senderId: 'director',
            senderGenerationId: 'generation-' + ('director'),
            seq: 1,
            directorEpoch: 1,
            sentAtEpochMs: snapshot.sentAtEpochMs,
            payload: snapshot
        }))
    );
}

function activeSnapshot(revision: number, now: number): ArenaSnapshot {
    return {
        ...arenaSnapshot(revision),
        sentAtEpochMs: now,
        match: {
            matchId: 'match-1',
            status: 'active',
            enrollment: 'open',
            durationMs: 60_000,
            directorSessionId: 'director',
            startedAtEpochMs: now,
            endsAtEpochMs: now + 60_000,
            baseline: {}
        }
    };
}
