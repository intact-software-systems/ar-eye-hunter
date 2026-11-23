import { describe, expect, it } from 'vitest';

import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { computeCommandResultWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';

// A harness poll margin unlike any command budget, so each expectation shows which term it adds.
const POLL_MARGIN_MS = 7_000;

const roomConnect: RallarBlackBoxTestRtcConnectCommand = {
    kind: 'rtc.connect',
    roomId: 'room',
    timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS,
    readiness: { minReadyPeers: 1, timeoutMs: 30_000, intervalMs: 100 }
};

describe('computeCommandResultWaitMs', () => {
    // The wait the round-3 connects outgrew: a 135 s connect whose readiness runs after it under its own 30 s.
    it('covers a room-joining connect, then its readiness, then the poll margin', () => {
        expect(RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS).toBe(135_000);
        expect(computeCommandResultWaitMs(roomConnect, POLL_MARGIN_MS)).toBe(135_000 + 30_000 + 7_000);
    });

    it('covers a connect that waits for no readiness by its own timeout and the poll margin', () => {
        const { readiness: _readiness, ...presence } = roomConnect;
        expect(computeCommandResultWaitMs(presence, POLL_MARGIN_MS)).toBe(135_000 + 7_000);
    });

    // A recipe root names no timeout of its own, so its commands' budgets end to end bound it.
    it('covers a recipe run by every command of its recipe, one after another', () => {
        const waitMs = computeCommandResultWaitMs({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'connect-then-send',
                commands: [roomConnect, { kind: 'rtc.send', timeoutMs: 60_000 }]
            }
        }, POLL_MARGIN_MS);

        expect(waitMs).toBe(135_000 + 30_000 + 60_000 + 7_000);
    });

    it('covers a recipe run that names its own timeout by that timeout', () => {
        const waitMs = computeCommandResultWaitMs({
            kind: 'recipe.run',
            timeoutMs: 20_000,
            recipe: { schemaVersion: 1, recipeId: 'bounded', commands: [roomConnect] }
        }, POLL_MARGIN_MS);

        expect(waitMs).toBe(20_000 + 7_000);
    });

    // Health, stats, close and reset name no timeout: the harness's own poll is all it waits.
    it('waits the poll margin alone for a command that names no timeout', () => {
        expect(computeCommandResultWaitMs({ kind: 'health' }, POLL_MARGIN_MS)).toBe(7_000);
    });
});
