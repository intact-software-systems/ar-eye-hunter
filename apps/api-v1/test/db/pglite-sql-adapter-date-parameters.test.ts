import assert from 'node:assert/strict';
Deno.test('PGlite SQL preserves UTC timestamp parity in an explicitly non-UTC subprocess', async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--config',
      'apps/api-v1/deno.json',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      'apps/api-v1/test/db/pglite-sql-adapter-timezone-child.ts',
    ],
    cwd: Deno.cwd(),
    env: { ...Deno.env.toObject(), TZ: 'America/New_York' },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assert.equal(output.success, true, new TextDecoder().decode(output.stderr));
});
