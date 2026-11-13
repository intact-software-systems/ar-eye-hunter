import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createManagedPGliteRunStorage,
    withManagedPGliteRunStorage
} from '../../../../packages/shared-test/black-box-runner/managed-api/api-v1-managed-process-lifecycle.mts';

test('managed PGlite private root uses 0700 directories and is removed after success', async () => {
    const storage = await createManagedPGliteRunStorage();
    const root = storage.dataDir.replace(/\/data$/u, '');
    assert.equal((await stat(root)).mode! & 0o777, 0o700);
    assert.equal((await stat(storage.dataDir)).mode! & 0o777, 0o700);
    assert.equal((await stat(storage.snapshotDir)).mode! & 0o777, 0o700);
    await storage.cleanup();
    await assert.rejects(() => stat(root));
});

test('managed PGlite private root is removed after the production failure wrapper rejects', async () => {
    let root = '';
    await assert.rejects(
        () =>
            withManagedPGliteRunStorage((storage) => {
                root = storage.dataDir.replace(/\/data$/u, '');
                return Promise.reject(new Error('simulated managed recipe failure'));
            }),
        /managed recipe failure/u
    );
    await assert.rejects(() => stat(root));
});

for (const failure of ['chmod', 'mkdir'] as const) {
    test(`managed PGlite setup removes its root when ${failure} rejects`, async () => {
        let root = '';
        await assert.rejects(
            () =>
                createManagedPGliteRunStorage({
                    makeTempDir: async (input) => {
                        root = await mkdtemp(join(tmpdir(), input.prefix));
                        return root;
                    },
                    chmod: async (path, mode) => {
                        if (failure === 'chmod') {
                            throw new Error('chmod setup failed');
                        }
                        await chmod(path, mode);
                    },
                    mkdir: async (path, input) => {
                        if (failure === 'mkdir') {
                            throw new Error('mkdir setup failed');
                        }
                        await mkdir(path, input);
                    },
                    remove: async (path, input) => await rm(path, input)
                }),
            new RegExp(`${failure} setup failed`, 'u')
        );
        await assert.rejects(() => stat(root));
    });
}
