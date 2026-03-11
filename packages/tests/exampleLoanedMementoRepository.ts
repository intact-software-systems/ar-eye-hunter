import { LoanedValue } from '../shared/cache/LoanedValue.ts';
import { LoanedMementoRepository } from '../shared/cache/LoanedMementoRepository.ts';
import { Command } from '../shared/cache/Command.ts';

type DocumentState = {
    documentId: string;
    content: string;
    version: number;
};

type UserProfile = {
    userId: string;
    name: string;
    revision: number;
};

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------
// Use-case 1: per-document async state with undo/redo
// -------------------------------------------------------

async function documentHistoryExample(): Promise<void> {
    console.log('\n--- documentHistoryExample ---');

    const docs = new LoanedMementoRepository<string, DocumentState>(
        async (documentId, current) => {
            await delay(50);
            return {
                documentId,
                content: current ? `${current.content}!` : 'Hello',
                version: (current?.version ?? 0) + 1,
            };
        },
        {
            ttlMs: 1_000,
            undoDepth: 10,
            redoDepth: 10,
        },
    );

    const first = await docs.get('doc-1');
    console.log('first', first);

    const second = await docs.refresh('doc-1');
    console.log('second', second);

    docs.commitValue('doc-1', {
        documentId: 'doc-1',
        content: 'Manual edit',
        version: 999,
    });

    console.log('after manual commit', docs.peek('doc-1'));
    console.log('undo stack', docs.undoStack('doc-1'));

    docs.undo('doc-1');
    console.log('after undo', docs.peek('doc-1'));

    docs.redo('doc-1');
    console.log('after redo', docs.peek('doc-1'));
}

// -------------------------------------------------------
// Use-case 2: current loan can be swapped per key
// -------------------------------------------------------

async function swapLoanPerKeyExample(): Promise<void> {
    console.log('\n--- swapLoanPerKeyExample ---');

    const repo = new LoanedMementoRepository<string, number>(
        async (_key, current) => (current ?? 0) + 1,
        {
            ttlMs: 10_000,
            undoDepth: 5,
            redoDepth: 5,
        },
    );

    console.log('initial get', await repo.get('counter')); // 1

    const fixedLoan = new LoanedValue<number>(async () => 100, { ttlMs: 60_000 });
    repo.commitLoan('counter', fixedLoan);

    console.log('after commitLoan', await repo.get('counter')); // 100
    console.log('undo stack', repo.undoStack('counter'));       // [1]

    repo.undo('counter');
    console.log('after undo', repo.peek('counter'));            // 1
}

// -------------------------------------------------------
// Use-case 3: command-backed per-key fetch logic
// LoanedMementoRepository remains unaware of Command
// -------------------------------------------------------

async function commandBackedPerKeyExample(): Promise<void> {
    console.log('\n--- commandBackedPerKeyExample ---');

    let shouldFail = false;

    const repo = new LoanedMementoRepository<string, UserProfile>(
        (userId, current) =>
            new Command<UserProfile>(
                async () => {
                    await delay(50);

                    if (shouldFail) {
                        throw new Error('simulated profile fetch failure');
                    }

                    return {
                        userId,
                        name: `User ${userId}`,
                        revision: (current?.revision ?? 0) + 1,
                    };
                },
                {
                    maxAttempts: 2,
                    fallback: async () => {
                        if (current) {
                            return current;
                        }
                        throw new Error(`No cached fallback for ${userId}`);
                    },
                },
            ).run(),
        {
            ttlMs: 10,
            undoDepth: 5,
            redoDepth: 5,
        },
    );

    const first = await repo.get('alice');
    console.log('first', first);

    await delay(20);
    const refreshed = await repo.refresh('alice');
    console.log('refreshed', refreshed);

    shouldFail = true;
    await delay(20);
    const fallback = await repo.refresh('alice');
    console.log('fallback', fallback);

    repo.commitValue('alice', {
        userId: 'alice',
        name: 'Manual Alice',
        revision: 999,
    });

    console.log('after manual commit', repo.peek('alice'));
    console.log('undo stack', repo.undoStack('alice'));

    repo.undo('alice');
    console.log('after undo', repo.peek('alice'));
}

// -------------------------------------------------------
// Use-case 4: many keys, each with independent history
// -------------------------------------------------------

async function independentHistoryPerKeyExample(): Promise<void> {
    console.log('\n--- independentHistoryPerKeyExample ---');

    const repo = new LoanedMementoRepository<string, number>(
        async (key, current) => (current ?? 0) + (key === 'a' ? 1 : 10),
        {
            ttlMs: 60_000,
            undoDepth: 3,
            redoDepth: 3,
        },
    );

    await repo.get('a');      // 1
    await repo.refresh('a');  // 2
    await repo.get('b');      // 10
    await repo.refresh('b');  // 20

    console.log('a current', repo.peek('a'));
    console.log('a undo', repo.undoStack('a'));

    console.log('b current', repo.peek('b'));
    console.log('b undo', repo.undoStack('b'));

    repo.undo('a');

    console.log('a after undo', repo.peek('a'));
    console.log('b unchanged', repo.peek('b'));
}

// -------------------------------------------------------
// Use-case 5: delete expired entries, skipping refreshing ones
// -------------------------------------------------------

async function deleteExpiredExample(): Promise<void> {
    console.log('\n--- deleteExpiredExample ---');

    const repo = new LoanedMementoRepository<string, number>(
        async (_key, current) => (current ?? 0) + 1,
        {
            ttlMs: 5,
            undoDepth: 3,
            redoDepth: 3,
        },
    );

    await repo.get('x');
    await repo.get('y');

    console.log('size before expiry', repo.size());

    await delay(20);

    console.log('x expired', repo.expired('x'));
    console.log('removed', repo.deleteExpired());
    console.log('size after cleanup', repo.size());
}

// -------------------------------------------------------
// Use-case 6: direct access to per-key holder
// -------------------------------------------------------

async function directHolderExample(): Promise<void> {
    console.log('\n--- directHolderExample ---');

    const repo = new LoanedMementoRepository<string, string>(
        async (_key, current) => (current ? `${current}!` : 'A'),
        {
            ttlMs: 60_000,
            undoDepth: 5,
            redoDepth: 5,
        },
    );

    const history = repo.loanedMemento('doc-1');

    await history.get();      // A
    await history.refresh();  // A!

    console.log('repo current', repo.peek('doc-1'));
    console.log('direct undo stack', history.undoStack());

    history.undo();
    console.log('repo after direct undo', repo.peek('doc-1'));
}

// -------------------------------------------------------
// Main
// -------------------------------------------------------

async function main(): Promise<void> {
    await documentHistoryExample();
    await swapLoanPerKeyExample();
    await commandBackedPerKeyExample();
    await independentHistoryPerKeyExample();
    await deleteExpiredExample();
    await directHolderExample();
}

void main();