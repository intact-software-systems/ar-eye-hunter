import assert from 'node:assert/strict';
import { applyRuntimeConfigOverrides } from '../src/config-repo.ts';

const baseConfig = {
  apiBaseUrl: 'http://localhost:8080',
  wsBaseUrl: 'ws://localhost:8080',
  endpoints: {
    createWs: '/api/ws/:id',
  },
};

Deno.test('runtime config uses static URLs when no override is configured', () => {
  assert.deepEqual(applyRuntimeConfigOverrides(baseConfig, fakeEnv({})), baseConfig);
});

Deno.test('runtime config can override API and derived WS base URLs', () => {
  assert.deepEqual(
    applyRuntimeConfigOverrides(
      baseConfig,
      fakeEnv({
        RALLAR_API_BASE_URL: 'http://localhost:18080/',
      }),
    ),
    {
      ...baseConfig,
      apiBaseUrl: 'http://localhost:18080',
      wsBaseUrl: 'ws://localhost:18080',
    },
  );
});

Deno.test('runtime config derives wss from an https API base URL', () => {
  assert.deepEqual(
    applyRuntimeConfigOverrides(
      baseConfig,
      fakeEnv({
        RALLAR_API_BASE_URL: 'https://api.example.test/',
      }),
    ),
    {
      ...baseConfig,
      apiBaseUrl: 'https://api.example.test',
      wsBaseUrl: 'wss://api.example.test',
    },
  );
});

Deno.test('runtime config accepts an explicit WS base URL override', () => {
  assert.deepEqual(
    applyRuntimeConfigOverrides(
      baseConfig,
      fakeEnv({
        RALLAR_API_BASE_URL: 'https://api.example.test',
        RALLAR_WS_BASE_URL: 'wss://ws.example.test/',
      }),
    ),
    {
      ...baseConfig,
      apiBaseUrl: 'https://api.example.test',
      wsBaseUrl: 'wss://ws.example.test',
    },
  );
});

function fakeEnv(
  values: Readonly<Record<string, string | undefined>>,
): { get(name: string): string | undefined } {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}
