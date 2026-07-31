import assert from 'node:assert/strict';
import {
  createManagedPGliteRunStorage,
  withManagedPGliteRunStorage,
} from '../../../../packages/shared-test/black-box-runner/api-v1-managed-process-lifecycle.mts';

Deno.test('managed PGlite private root uses 0700 directories and is removed after success', async () => {
  const storage = await createManagedPGliteRunStorage();
  const root = storage.dataDir.replace(/\/data$/u, '');
  assert.equal((await Deno.stat(root)).mode! & 0o777, 0o700);
  assert.equal((await Deno.stat(storage.dataDir)).mode! & 0o777, 0o700);
  assert.equal((await Deno.stat(storage.snapshotDir)).mode! & 0o777, 0o700);
  await storage.cleanup();
  await assert.rejects(() => Deno.stat(root));
});

Deno.test('managed PGlite private root is removed after the production failure wrapper rejects', async () => {
  let root = '';
  await assert.rejects(
    () =>
      withManagedPGliteRunStorage(async (storage) => {
        root = storage.dataDir.replace(/\/data$/u, '');
        throw new Error('simulated managed recipe failure');
      }),
    /managed recipe failure/u,
  );
  await assert.rejects(() => Deno.stat(root));
});

for (const failure of ['chmod', 'mkdir'] as const) {
  Deno.test(`managed PGlite setup removes its root when ${failure} rejects`, async () => {
    let root = '';
    await assert.rejects(
      () =>
        createManagedPGliteRunStorage({
          makeTempDir: async (input) => {
            root = await Deno.makeTempDir(input);
            return root;
          },
          chmod: async (path, mode) => {
            if (failure === 'chmod') throw new Error('chmod setup failed');
            await Deno.chmod(path, mode);
          },
          mkdir: async (path, input) => {
            if (failure === 'mkdir') throw new Error('mkdir setup failed');
            await Deno.mkdir(path, input);
          },
          remove: async (path, input) => await Deno.remove(path, input),
        }),
      new RegExp(`${failure} setup failed`, 'u'),
    );
    await assert.rejects(() => Deno.stat(root));
  });
}
