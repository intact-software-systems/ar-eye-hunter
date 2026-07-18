import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    controlCommandActiveRunLabel,
    controlCommandSafeTargetLabel,
    controlCommandStatus,
} from '../../../apps/rallar-black-box/src/recipe-console/control/ControlCommandContext.tsx';
import type { ControlQuerySnapshot } from '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';

function query(
    patch: Partial<ControlQuerySnapshot<ControlServerSnapshot>>,
): ControlQuerySnapshot<ControlServerSnapshot> {
    return {
        status: 'offline',
        reachability: 'unknown',
        authorization: 'unknown',
        isRefreshing: false,
        ...patch,
    };
}

function activeRun(
    distributedRunId: string,
    state: ControlDistributedRunSnapshot['state'],
): ControlDistributedRunSnapshot {
    return { distributedRunId, state } as ControlDistributedRunSnapshot;
}

describe('Recipe Console control command context truth', () => {
    it('uses one Execute-owned recipe-aware safe-target label when supplied', () => {
        expect(controlCommandSafeTargetLabel({
            queryStatus: 'live',
            safeTargetableCount: 5,
            lastKnownTargetableCount: 5,
            override: '2 selected · 2 recipe-safe',
        })).toBe('2 selected · 2 recipe-safe');
        expect(controlCommandSafeTargetLabel({
            queryStatus: 'stale',
            safeTargetableCount: 5,
            lastKnownTargetableCount: 4,
        })).toBe('0 current · 4 last known');
    });

    it('keeps reachability visible alongside offline and authorization state', () => {
        expect(controlCommandStatus(query({
            status: 'offline',
            reachability: 'unreachable',
        }))).toEqual({
            status: 'failed',
            label: 'Offline · unreachable',
        });
        expect(controlCommandStatus(query({
            status: 'offline',
            reachability: 'reachable',
        }))).toEqual({
            status: 'warning',
            label: 'Control error · reachable',
        });
        expect(controlCommandStatus(query({
            status: 'offline',
            reachability: 'reachable',
            authorization: 'required',
        }))).toEqual({
            status: 'warning',
            label: 'Authorization required · reachable',
        });
        expect(controlCommandStatus(query({
            status: 'stale',
            reachability: 'unreachable',
            authorization: 'required',
        }))).toEqual({
            status: 'warning',
            label: 'Authorization required · unreachable · stale',
        });
    });

    it('shows the configured timeout duration instead of a generic offline label', () => {
        expect(controlCommandStatus(query({
            status: 'offline',
            reachability: 'unreachable',
            lastError: {
                kind: 'timeout',
                message: 'Control request timed out after 20000 ms.',
            },
        }))).toEqual({
            status: 'failed',
            label: 'Timed out after 20 s · unreachable',
        });
        expect(controlCommandStatus(query({
            status: 'stale',
            reachability: 'unreachable',
            snapshot: { runs: [], distributedRuns: [] },
            lastError: {
                kind: 'timeout',
                message: 'Control request timed out after 1250 ms.',
            },
        }))).toEqual({
            status: 'stale',
            label: 'Timed out after 1.25 s · last known',
        });
    });

    it('labels only nonterminal active-run context, never a selected terminal run', () => {
        expect(controlCommandActiveRunLabel({
            kind: 'sole',
            runs: [activeRun('run-active', 'running')],
        }, 'live', true)).toBe('run-active · running');
        expect(controlCommandActiveRunLabel({
            kind: 'ambiguous',
            runs: [
                activeRun('run-a', 'draft'),
                activeRun('run-b', 'running'),
            ],
        }, 'live', true)).toBe('2 active');
        expect(controlCommandActiveRunLabel({ kind: 'none', runs: [] }, 'partial', false))
            .toBe('Unknown');
        expect(controlCommandActiveRunLabel({ kind: 'none', runs: [] }, 'live', true, true))
            .toBe('None');
    });

    it('does not turn an unresolved control-run context into an authoritative zero', () => {
        expect(controlCommandActiveRunLabel(
            { kind: 'none', runs: [] },
            'live',
            true,
            false,
        )).toBe('Unknown');
    });

    it('qualifies unavailable and stale distributed-run evidence', () => {
        const active = {
            kind: 'sole' as const,
            runs: [activeRun('run-active', 'running')],
        };
        expect(controlCommandActiveRunLabel(active, 'connecting', false))
            .toBe('Unknown');
        expect(controlCommandActiveRunLabel(active, 'offline', false))
            .toBe('Unknown');
        expect(controlCommandActiveRunLabel(active, 'stale', false))
            .toBe('Unknown');
        expect(controlCommandActiveRunLabel(active, 'stale', true))
            .toBe('run-active · running · last known');
        expect(controlCommandActiveRunLabel({ kind: 'none', runs: [] }, 'stale', true))
            .toBe('None · last known');
    });
});
