function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('manual retention route cannot close sockets delete artifacts or read bodies', async () => {
  const source = await Deno.readTextFile(new URL('../src/main.ts', import.meta.url));
  const startMarker = "if (request.method === 'POST' && url.pathname === '/retention/cleanup') {";
  const start = source.indexOf(startMarker);
  const end = source.indexOf('\n  const runMatch =', start);
  assert(start >= 0 && end > start, 'Retention route block should remain structurally bounded.');
  const route = source.slice(start, end);

  assert(route.includes('handleRetentionCleanup({'));
  assert(route.includes('persist: persistControlSnapshot'));
  for (
    const forbidden of [
      'closeRunSockets',
      'closeDeletedRunSockets',
      'artifactRecorder',
      'readJsonBody',
      'readTextBody',
    ]
  ) {
    assert(!route.includes(forbidden), `Manual retention route must not call ${forbidden}.`);
  }
});
