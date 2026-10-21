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
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 4, keyedChainsFirst: false });
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
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 2, keyedChainsFirst: false });
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
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: false });
        const runs = createGatedRuns();
        const failure = new Error('handler failed');

        const failed = admission.admit('group', runs.run('failed'));
        const failedRejection = expect(failed).rejects.toBe(failure);
        const next = admission.admit('group', runs.run('next'));
        await vi.waitFor(() => expect(runs.started).toEqual(['failed']));
        runs.fail('failed', failure);
        await vi.waitFor(() => expect(runs.started).toEqual(['failed', 'next']));
        runs.finish('next');

        await failedRejection;
        await expect(next).resolves.toBe('next');
    });

    it('admits runs without an earlier overlapping run in arrival order, keyed or not', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: false });
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

    it('gives a freed slot to a keyed run its predecessor released ahead of waiting runs, and a fresh keyed run waits in turn', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 2, keyedChainsFirst: true });
        const runs = createGatedRuns();

        const results = [
            admission.admit('group', runs.run('group-1')),
            admission.admit(undefined, runs.run('free-1')),
            admission.admit(undefined, runs.run('free-2')),
            admission.admit('group', runs.run('group-2')),
            admission.admit('other', runs.run('other-1')),
            admission.admit(undefined, runs.run('free-3'))
        ];
        await vi.waitFor(() => expect(runs.started).toEqual(['group-1', 'free-1']));
        // A keyed run that waited on no predecessor asks for its slot in turn, behind the earlier keyless run.
        runs.finish('free-1');
        await vi.waitFor(() => expect(runs.started).toEqual(['group-1', 'free-1', 'free-2']));
        // A keyed run released by its predecessor's settlement goes ahead of every earlier waiting run.
        runs.finish('group-1');
        await vi.waitFor(() => expect(runs.started).toEqual(['group-1', 'free-1', 'free-2', 'group-2']));
        runs.finish('free-2');
        await vi.waitFor(() => expect(runs.started.at(-1)).toBe('other-1'));
        runs.finish('other-1');
        await vi.waitFor(() => expect(runs.started.at(-1)).toBe('free-3'));
        runs.finish('group-2');
        runs.finish('free-3');

        expect(await Promise.all(results)).toEqual(['group-1', 'free-1', 'free-2', 'group-2', 'other-1', 'free-3']);
    });

    it('gives the next freed slot to a fresh keyed run waiting in turn once a same-key run waits behind it', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: true });
        const runs = createGatedRuns();

        const results = [
            admission.admit(undefined, runs.run('busy')),
            admission.admit(undefined, runs.run('ws-1')),
            admission.admit(undefined, runs.run('ws-2')),
            admission.admit('scope:g:aggregate', runs.run('join-1'))
        ];
        await vi.waitFor(() => expect(runs.started).toEqual(['busy']));
        // The join is now a chain head: the run behind it holds the chain's next turn.
        results.push(admission.admit('scope:g:aggregate', runs.run('join-2')));
        for (const name of ['busy', 'join-1', 'join-2', 'ws-1', 'ws-2']) {
            await vi.waitFor(() => expect(runs.started.at(-1)).toBe(name));
            runs.finish(name);
        }

        await Promise.all(results);
        expect(runs.started).toEqual(['busy', 'join-1', 'join-2', 'ws-1', 'ws-2']);
    });

    it('keeps a lone fresh keyed run in turn behind the earlier keyless runs', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: true });
        const runs = createGatedRuns();

        const results = [
            admission.admit(undefined, runs.run('busy')),
            admission.admit(undefined, runs.run('ws-1')),
            admission.admit('scope:g:aggregate', runs.run('join')),
            admission.admit('scope:h:aggregate', runs.run('other-join'))
        ];
        for (const name of ['busy', 'ws-1', 'join', 'other-join']) {
            await vi.waitFor(() => expect(runs.started.at(-1)).toBe(name));
            runs.finish(name);
        }

        await Promise.all(results);
        expect(runs.started).toEqual(['busy', 'ws-1', 'join', 'other-join']);
    });

    it('gives a run that a prefix-keyed settlement released the next slot when a same-key run waits behind it', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: true });
        const runs = createGatedRuns();

        const results = [
            admission.admit('scope', runs.run('cleanup')),
            admission.admit(undefined, runs.run('ws-ticket')),
            admission.admit('scope:g:aggregate', runs.run('join-1')),
            admission.admit('scope:g:aggregate', runs.run('join-2'))
        ];
        for (const name of ['cleanup', 'join-1', 'join-2', 'ws-ticket']) {
            await vi.waitFor(() => expect(runs.started.at(-1)).toBe(name));
            runs.finish(name);
        }

        await Promise.all(results);
        expect(runs.started).toEqual(['cleanup', 'join-1', 'join-2', 'ws-ticket']);
    });

    it('keeps a chain head in turn when keyed runs do not go first', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: false });
        const runs = createGatedRuns();

        const results = [
            admission.admit(undefined, runs.run('busy')),
            admission.admit(undefined, runs.run('ws-1')),
            admission.admit('scope:g:aggregate', runs.run('join-1')),
            admission.admit('scope:g:aggregate', runs.run('join-2'))
        ];
        for (const name of ['busy', 'ws-1', 'join-1', 'join-2']) {
            await vi.waitFor(() => expect(runs.started.at(-1)).toBe(name));
            runs.finish(name);
        }

        await Promise.all(results);
        expect(runs.started).toEqual(['busy', 'ws-1', 'join-1', 'join-2']);
    });

    it('runs a keyless run before the fresh distinct-key runs that arrive after it when keyed runs go first', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: true });
        const runs = createGatedRuns();
        const sessionNames = Array.from({ length: 10 }, (_, index) => `presence-${index}`);

        const results = [
            admission.admit('group:session=a', runs.run('presence-a')),
            admission.admit(undefined, runs.run('ws-ticket')),
            ...sessionNames.map((name) => admission.admit(`group:session=${name}`, runs.run(name)))
        ];
        for (const name of ['presence-a', 'ws-ticket', ...sessionNames]) {
            await vi.waitFor(() => expect(runs.started.at(-1)).toBe(name));
            runs.finish(name);
        }

        await Promise.all(results);
        expect(runs.started).toEqual(['presence-a', 'ws-ticket', ...sessionNames]);
    });

    it('lets a keyless run go before the runs a prefix-keyed run released when it settled', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: true });
        const runs = createGatedRuns();
        const joinNames = Array.from({ length: 6 }, (_, index) => `join-${index}`);

        const results = [
            admission.admit('scope', runs.run('cleanup')),
            admission.admit(undefined, runs.run('ws-ticket')),
            ...joinNames.map((name, index) => admission.admit(`scope:g${index}:aggregate`, runs.run(name)))
        ];
        for (const name of ['cleanup', 'ws-ticket', ...joinNames]) {
            await vi.waitFor(() => expect(runs.started.at(-1)).toBe(name));
            runs.finish(name);
        }

        await Promise.all(results);
        // A scope-wide settlement releases every run inside the scope; none of them is that run's chain successor.
        expect(runs.started).toEqual(['cleanup', 'ws-ticket', ...joinNames]);
    });

    it('runs a keyless run during a storm of scope cleanups and in-scope connects', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 2, keyedChainsFirst: true });
        const runs = createGatedRuns();

        const results = [admission.admit(undefined, runs.run('busy')), admission.admit('scope', runs.run('cleanup-0'))];
        await vi.waitFor(() => expect(runs.started).toEqual(['busy', 'cleanup-0']));
        results.push(admission.admit(undefined, runs.run('ws-ticket')));
        for (let round = 1; round <= 3; round += 1) {
            results.push(admission.admit(`scope:g:session=${round}`, runs.run(`connect-${round}`)));
            results.push(admission.admit('scope', runs.run(`cleanup-${round}`)));
        }
        runs.finish('cleanup-0');

        await vi.waitFor(() => expect(runs.started).toEqual(['busy', 'cleanup-0', 'ws-ticket']));
        for (const name of ['busy', 'ws-ticket', 'connect-1', 'cleanup-1', 'connect-2', 'cleanup-2', 'connect-3', 'cleanup-3']) {
            await vi.waitFor(() => expect(runs.started).toContain(name));
            runs.finish(name);
        }
        await Promise.all(results);
    });

    it('keeps arrival order across keyed and keyless runs when keyed runs do not go first', async () => {
        const admission = new ExclusionKeyedAdmission({ maxConcurrent: 1, keyedChainsFirst: false });
        const runs = createGatedRuns();

        const results = [
            admission.admit(undefined, runs.run('holder')),
            admission.admit(undefined, runs.run('free')),
            admission.admit('group', runs.run('keyed'))
        ];
        for (const name of ['holder', 'free', 'keyed']) {
            await vi.waitFor(() => expect(runs.started.at(-1)).toBe(name));
            runs.finish(name);
        }

        expect(await Promise.all(results)).toEqual(['holder', 'free', 'keyed']);
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
