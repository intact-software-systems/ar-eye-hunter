const { Temporal } = globalThis;

if (!Temporal) {
  throw new Error(
    'Deno Temporal global is not available; run this test with --unstable-temporal.',
  );
}

export { Temporal };
