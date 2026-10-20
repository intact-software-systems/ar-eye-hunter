import { describe, expect, it, vi } from 'vitest';

import { ExclusionKeyedAdmission } from '@shared/resilience/exclusion-keyed-admission.ts';

interface GatedRuns {
    readonly started: string[];
    readonly run: (name: string) => () => Promise<string>;
    readonly finish: (name: string) => void;
    readonly fail: (name: string, error: Error) => void;
}

describe('exclusion keyed admission', () => {
    it('runs a keyed run after every earlier run whose key equals, prefixes or extends its own', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 4 });
        const runs = createGatedRuns();

        const scoped = admission.admit('app:group', runs.run('scoped'));
        const workspace = admission.admit('app', runs.run('workspace'));
        const caller = admission.admit('app:group:caller', runs.run('caller'));
        const sibling = admission.admit('app:groupie', runs.run('sibling'));
        const other = admission.admit('other', runs.run('other'));

        await vi.waitFor(() => expect(runs.started).toEqual(['scoped', 'other']));
        runs.finish('scoped');
        await vi.waitFor(() => expect(runs.started).toContain('workspace'));
        expect(runs.started).not.toContain('caller');
        expect(runs.started).not.toContain('sibling');
        runs.finish('workspace');
        await vi.waitFor(() => expect(runs.started.slice(3).sort()).toEqual(['caller', 'sibling']));
        runs.finish('caller');
        runs.finish('sibling');
        runs.finish('other');

        expect(await Promise.all([scoped, workspace, caller, sibling, other]))
            .toEqual(['scoped', 'workspace', 'caller', 'sibling', 'other']);
    });

    it('holds at most the bound in flight and gives a waiting keyed run no slot', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 2 });
        const runs = createGatedRuns();

        const first = admission.admit('group', runs.run('first'));
        const chained = admission.admit('group', runs.run('chained'));
        const free = admission.admit(undefined, runs.run('free'));
        const queued = admission.admit(undefined, runs.run('queued'));

        await vi.waitFor(() => expect(runs.started).toEqual(['first', 'free']));
        runs.finish('free');
        await vi.waitFor(() => expect(runs.started).toEqual(['first', 'free', 'queued']));
        runs.finish('first');
        await vi.waitFor(() => expect(runs.started).toEqual(['first', 'free', 'queued', 'chained']));
        runs.finish('queued');
        runs.finish('chained');

        expect(await Promise.all([first, chained, free, queued])).toEqual(['first', 'chained', 'free', 'queued']);
    });

    it('releases the runs ordered behind a failed run and rejects only the failed one', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1 });
        const runs = createGatedRuns();
        const failure = new Error('handler failed');

        const failed = admission.admit('group', runs.run('failed'));
        const next = admission.admit('group', runs.run('next'));
        await vi.waitFor(() => expect(runs.started).toEqual(['failed']));
        runs.fail('failed', failure);
        await vi.waitFor(() => expect(runs.started).toEqual(['failed', 'next']));
        runs.finish('next');

        await expect(failed).rejects.toBe(failure);
        await expect(next).resolves.toBe('next');
    });

    it('admits runs without an earlier overlapping run in arrival order, keyed or not', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1 });
        const runs = createGatedRuns();

        const results = [
            admission.admit('group-a', runs.run('first')),
            admission.admit(undefined, runs.run('second')),
            admission.admit('group-b', runs.run('third'))
        ];
        for (const name of ['first', 'second', 'third']) {
            await vi.waitFor(() => expect(runs.started.at(-1)).toBe(name));
            runs.finish(name);
        }

        expect(await Promise.all(results)).toEqual(['first', 'second', 'third']);
        expect(runs.started).toEqual(['first', 'second', 'third']);
    });
});

function createGatedRuns(): GatedRuns {
    const started: string[] = [];
    const gates = new Map<string, PromiseWithResolvers<string>>();
    return {
        started,
        run: (name) => () => {
            started.push(name);
            const gate = Promise.withResolvers<string>();
            gates.set(name, gate);
            return gate.promise;
        },
        finish: (name) => gates.get(name)!.resolve(name),
        fail: (name, error) => gates.get(name)!.reject(error)
    };
}
