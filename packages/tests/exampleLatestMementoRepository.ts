import { LatestMementoRepository } from '../shared/cache/LatestMementoRepository.ts';

type EditorState = {
    documentId: string;
    content: string;
    version: number;
};

type Presence = {
    userId: string;
    online: boolean;
    lastSeenAt: number;
};

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------
// Use-case 1: per-document editor history
// -------------------------------------------------------

function editorHistoryPerDocumentExample(): void {
    console.log('\n--- editorHistoryPerDocumentExample ---');

    const docs = new LatestMementoRepository<string, EditorState>({
        ttlMs: 60_000,
        undoDepth: 10,
        redoDepth: 10,
    });

    docs.accept('doc-1', {
        documentId: 'doc-1',
        content: 'A',
        version: 1,
    });

    docs.accept('doc-1', {
        documentId: 'doc-1',
        content: 'AB',
        version: 2,
    });

    docs.accept('doc-1', {
        documentId: 'doc-1',
        content: 'ABC',
        version: 3,
    });

    console.log('current', docs.get('doc-1'));
    console.log('undo stack', docs.undoStack('doc-1'));
    console.log('peek undo', docs.peekUndoValue('doc-1'));

    docs.undo('doc-1');
    console.log('after undo', docs.get('doc-1'));

    docs.redo('doc-1');
    console.log('after redo', docs.get('doc-1'));
}

// -------------------------------------------------------
// Use-case 2: callback wiring per key
// -------------------------------------------------------

function callbackPerKeyExample(): void {
    console.log('\n--- callbackPerKeyExample ---');

    const presenceByUser = new LatestMementoRepository<string, Presence>({
        ttlMs: 30_000,
        undoDepth: 5,
        redoDepth: 5,
    });

    const onAlicePresence = presenceByUser.asCallback('alice');

    onAlicePresence({
        userId: 'alice',
        online: true,
        lastSeenAt: Date.now(),
    });

    onAlicePresence({
        userId: 'alice',
        online: false,
        lastSeenAt: Date.now(),
    });

    console.log('alice current', presenceByUser.get('alice'));
    console.log('alice undo stack', presenceByUser.undoStack('alice'));

    presenceByUser.undo('alice');
    console.log('alice after undo', presenceByUser.get('alice'));
}

// -------------------------------------------------------
// Use-case 3: many keys, each with independent history
// -------------------------------------------------------

function independentHistoryPerKeyExample(): void {
    console.log('\n--- independentHistoryPerKeyExample ---');

    const repo = new LatestMementoRepository<string, number>({
        ttlMs: 60_000,
        undoDepth: 3,
        redoDepth: 3,
    });

    repo.accept('a', 1);
    repo.accept('a', 2);
    repo.accept('b', 10);
    repo.accept('b', 20);

    console.log('a current', repo.get('a'));
    console.log('a undo', repo.undoStack('a'));

    console.log('b current', repo.get('b'));
    console.log('b undo', repo.undoStack('b'));

    repo.undo('a');

    console.log('a after undo', repo.get('a'));
    console.log('b still unchanged', repo.get('b'));
}

// -------------------------------------------------------
// Use-case 4: updateIfPresent and touch
// -------------------------------------------------------

function updateAndTouchExample(): void {
    console.log('\n--- updateAndTouchExample ---');

    const repo = new LatestMementoRepository<string, Presence>({
        ttlMs: 10_000,
        undoDepth: 5,
        redoDepth: 5,
    });

    repo.accept('alice', {
        userId: 'alice',
        online: true,
        lastSeenAt: Date.now(),
    });

    const updated = repo.updateIfPresent('alice', (current) => ({
        ...current,
        online: false,
        lastSeenAt: Date.now(),
    }));

    const touched = repo.touch('alice');

    console.log('updated', updated);
    console.log('touched', touched);
    console.log('alice current', repo.get('alice'));
    console.log('alice undo stack', repo.undoStack('alice'));
}

// -------------------------------------------------------
// Use-case 5: cleanup expired keys
// -------------------------------------------------------

async function deleteExpiredExample(): Promise<void> {
    console.log('\n--- deleteExpiredExample ---');

    const repo = new LatestMementoRepository<string, number>({
        ttlMs: 5,
        undoDepth: 3,
        redoDepth: 3,
    });

    repo.accept('x', 1);
    repo.accept('y', 2);

    console.log('size before expiry', repo.size());

    await delay(20);

    console.log('x expired', repo.expired('x'));
    console.log('removed', repo.deleteExpired());
    console.log('size after cleanup', repo.size());
}

// -------------------------------------------------------
// Use-case 6: access per-key holder directly
// -------------------------------------------------------

function directHolderExample(): void {
    console.log('\n--- directHolderExample ---');

    const repo = new LatestMementoRepository<string, string>({
        undoDepth: 5,
        redoDepth: 5,
    });

    const history = repo.latestMemento('doc-1');
    history.accept('one');
    history.accept('two');
    history.accept('three');

    console.log('repo current', repo.get('doc-1'));
    console.log('direct undo stack', history.undoStack());

    history.undo();
    console.log('repo after direct undo', repo.get('doc-1'));
}

// -------------------------------------------------------
// Main
// -------------------------------------------------------

async function main(): Promise<void> {
    editorHistoryPerDocumentExample();
    callbackPerKeyExample();
    independentHistoryPerKeyExample();
    updateAndTouchExample();
    await deleteExpiredExample();
    directHolderExample();
}

void main();