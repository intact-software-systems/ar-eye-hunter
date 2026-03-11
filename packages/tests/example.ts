import { Command } from '../shared/cache/Command.ts';
import { LoanedValue } from '../shared/cache/LoanedValue.ts';
import { LoanedRepository } from '../shared/cache/LoanedRepository.ts';
import { CommandsOrchestrator } from '../shared/cache/CommandsOrchestrator.ts';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------
// Use-case 1: Plain LoanedValue with TTL
// -------------------------------------------------------

type Config = {
    apiBaseUrl: string;
    loadedAt: number;
};

async function loanedValueBasicExample(): Promise<void> {
    const config = new LoanedValue<Config>(
        async () => ({
            apiBaseUrl: 'https://example.test',
            loadedAt: Date.now(),
        }),
        { ttlMs: 2_000 },
    );

    const first = await config.get();
    const second = await config.get();

    console.log('loanedValueBasicExample:first', first);
    console.log('loanedValueBasicExample:second', second);
    console.log('loanedValueBasicExample:read', config.read());
    console.log('loanedValueBasicExample:peek', config.peek());

    await delay(2_100);

    console.log('loanedValueBasicExample:expired', config.expired());
    console.log('loanedValueBasicExample:refreshing', config.refreshing());

    const refreshed = await config.get();
    console.log('loanedValueBasicExample:refreshed', refreshed);
}

// -------------------------------------------------------
// Use-case 2: LoanedValue with Command fallback/retry
// -------------------------------------------------------

type Profile = {
    id: string;
    name: string;
    updatedAt: number;
};

async function loanedValueWithCommandExample(): Promise<void> {
    let shouldFail = false;

    const profile = new LoanedValue<Profile>(
        (current) =>
            new Command<Profile>(
                async () => {
                    await delay(50);

                    if (shouldFail) {
                        throw new Error('Simulated profile fetch failure');
                    }

                    return {
                        id: 'profile-1',
                        name: 'Knut',
                        updatedAt: Date.now(),
                    };
                },
                {
                    maxAttempts: 2,
                    timeoutMs: 1_000,
                    fallback: async () => {
                        if (current) {
                            return current;
                        }
                        throw new Error('No cached fallback available');
                    },
                    hooks: {
                        onAttemptError: (error, attempt) => {
                            console.warn('loanedValueWithCommandExample:attemptError', {
                                attempt,
                                error,
                            });
                        },
                    },
                },
            ).run(),
        { ttlMs: 1_000 },
    );

    const first = await profile.get();
    console.log('loanedValueWithCommandExample:first', first);

    shouldFail = true;
    await delay(1_100);

    const fallbackValue = await profile.get();
    console.log('loanedValueWithCommandExample:fallbackValue', fallbackValue);
}

// -------------------------------------------------------
// Use-case 3: LoanedValue.refreshWith / getWith
// -------------------------------------------------------

type CounterState = {
    count: number;
    updatedAt: number;
};

async function loanedValueWithCurrentExample(): Promise<void> {
    const counter = new LoanedValue<CounterState>(
        async () => ({
            count: 0,
            updatedAt: Date.now(),
        }),
        { ttlMs: 5_000 },
    );

    const start = await counter.get();
    console.log('loanedValueWithCurrentExample:start', start);

    const incremented = await counter.refreshWith(async (current) => ({
        count: (current?.count ?? 0) + 1,
        updatedAt: Date.now(),
    }));

    console.log('loanedValueWithCurrentExample:incremented', incremented);

    const reused = await counter.getWith(async (current) => ({
        count: (current?.count ?? 0) + 100,
        updatedAt: Date.now(),
    }));

    console.log('loanedValueWithCurrentExample:reusedStillValid', reused);
}

// -------------------------------------------------------
// Use-case 4: CachedRepository by key
// -------------------------------------------------------

type User = {
    id: string;
    name: string;
    version: number;
};

async function cachedRepositoryExample(): Promise<void> {
    const users = new LoanedRepository<string, User>(
        async (userId, current) => {
            await delay(50);

            return {
                id: userId,
                name: `User ${userId}`,
                version: (current?.version ?? 0) + 1,
            };
        },
        {
            ttlMs: 2_000,
            isValid: (user) => user.version > 0,
        },
    );

    const user42a = await users.get('42');
    const user42b = await users.get('42');
    const user99 = await users.get('99');

    console.log('cachedRepositoryExample:user42a', user42a);
    console.log('cachedRepositoryExample:user42b', user42b);
    console.log('cachedRepositoryExample:user99', user99);
    console.log('cachedRepositoryExample:read42', users.read('42'));
    console.log('cachedRepositoryExample:peek42', users.peek('42'));
    console.log('cachedRepositoryExample:has42', users.has('42'));
    console.log('cachedRepositoryExample:hasValue42', users.hasValue('42'));
    console.log('cachedRepositoryExample:refreshing42', users.refreshing('42'));
    console.log('cachedRepositoryExample:size', users.size());

    await delay(2_100);

    console.log('cachedRepositoryExample:expired42', users.expired('42'));

    const removed = users.deleteExpired();
    console.log('cachedRepositoryExample:removedExpired', removed);
    console.log('cachedRepositoryExample:has42AfterDeleteExpired', users.has('42'));
    console.log('cachedRepositoryExample:sizeAfterDeleteExpired', users.size());
}

// -------------------------------------------------------
// Use-case 5: CachedRepository with Command per key
// -------------------------------------------------------

async function cachedRepositoryWithCommandExample(): Promise<void> {
    const users = new LoanedRepository<string, User>(
        (userId, current) =>
            new Command<User>(
                async () => {
                    await delay(50);

                    return {
                        id: userId,
                        name: `Command User ${userId}`,
                        version: (current?.version ?? 0) + 1,
                    };
                },
                {
                    maxAttempts: 2,
                    timeoutMs: 1_000,
                    fallback: async () => {
                        if (current) {
                            return current;
                        }
                        throw new Error(`No cached fallback for user ${userId}`);
                    },
                },
            ).run(),
        { ttlMs: 2_000 },
    );

    const a = await users.get('7');
    const b = await users.refresh('7');

    console.log('cachedRepositoryWithCommandExample:first', a);
    console.log('cachedRepositoryWithCommandExample:refreshed', b);
}

// -------------------------------------------------------
// Use-case 6: CommandsOrchestrator with mixed sources
// -------------------------------------------------------

type OrchestratedValue =
    | { type: 'token'; token: string }
    | { type: 'profile'; id: string; name: string }
    | { type: 'timestamp'; value: number }
    | { type: 'user'; id: string; name: string; version: number };

async function commandsOrchestratorMixedExample(): Promise<void> {
    const tokenLoan = new LoanedValue<OrchestratedValue>(
        async () => ({
            type: 'token',
            token: crypto.randomUUID(),
        }),
        { ttlMs: 10_000 },
    );

    const users = new LoanedRepository<string, OrchestratedValue>(
        async (userId) => ({
            type: 'user',
            id: userId,
            name: `User ${userId}`,
            version: 1,
        }),
        { ttlMs: 10_000 },
    );

    const orchestrator =
        CommandsOrchestrator.withPolicies<string, OrchestratedValue>({
            command: {
                maxAttempts: 2,
                timeoutMs: 1_000,
            },
        });

    const results = await orchestrator
        .sequential(
            orchestrator.loanedValueGetStep('token', tokenLoan),
            orchestrator.commandStep('profile', async () => ({
                type: 'profile',
                id: 'profile-1',
                name: 'Knut',
            })),
        )
        .then((allResults) => {
            console.log(
                'commandsOrchestratorMixedExample:afterSequential',
                Array.from(allResults.entries()),
            );
        })
        .parallel(
            orchestrator.supplierStep('timestamp', async () => ({
                type: 'timestamp',
                value: Date.now(),
            })),
            orchestrator.repositoryGetStep('42', users),
        )
        .then((allResults) => {
            console.log(
                'commandsOrchestratorMixedExample:afterParallel',
                Array.from(allResults.entries()),
            );
        })
        .run();

    console.log(
        'commandsOrchestratorMixedExample:finalResults',
        Array.from(results.entries()),
    );
}

// -------------------------------------------------------
// Use-case 7: CommandsOrchestrator dynamic dependency
// -------------------------------------------------------

type DependentValue =
    | { type: 'userId'; id: string }
    | { type: 'user'; id: string; name: string };

async function commandsOrchestratorDynamicExample(): Promise<void> {
    const orchestrator =
        CommandsOrchestrator.withPolicies<string, DependentValue>();

    const results = await orchestrator
        .sequential(
            orchestrator.supplierStep('userId', async () => ({
                type: 'userId',
                id: '42',
            })),
            orchestrator.dynamicStep(async (allResults) => {
                const userIdValue = allResults.get('userId');
                if (!userIdValue || userIdValue.type !== 'userId') {
                    throw new Error('userId missing');
                }

                return [
                    'user',
                    {
                        type: 'user',
                        id: userIdValue.id,
                        name: `User ${userIdValue.id}`,
                    },
                ] as const;
            }),
        )
        .run();

    console.log(
        'commandsOrchestratorDynamicExample:results',
        Array.from(results.entries()),
    );
}

// -------------------------------------------------------
// Main
// -------------------------------------------------------

async function main(): Promise<void> {
    console.log('----- Use-case 1: LoanedValue basic -----');
    await loanedValueBasicExample();

    console.log('----- Use-case 2: LoanedValue with Command -----');
    await loanedValueWithCommandExample();

    console.log('----- Use-case 3: LoanedValue with current -----');
    await loanedValueWithCurrentExample();

    console.log('----- Use-case 4: CachedRepository -----');
    await cachedRepositoryExample();

    console.log('----- Use-case 5: CachedRepository with Command -----');
    await cachedRepositoryWithCommandExample();

    console.log('----- Use-case 6: CommandsOrchestrator mixed -----');
    await commandsOrchestratorMixedExample();

    console.log('----- Use-case 7: CommandsOrchestrator dynamic -----');
    await commandsOrchestratorDynamicExample();
}

void main();