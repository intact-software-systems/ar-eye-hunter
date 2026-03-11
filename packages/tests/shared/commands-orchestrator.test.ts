import { describe, expect, it } from 'vitest';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';
import { LoanedRepository } from '@shared/cache/LoanedRepository.ts';
import { LoanedValue } from '@shared/cache/LoanedValue.ts';

describe('CommandsOrchestrator', () => {
    it('runs sequential phases in order and invokes then callbacks after each phase', async () => {
        const phaseSnapshots: Array<Array<[string, number]>> = [];

        const results = await CommandsOrchestrator.withPolicies<string, number>()
            .sequential(
                async () => ['a', 1],
                async (existing) => ['b', (existing.get('a') ?? 0) + 1],
            )
            .then((existing) => {
                phaseSnapshots.push(Array.from(existing.entries()));
            })
            .sequential(async (existing) => ['c', (existing.get('b') ?? 0) + 1])
            .then((existing) => {
                phaseSnapshots.push(Array.from(existing.entries()));
            })
            .run();

        expect(Array.from(results.entries())).toEqual([
            ['a', 1],
            ['b', 2],
            ['c', 3],
        ]);
        expect(phaseSnapshots).toEqual([
            [
                ['a', 1],
                ['b', 2],
            ],
            [
                ['a', 1],
                ['b', 2],
                ['c', 3],
            ],
        ]);
    });

    it('uses a snapshot for parallel phases so sibling steps do not see each other\'s writes', async () => {
        const results = await CommandsOrchestrator.withPolicies<string, number>()
            .sequential(async () => ['seed', 10])
            .parallel(
                async (existing) => ['left', (existing.get('seed') ?? 0) + 1],
                async (existing) => ['right', existing.has('left') ? 99 : 20],
            )
            .run();

        expect(Array.from(results.entries())).toEqual([
            ['seed', 10],
            ['left', 11],
            ['right', 20],
        ]);
    });

    it('applies command policies and supports loaned-value and repository step helpers', async () => {
        let attempts = 0;
        const loanedValue = new LoanedValue(async () => 7);
        const repository = new LoanedRepository<string, number>(async () => 8);
        const orchestrator = CommandsOrchestrator.withPolicies<string, number>({
            command: {
                maxAttempts: 2,
                fallback: async () => 100,
            },
        });

        const results = await orchestrator
            .sequential(
                orchestrator.commandStep('command', async () => {
                    attempts += 1;
                    if (attempts < 2) {
                        throw new Error('retry');
                    }
                    return 5;
                }),
                orchestrator.commandStep(
                    'fallback',
                    async () => {
                        throw new Error('always-fail');
                    },
                    {
                        fallback: async () => 200,
                    },
                ),
                orchestrator.loanedValueGetStep('loan', loanedValue),
                orchestrator.repositoryGetStep('repo', repository),
            )
            .run();

        expect(attempts).toBe(2);
        expect(Array.from(results.entries())).toEqual([
            ['command', 5],
            ['fallback', 200],
            ['loan', 7],
            ['repo', 8],
        ]);
    });
});
