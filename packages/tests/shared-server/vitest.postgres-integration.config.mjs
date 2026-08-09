import denoVitestConfig from './vitest.deno.config.mjs';

export default {
  ...denoVitestConfig,
  test: {
    ...denoVitestConfig.test,
    include: ['packages/tests/shared-server/integration/postgres/*.test.ts'],
  },
};
