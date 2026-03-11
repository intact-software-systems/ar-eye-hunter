import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';
import { latestMementoRepositoryToken, loanedMementoRepositoryToken, } from '@shared/cache/RepositoryTokens.ts';
import { LatestMementoRepository } from '@shared/cache/LatestMementoRepository.ts';

// -------------------------------------------------------
// Domain types
// -------------------------------------------------------

type EditorState = {
    documentId: string;
    content: string;
    version: number;
};

type UserProfile = {
    userId: string;
    name: string;
    revision: number;
};

// -------------------------------------------------------
// Tokens
// -------------------------------------------------------

const latestDocumentsToken =
    latestMementoRepositoryToken<string, EditorState>(
        'latest-documents',
        {
            undoDepth: 20,
            redoDepth: 20,
            ttlMs: 60_000,
        },
    );

const loanedProfilesToken =
    loanedMementoRepositoryToken<string, UserProfile>(
        'loaned-profiles',
        async (userId, current) => ({
            userId,
            name: `User ${userId}`,
            revision: (current?.revision ?? 0) + 1,
        }),
        {
            undoDepth: 10,
            redoDepth: 10,
            ttlMs: 5_000,
        },
    );

// Example disposable repository so replace/delete/clear can demonstrate disposal.
class DisposableLatestDocsRepository
    extends LatestMementoRepository<string, EditorState> {
    public dispose(): void {
        console.log('DisposableLatestDocsRepository.dispose()');
    }
}

const disposableLatestDocsToken = new RepositoryToken(
    'disposable-latest-docs',
    () =>
        new DisposableLatestDocsRepository({
            undoDepth: 5,
            redoDepth: 5,
            ttlMs: 60_000,
        }),
);

// -------------------------------------------------------
// Examples
// -------------------------------------------------------

async function resolveExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- resolveExample ---');

    const latestDocuments = manager.resolve(latestDocumentsToken);
    latestDocuments.accept('doc-1', {
        documentId: 'doc-1',
        content: 'Hello',
        version: 1,
    });

    latestDocuments.accept('doc-1', {
        documentId: 'doc-1',
        content: 'Hello world',
        version: 2,
    });

    console.log('current doc-1', latestDocuments.get('doc-1'));
    console.log('undo stack doc-1', latestDocuments.undoStack('doc-1'));

    const sameLatestDocuments = manager.resolve(latestDocumentsToken);
    console.log('same instance', sameLatestDocuments === latestDocuments);
}

async function requireExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- requireExample ---');

    const latestDocuments = manager.require(latestDocumentsToken);
    console.log('required repo exists', latestDocuments !== undefined);

    try {
        const missingToken = new RepositoryToken('missing-repo', () => ({ ok: true }));
        manager.require(missingToken);
    } catch (error) {
        console.log('require missing throws', error instanceof Error ? error.message : error);
    }
}

async function loanedRepositoryExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- loanedRepositoryExample ---');

    const loanedProfiles = manager.resolve(loanedProfilesToken);

    const first = await loanedProfiles.get('alice');
    const second = await loanedProfiles.refresh('alice');

    console.log('first alice', first);
    console.log('second alice', second);
    console.log('undo stack alice', loanedProfiles.undoStack('alice'));
}

async function registerExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- registerExample ---');

    const token = new RepositoryToken(
        'manually-registered-latest',
        () => new LatestMementoRepository<string, EditorState>(),
    );

    const repo = new LatestMementoRepository<string, EditorState>({
        undoDepth: 3,
        redoDepth: 3,
    });

    manager.register(token, repo);

    const required = manager.require(token);
    console.log('registered instance reused', required === repo);

    try {
        manager.register(token, repo);
    } catch (error) {
        console.log('register duplicate throws', error instanceof Error ? error.message : error);
    }
}

async function setExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- setExample ---');

    const token = new RepositoryToken(
        'set-example',
        () => new LatestMementoRepository<string, number>(),
    );

    const first = new LatestMementoRepository<string, number>({
        undoDepth: 2,
        redoDepth: 2,
    });

    first.accept('a', 1);
    manager.set(token, first);

    const second = new LatestMementoRepository<string, number>({
        undoDepth: 2,
        redoDepth: 2,
    });

    second.accept('a', 99);
    manager.set(token, second);

    console.log('set overwrote instance', manager.require(token) === second);
    console.log('current value', manager.require(token).get('a'));
}

async function replaceExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- replaceExample ---');

    const first = manager.resolve(disposableLatestDocsToken);
    first.accept('doc-1', {
        documentId: 'doc-1',
        content: 'Old',
        version: 1,
    });

    const replacement = new DisposableLatestDocsRepository({
        undoDepth: 5,
        redoDepth: 5,
        ttlMs: 60_000,
    });

    replacement.accept('doc-1', {
        documentId: 'doc-1',
        content: 'Replacement',
        version: 2,
    });

    await manager.replace(disposableLatestDocsToken, replacement);

    const current = manager.require(disposableLatestDocsToken);
    console.log('replacement installed', current === replacement);
    console.log('replacement value', current.get('doc-1'));
}

async function deleteExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- deleteExample ---');

    manager.resolve(disposableLatestDocsToken);

    const deleted = await manager.delete(disposableLatestDocsToken);
    console.log('deleted', deleted);
    console.log('still present', manager.has(disposableLatestDocsToken));
}

async function clearExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- clearExample ---');

    manager.resolve(latestDocumentsToken);
    manager.resolve(loanedProfilesToken);
    manager.resolve(disposableLatestDocsToken);

    console.log('size before clear', manager.size());
    console.log('ids before clear', manager.ids());

    await manager.clear();

    console.log('size after clear', manager.size());
    console.log('ids after clear', manager.ids());
}

async function hasGetSizeIdsExample(manager: RepositoryManager): Promise<void> {
    console.log('\n--- hasGetSizeIdsExample ---');

    console.log('has latestDocuments before resolve', manager.has(latestDocumentsToken));

    const latestDocuments = manager.resolve(latestDocumentsToken);
    latestDocuments.accept('doc-2', {
        documentId: 'doc-2',
        content: 'Doc 2',
        version: 1,
    });

    const optional = manager.get(latestDocumentsToken);

    console.log('has latestDocuments after resolve', manager.has(latestDocumentsToken));
    console.log('get returns instance', optional === latestDocuments);
    console.log('size', manager.size());
    console.log('ids', manager.ids());
}

// -------------------------------------------------------
// Main
// -------------------------------------------------------

async function main(): Promise<void> {
    {
        const manager = new RepositoryManager();
        await resolveExample(manager);
        await requireExample(manager);
    }

    {
        const manager = new RepositoryManager();
        await loanedRepositoryExample(manager);
    }

    {
        const manager = new RepositoryManager();
        await registerExample(manager);
    }

    {
        const manager = new RepositoryManager();
        await setExample(manager);
    }

    {
        const manager = new RepositoryManager();
        await replaceExample(manager);
    }

    {
        const manager = new RepositoryManager();
        await deleteExample(manager);
    }

    {
        const manager = new RepositoryManager();
        await hasGetSizeIdsExample(manager);
    }

    {
        const manager = new RepositoryManager();
        await clearExample(manager);
    }
}

void main();