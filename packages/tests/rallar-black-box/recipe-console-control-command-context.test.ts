import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    controlCommandActiveRunLabel,
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

    it('labels only nonterminal active-run context, never a selected terminal run', () => {
        expect(controlCommandActiveRunLabel({
            kind: 'sole',
            runs: [activeRun('run-active', 'running')],
        }, 'live')).toBe('run-active · running');
        expect(controlCommandActiveRunLabel({
            kind: 'ambiguous',
            runs: [
                activeRun('run-a', 'draft'),
                activeRun('run-b', 'running'),
            ],
        }, 'live')).toBe('2 active');
        expect(controlCommandActiveRunLabel({ kind: 'none', runs: [] }, 'partial'))
            .toBe('Unknown');
        expect(controlCommandActiveRunLabel({ kind: 'none', runs: [] }, 'live'))
            .toBe('None');
    });
});
