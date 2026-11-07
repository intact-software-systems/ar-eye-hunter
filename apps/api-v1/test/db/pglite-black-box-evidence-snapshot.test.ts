import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteBlackBoxSnapshotPublisher } from '../../src/db/pglite-black-box-evidence-snapshot.ts';

test('PGlite black-box snapshot publishing atomically publishes a fresh archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pglite-evidence-snapshot-'));
    let resolveDump: ((value: Blob) => void) | undefined;
    const dump = new Promise<Blob>((resolve) => {
        resolveDump = resolve;
    });
    const publisher = await createPGliteBlackBoxSnapshotPublisher({
        dumpDataDir: async () => await dump
    } as never, {
        directory: root
    });
    if (!publisher) {
        throw new Error('Expected private snapshot publisher.');
    }
    assert.equal((await stat(root)).mode! & 0o777, 0o700);
    const request = {
        nonce: 'freshsnapshot',
        generation: 'generationone',
        requestedAtEpochMs: Date.now()
    };
    const requestPath = join(root, 'requests', `${request.nonce}.json`);
    await writeFile(`${requestPath}.part`, JSON.stringify(request), { mode: 0o600 });
    await rename(`${requestPath}.part`, requestPath);
    assert.equal((await stat(requestPath)).mode! & 0o777, 0o600);

    const publishing = publisher.publishPendingSnapshots();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(() => stat(join(root, 'responses', `${request.nonce}.json`)));

    resolveDump?.(new Blob(['snapshot-body']));
    await publishing;
    const response = JSON.parse(
        await readFile(
            join(root, 'responses', `${request.nonce}.json`),
            'utf8'
        )
    );
    assert.equal(response.nonce, request.nonce);
    assert.equal(response.generation, request.generation);
    assert.ok(response.publishedAtEpochMs > request.requestedAtEpochMs);
    assert.equal(
        (await stat(join(root, 'responses', `${request.nonce}.json`))).mode! & 0o777,
        0o600
    );
    assert.equal(
        (await stat(join(root, 'snapshots', `${request.nonce}.tar`))).mode! & 0o777,
        0o600
    );
    assert.equal(
        await readFile(join(root, 'snapshots', `${request.nonce}.tar`), 'utf8'),
        'snapshot-body'
    );
    await assert.rejects(() => stat(requestPath));
    await rm(root, { recursive: true });
});

test('PGlite black-box snapshot publishing discards a dump when its request is cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pglite-evidence-snapshot-'));
    let resolveDump: ((value: Blob) => void) | undefined;
    const dump = new Promise<Blob>((resolve) => {
        resolveDump = resolve;
    });
    const publisher = await createPGliteBlackBoxSnapshotPublisher({
        dumpDataDir: async () => await dump
    } as never, {
        directory: root
    });
    if (!publisher) {
        throw new Error('Expected private snapshot publisher.');
    }
    const request = {
        nonce: 'cancelledsnapshot',
        generation: 'generationthree',
        requestedAtEpochMs: Date.now()
    };
    const requestPath = join(root, 'requests', `${request.nonce}.json`);
    await writeFile(requestPath, JSON.stringify(request));

    const publishing = publisher.publishPendingSnapshots();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await rm(requestPath);
    resolveDump?.(new Blob(['snapshot-body']));
    await publishing;

    await assert.rejects(() => stat(join(root, 'responses', `${request.nonce}.json`)));
    await assert.rejects(() => stat(join(root, 'snapshots', `${request.nonce}.tar`)));
    await rm(root, { recursive: true });
});

test('PGlite black-box snapshot publishing honours a cancellation marker before archive publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pglite-evidence-snapshot-'));
    let dumpCalls = 0;
    const publisher = await createPGliteBlackBoxSnapshotPublisher({
        dumpDataDir: () => {
            dumpCalls += 1;
            return Promise.resolve(new Blob(['snapshot-body']));
        }
    } as never, {
        directory: root
    });
    if (!publisher) {
        throw new Error('Expected private snapshot publisher.');
    }
    const request = {
        nonce: 'cancel-before-archive',
        generation: 'generation-four',
        requestedAtEpochMs: Date.now()
    };
    await writeFile(
        join(root, 'requests', `${request.nonce}.json`),
        JSON.stringify(request)
    );
    await writeFile(join(root, 'requests', `${request.nonce}.orphan.part`), 'orphan');
    await writeFile(join(root, 'responses', `${request.nonce}.orphan.part`), 'orphan');
    await writeFile(join(root, 'snapshots', `${request.nonce}.orphan.part`), 'orphan');
    await writeFile(join(root, 'cancellations', `${request.nonce}.json`), '{}');

    await publisher.publishPendingSnapshots();

    assert.equal(dumpCalls, 0);
    for (const directory of ['requests', 'responses', 'snapshots']) {
        assert.deepEqual(
            (await (await readdir(join(root, directory), { withFileTypes: true }))).map((entry) => entry.name),
            []
        );
    }
    await rm(root, { recursive: true });
});

test('PGlite black-box snapshot publishing removes artifacts when cancellation arrives after archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pglite-evidence-snapshot-'));
    const request = {
        nonce: 'cancel-after-archive',
        generation: 'generation-five',
        requestedAtEpochMs: Date.now()
    };
    const publisher = await createPGliteBlackBoxSnapshotPublisher({
        dumpDataDir: () => Promise.resolve(new Blob(['snapshot-body']))
    } as never, {
        directory: root,
        publicationHooks: {
            afterArchive: async () => {
                await writeFile(join(root, 'cancellations', `${request.nonce}.json`), '{}');
            }
        }
    });
    if (!publisher) {
        throw new Error('Expected private snapshot publisher.');
    }
    await writeFile(
        join(root, 'requests', `${request.nonce}.json`),
        JSON.stringify(request)
    );
    await writeFile(join(root, 'requests', `${request.nonce}.orphan.part`), 'orphan');
    await writeFile(join(root, 'responses', `${request.nonce}.orphan.part`), 'orphan');
    await writeFile(join(root, 'snapshots', `${request.nonce}.orphan.part`), 'orphan');

    await publisher.publishPendingSnapshots();

    for (const directory of ['requests', 'responses', 'snapshots']) {
        assert.deepEqual(
            (await (await readdir(join(root, directory), { withFileTypes: true }))).map((entry) => entry.name),
            []
        );
    }
    await rm(root, { recursive: true });
});

test('PGlite black-box snapshot publishing removes artifacts when cancellation arrives after response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pglite-evidence-snapshot-'));
    const request = {
        nonce: 'cancel-after-response',
        generation: 'generation-seven',
        requestedAtEpochMs: Date.now()
    };
    const publisher = await createPGliteBlackBoxSnapshotPublisher({
        dumpDataDir: () => Promise.resolve(new Blob(['snapshot-body']))
    } as never, {
        directory: root,
        publicationHooks: {
            afterResponse: async () => {
                await writeFile(join(root, 'cancellations', `${request.nonce}.json`), '{}');
            }
        }
    });
    if (!publisher) {
        throw new Error('Expected private snapshot publisher.');
    }
    await writeFile(
        join(root, 'requests', `${request.nonce}.json`),
        JSON.stringify(request)
    );

    await publisher.publishPendingSnapshots();

    for (const directory of ['requests', 'responses', 'snapshots']) {
        assert.deepEqual(
            (await (await readdir(join(root, directory), { withFileTypes: true }))).map((entry) => entry.name),
            []
        );
    }
    await rm(root, { recursive: true });
});

test('PGlite black-box snapshot publishing records dump failures without publishing an archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pglite-evidence-snapshot-'));
    const publisher = await createPGliteBlackBoxSnapshotPublisher({
        dumpDataDir: () => Promise.reject(new Error('dump failed'))
    } as never, {
        directory: root
    });
    if (!publisher) {
        throw new Error('Expected private snapshot publisher.');
    }
    const request = {
        nonce: 'failedsnapshot',
        generation: 'generationtwo',
        requestedAtEpochMs: Date.now()
    };
    await writeFile(
        join(root, 'requests', `${request.nonce}.json`),
        JSON.stringify(request)
    );

    await publisher.publishPendingSnapshots();
    const response = JSON.parse(
        await readFile(
            join(root, 'responses', `${request.nonce}.json`),
            'utf8'
        )
    );
    assert.match(response.failure, /dump failed/u);
    await assert.rejects(() => stat(join(root, 'snapshots', `${request.nonce}.tar`)));
    await rm(root, { recursive: true });
});

test('PGlite black-box snapshot publishing does not publish a failure response after cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pglite-evidence-snapshot-'));
    const request = {
        nonce: 'cancelled-failure',
        generation: 'generation-six',
        requestedAtEpochMs: Date.now()
    };
    const publisher = await createPGliteBlackBoxSnapshotPublisher({
        dumpDataDir: async () => {
            await writeFile(join(root, 'cancellations', `${request.nonce}.json`), '{}');
            throw new Error('dump failed after cancellation');
        }
    } as never, {
        directory: root
    });
    if (!publisher) {
        throw new Error('Expected private snapshot publisher.');
    }
    await writeFile(
        join(root, 'requests', `${request.nonce}.json`),
        JSON.stringify(request)
    );

    await publisher.publishPendingSnapshots();

    for (const directory of ['requests', 'responses', 'snapshots']) {
        assert.deepEqual(
            (await (await readdir(join(root, directory), { withFileTypes: true }))).map((entry) => entry.name),
            []
        );
    }
    await rm(root, { recursive: true });
});

for (
    const failure of [
        {
            name: 'archive write',
            hooks: {
                beforeArchiveWrite: async () => await Promise.reject(new Error('archive write failed'))
            },
            dumpDataDir: () => Promise.resolve(new Blob(['snapshot-body'])),
            leavesFailureResponse: true
        },
        {
            name: 'archive rename',
            hooks: {
                beforeArchiveRename: async () => await Promise.reject(new Error('archive rename failed'))
            },
            dumpDataDir: () => Promise.resolve(new Blob(['snapshot-body'])),
            leavesFailureResponse: true
        },
        {
            name: 'normal response write',
            hooks: {
                beforeResponseWrite: (response: { failure?: string; }) => {
                    if (!response.failure) {
                        return Promise.reject(new Error('normal response write failed'));
                    }
                    return Promise.resolve();
                }
            },
            dumpDataDir: () => Promise.resolve(new Blob(['snapshot-body'])),
            leavesFailureResponse: true
        },
        {
            name: 'normal response rename',
            hooks: {
                beforeResponseRename: (response: { failure?: string; }) => {
                    if (!response.failure) {
                        return Promise.reject(new Error('normal response rename failed'));
                    }
                    return Promise.resolve();
                }
            },
            dumpDataDir: () => Promise.resolve(new Blob(['snapshot-body'])),
            leavesFailureResponse: true
        },
        {
            name: 'failure response write',
            hooks: {
                beforeResponseWrite: (response: { failure?: string; }) => {
                    if (response.failure) {
                        return Promise.reject(new Error('failure response write failed'));
                    }
                    return Promise.resolve();
                }
            },
            dumpDataDir: async () => await Promise.reject(new Error('dump failed')),
            leavesFailureResponse: false
        },
        {
            name: 'failure response rename',
            hooks: {
                beforeResponseRename: (response: { failure?: string; }) => {
                    if (response.failure) {
                        return Promise.reject(new Error('failure response rename failed'));
                    }
                    return Promise.resolve();
                }
            },
            dumpDataDir: async () => await Promise.reject(new Error('dump failed')),
            leavesFailureResponse: false
        }
    ] as const
) {
    test(`PGlite black-box snapshot publishing cleans artifacts after ${failure.name} failure`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'pglite-evidence-snapshot-'));
        const request = {
            nonce: `failure-${failure.name.replaceAll(' ', '-')}`,
            generation: 'generation-eight',
            requestedAtEpochMs: Date.now()
        };
        const publisher = await createPGliteBlackBoxSnapshotPublisher(
            { dumpDataDir: failure.dumpDataDir } as never,
            {
                directory: root,
                publicationHooks: failure.hooks
            }
        );
        if (!publisher) {
            throw new Error('Expected private snapshot publisher.');
        }
        await writeFile(
            join(root, 'requests', `${request.nonce}.json`),
            JSON.stringify(request)
        );

        await publisher.publishPendingSnapshots();

        assert.deepEqual(
            (await (await readdir(join(root, 'requests'), { withFileTypes: true }))).map((entry) => entry.name),
            []
        );
        assert.deepEqual(
            (await (await readdir(join(root, 'snapshots'), { withFileTypes: true }))).map((entry) => entry.name),
            []
        );
        const responseNames = (await (await readdir(join(root, 'responses'), { withFileTypes: true }))).map(
            (entry) => entry.name
        );
        assert.equal(responseNames.some((name) => name.endsWith('.part')), false);
        assert.equal(responseNames.length === 1, failure.leavesFailureResponse);
        if (failure.leavesFailureResponse) {
            assert.match(
                await readFile(join(root, 'responses', `${request.nonce}.json`), 'utf8'),
                /failure/u
            );
        }
        await rm(root, { recursive: true });
    });
}
