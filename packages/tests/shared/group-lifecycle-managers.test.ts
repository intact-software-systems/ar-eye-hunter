import { describe, expect, it } from 'vitest';

import type { GroupManagerPolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { resolveGroupLifecycleManagers, type ResolveGroupLifecycleManagersInput } from '@shared/api/group-lifecycle/resolve-group-lifecycle-managers.ts';
import { rendezvousScore } from '@shared/rtc/rendezvous-score.ts';

const GROUP_KEY = 'app-1:workspace-1:room-1';

function managerPolicy(overrides: Partial<GroupManagerPolicy> = {}): GroupManagerPolicy {
    return {
        selection: 'none',
        assignedPrincipalIds: [],
        count: 1,
        succession: 'none',
        ...overrides
    };
}

function resolutionInput(overrides: Partial<ResolveGroupLifecycleManagersInput> = {}): ResolveGroupLifecycleManagersInput {
    return {
        manager: managerPolicy(),
        ownerPrincipalId: 'owner',
        formationElectorate: [],
        formationEpoch: 1,
        groupKey: GROUP_KEY,
        activePrincipalIds: new Set(['owner']),
        rankByPrincipalId: null,
        ...overrides
    };
}

// The expected election order, derived through the same primitive the
// resolution uses: descending epoch-keyed score, principal id as tie-break.
function expectedElectionOrder(electorate: readonly string[], epoch: number): string[] {
    return [...electorate].sort((left, right) => {
        const leftScore = rendezvousScore(`epoch:${epoch}`, left, GROUP_KEY);
        const rightScore = rendezvousScore(`epoch:${epoch}`, right, GROUP_KEY);
        if (leftScore !== rightScore) {
            return leftScore < rightScore ? 1 : -1;
        }
        return left < right ? -1 : 1;
    });
}

describe('group lifecycle manager resolution', () => {
    it('resolves nobody under selection none', () => {
        expect(resolveGroupLifecycleManagers(resolutionInput())).toEqual([]);
    });

    it('resolves the creator while active and leaves a hole without succession', () => {
        const input = resolutionInput({ manager: managerPolicy({ selection: 'creator' }) });
        expect(resolveGroupLifecycleManagers(input)).toEqual(['owner']);
        expect(resolveGroupLifecycleManagers({ ...input, activePrincipalIds: new Set(['bob']) })).toEqual([]);
    });

    it('continues the creator into the election ranking under next-by-selection', () => {
        const electorate = ['owner', 'bob', 'carol', 'dave'];
        const managers = resolveGroupLifecycleManagers(
            resolutionInput({
                manager: managerPolicy({ selection: 'creator', succession: 'next-by-selection' }),
                formationElectorate: electorate,
                activePrincipalIds: new Set(['bob', 'carol', 'dave'])
            })
        );
        const successor = expectedElectionOrder(electorate, 1).filter((principalId) => principalId !== 'owner')[0];
        expect(managers).toEqual([successor]);
    });

    it('keeps assigned order and lets succession decide whether holes fill', () => {
        const manager = managerPolicy({ selection: 'assigned', assignedPrincipalIds: ['a', 'b', 'c'] });
        const active = new Set(['b', 'c']);
        expect(resolveGroupLifecycleManagers(resolutionInput({ manager: { ...manager, count: 2 }, activePrincipalIds: active }))).toEqual([
            'b'
        ]);
        expect(
            resolveGroupLifecycleManagers(
                resolutionInput({
                    manager: { ...manager, count: 2, succession: 'next-by-selection' },
                    activePrincipalIds: active
                })
            )
        ).toEqual(['b', 'c']);
    });

    it('elects deterministically from the pinned electorate only', () => {
        const electorate = ['p1', 'p2', 'p3', 'p4'];
        const input = resolutionInput({
            manager: managerPolicy({
                selection: 'elected-random-deterministic',
                count: 2,
                succession: 'next-by-selection'
            }),
            formationElectorate: electorate,
            // p5 is active but joined after the epoch boundary: never electable.
            activePrincipalIds: new Set(['p1', 'p2', 'p3', 'p4', 'p5'])
        });
        const expected = expectedElectionOrder(electorate, 1).slice(0, 2);
        expect(resolveGroupLifecycleManagers(input)).toEqual(expected);
        expect(resolveGroupLifecycleManagers(input)).toEqual(expected);
        expect(expected).not.toContain('p5');
    });

    it('fills a departed elected manager under next-by-selection and not under none', () => {
        const electorate = ['p1', 'p2', 'p3', 'p4'];
        const ranked = expectedElectionOrder(electorate, 1);
        const departed = ranked[0];
        const remaining = new Set(electorate.filter((principalId) => principalId !== departed));
        const base = resolutionInput({
            formationElectorate: electorate,
            activePrincipalIds: remaining
        });
        expect(
            resolveGroupLifecycleManagers({
                ...base,
                manager: managerPolicy({
                    selection: 'elected-random-deterministic',
                    count: 2,
                    succession: 'next-by-selection'
                })
            })
        ).toEqual(ranked.filter((principalId) => principalId !== departed).slice(0, 2));
        expect(
            resolveGroupLifecycleManagers({
                ...base,
                manager: managerPolicy({ selection: 'elected-random-deterministic', count: 2 })
            })
        ).toEqual(ranked.slice(0, 2).filter((principalId) => principalId !== departed));
    });

    it('reorders across formation epochs while each epoch stays stable', () => {
        const electorate = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
        const input = resolutionInput({
            manager: managerPolicy({ selection: 'elected-random-deterministic', count: 6 }),
            formationElectorate: electorate,
            activePrincipalIds: new Set(electorate)
        });
        expect(resolveGroupLifecycleManagers(input)).toEqual(expectedElectionOrder(electorate, 1));
        expect(resolveGroupLifecycleManagers({ ...input, formationEpoch: 2 })).toEqual(expectedElectionOrder(electorate, 2));
    });

    it('ranks elected-by-rank by the supplied source and resolves nobody without one', () => {
        const electorate = ['a', 'b', 'c', 'd'];
        const input = resolutionInput({
            manager: managerPolicy({ selection: 'elected-by-rank', count: 3 }),
            formationElectorate: electorate,
            activePrincipalIds: new Set(electorate),
            rankByPrincipalId: new Map([
                ['a', 2],
                ['b', 1],
                ['c', 2]
                // d has no rank: excluded, not defaulted.
            ])
        });
        expect(resolveGroupLifecycleManagers(input)).toEqual(['b', 'a', 'c']);
        expect(resolveGroupLifecycleManagers({ ...input, rankByPrincipalId: null })).toEqual([]);
    });
});
