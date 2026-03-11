import { LoanedValue } from '@shared/cache/LoanedValue.ts';
import { LoanedMementoValue } from '@shared/cache/LoanedMementoValue.ts';
import { Command } from '@shared/cache/Command.ts';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------
// Use-case 1: Start with fixed values, then undo/redo
// -------------------------------------------------------

async function fixedValueHistoryExample(): Promise<void> {
    console.log('\n--- fixedValueHistoryExample ---');

    const history = LoanedMementoValue.fromValue('A', {
        undoDepth: 5,
        redoDepth: 5,
    });

    history.commitValue('B');
    history.commitValue('C');

    console.log('current peek', history.peek());               // C
    console.log('undo stack', history.undoStack());            // [B, A]
    console.log('redo stack', history.redoStack());            // []
    console.log('peek undo', history.peekUndoValue());         // B
    console.log('peek undo at 1', history.peekUndoValueAt(1)); // A

    history.undo();

    console.log('after undo current', history.peek());         // B
    console.log('after undo redo stack', history.redoStack()); // [C]
    console.log('peek redo', history.peekRedoValue());         // C

    history.redo();

    console.log('after redo current', history.peek());         // C
}

// -------------------------------------------------------
// Use-case 2: Current is a dynamic LoanedValue
// Undo history stores only already-materialized raw values
// -------------------------------------------------------

async function dynamicCurrentLoanExample(): Promise<void> {
    console.log('\n--- dynamicCurrentLoanExample ---');

    let counter = 0;

    const liveLoan = new LoanedValue<number>(
        async () => {
            await delay(50);
            counter += 1;
            return counter;
        },
        { ttlMs: 1_000 },
    );

    const history = new LoanedMementoValue<number>(liveLoan, {
        undoDepth: 5,
        redoDepth: 5,
    });

    console.log('peek before materialization', history.peek()); // undefined

    const first = await history.get();
    console.log('first get', first); // 1
    console.log('peek after materialization', history.peek()); // 1

    history.commitValue(100);

    console.log('current after commitValue', history.peek()); // 100
    console.log('undo stack', history.undoStack());           // [1]

    history.undo();

    console.log('after undo current', history.peek());        // 1
    console.log('redo stack', history.redoStack());           // [100]
}

// -------------------------------------------------------
// Use-case 3: Switch between different LoanedValue sources
// Previous current raw value is captured into undo if available
// -------------------------------------------------------

async function switchLoanSourcesExample(): Promise<void> {
    console.log('\n--- switchLoanSourcesExample ---');

    const localLoan = new LoanedValue<string>(
        async () => 'local-value',
        { ttlMs: 60_000 },
    );

    const remoteLoan = new LoanedValue<string>(
        async () => {
            await delay(50);
            return 'remote-value';
        },
        { ttlMs: 60_000 },
    );

    const history = new LoanedMementoValue<string>(localLoan, {
        undoDepth: 5,
        redoDepth: 5,
    });

    await history.get();
    console.log('current from local', history.peek()); // local-value

    history.commitLoan(remoteLoan);
    console.log('after commitLoan current peek', history.peek()); // undefined
    console.log('undo stack', history.undoStack());               // [local-value]

    const remoteValue = await history.get();
    console.log('materialized remote', remoteValue);              // remote-value

    history.undo();
    console.log('after undo current', history.peek());           // local-value
    console.log('redo stack', history.redoStack());              // [remote-value]
}

// -------------------------------------------------------
// Use-case 4: setRefresher / commitRefresher
// -------------------------------------------------------

async function refresherHistoryExample(): Promise<void> {
    console.log('\n--- refresherHistoryExample ---');

    const history = LoanedMementoValue.empty<number>({
        undoDepth: 5,
        redoDepth: 5,
    });

    history.commitRefresher(async () => 10);
    console.log('current after first refresher before get', history.peek()); // undefined

    console.log('current after first get', await history.get()); // 10

    history.commitRefresher(async () => 20);
    console.log('undo stack after swapping refresher', history.undoStack()); // [10]

    console.log('current after second get', await history.get()); // 20

    history.undo();
    console.log('after undo current', history.peek()); // 10
}

// -------------------------------------------------------
// Use-case 5: Current loan uses Command externally
// LoanedMementoValue does not know about Command
// -------------------------------------------------------

async function commandBackedLoanExample(): Promise<void> {
    console.log('\n--- commandBackedLoanExample ---');

    let shouldFail = false;

    const currentLoan = new LoanedValue<string>(
        (current) =>
            new Command<string>(
                async () => {
                    await delay(50);

                    if (shouldFail) {
                        throw new Error('simulated failure');
                    }

                    return current ? `${current}-fresh` : 'initial';
                },
                {
                    maxAttempts: 2,
                    fallback: async () => current ?? 'fallback',
                },
            ).run(),
        { ttlMs: 10 },
    );

    const history = new LoanedMementoValue<string>(currentLoan, {
        undoDepth: 5,
        redoDepth: 5,
    });

    const first = await history.get();
    console.log('first', first); // initial

    await delay(20);
    const refreshed = await history.refresh();
    console.log('refreshed', refreshed); // initial-fresh

    shouldFail = true;
    await delay(20);
    const fallback = await history.refresh();
    console.log('fallback', fallback); // current-based fallback

    history.commitValue('manual-value');
    console.log('after manual commit', history.peek()); // manual-value
    console.log('undo stack', history.undoStack());     // contains previously materialized value(s)

    history.undo();
    console.log('after undo', history.peek());
}

// -------------------------------------------------------
// Use-case 6: compareAndSetLoan and getAndSetLoan
// -------------------------------------------------------

async function compareAndSetLoanExample(): Promise<void> {
    console.log('\n--- compareAndSetLoanExample ---');

    const loanA = new LoanedValue(async () => 'A');
    const loanB = new LoanedValue(async () => 'B');
    const loanC = new LoanedValue(async () => 'C');

    const history = new LoanedMementoValue<string>(loanA, {
        undoDepth: 5,
        redoDepth: 5,
    });

    await history.get(); // materialize A

    const didSwap = history.compareAndSetLoan(loanA, loanB);
    console.log('compareAndSetLoan success', didSwap);  // true
    console.log('undo stack', history.undoStack());     // [A]

    const previous = history.getAndSetLoan(loanC);
    console.log('previous loan existed', previous === loanB); // true
    console.log('undo stack', history.undoStack());           // likely [B, A] if B was materialized, otherwise [A]

    console.log('current get', await history.get());          // C
}

// -------------------------------------------------------
// Use-case 7: snapshot current as fixed loan
// This freezes current materialized value into a static loan
// -------------------------------------------------------

async function snapshotCurrentAsFixedLoanExample(): Promise<void> {
    console.log('\n--- snapshotCurrentAsFixedLoanExample ---');

    let seed = 0;

    const liveLoan = new LoanedValue<number>(
        async () => {
            seed += 1;
            return seed;
        },
        { ttlMs: 0 },
    );

    const history = new LoanedMementoValue<number>(liveLoan, {
        undoDepth: 5,
        redoDepth: 5,
    });

    console.log('first get', await history.get()); // 1
    console.log('refresh', await history.refresh()); // 2

    history.snapshotCurrentAsFixedLoan();

    console.log('peek after snapshot', history.peek()); // 2

    const afterFreezeRefresh = await history.refresh();
    console.log('after refresh on fixed loan', afterFreezeRefresh); // still 2
}

// -------------------------------------------------------
// Use-case 8: no implicit fetch during history capture
// If current has not materialized, swapping loans does not create undo history
// -------------------------------------------------------

async function noImplicitFetchDuringHistoryCaptureExample(): Promise<void> {
    console.log('\n--- noImplicitFetchDuringHistoryCaptureExample ---');

    const neverReadLoan = new LoanedValue<string>(
        async () => 'never-materialized',
        { ttlMs: 60_000 },
    );

    const replacementLoan = new LoanedValue<string>(
        async () => 'replacement',
        { ttlMs: 60_000 },
    );

    const history = new LoanedMementoValue<string>(neverReadLoan, {
        undoDepth: 5,
        redoDepth: 5,
    });

    console.log('before swap current peek', history.peek()); // undefined

    history.commitLoan(replacementLoan);

    console.log('undo stack after swap', history.undoStack()); // []
    console.log('current after materializing replacement', await history.get()); // replacement
}

// -------------------------------------------------------
// Main
// -------------------------------------------------------

async function main(): Promise<void> {
    await fixedValueHistoryExample();
    await dynamicCurrentLoanExample();
    await switchLoanSourcesExample();
    await refresherHistoryExample();
    await commandBackedLoanExample();
    await compareAndSetLoanExample();
    await snapshotCurrentAsFixedLoanExample();
    await noImplicitFetchDuringHistoryCaptureExample();
}

void main();