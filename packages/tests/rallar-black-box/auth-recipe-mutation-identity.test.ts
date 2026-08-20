import { describe, expect, it } from 'vitest';
import {
  decodeJsonWireValue,
  type JsonWireObject,
  type JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import { authRecipeSnippet } from
  '../../../apps/rallar-black-box/src/legacy/diagnostics/auth/auth-recipe.ts';

describe('auth command-center recipe mutation identity', () => {
  it('allocates distinct opaque path identities for each generated operator action', () => {
    const recipe = readRecipe(authRecipeSnippet('visible-username'));
    const repeated = readRecipe(authRecipeSnippet('visible-username'));

    expect(recipe.commands.map((command) => command.request.path)).toEqual([
      expect.stringMatching(/^\/api\/auth\/login\/requests\/[^/]+$/),
      expect.stringMatching(/^\/api\/auth\/ws-ticket\/requests\/[^/]+$/),
      expect.stringMatching(/^\/api\/auth\/ws-ticket\/requests\/[^/]+$/),
    ]);
    expect(
      recipe.commands.every((command) => !Object.hasOwn(command.request.body ?? {}, 'requestId')),
    ).toBe(true);
    const requestIds = recipe.commands.map((command) => command.request.path.split('/').at(-1));
    expect(new Set(requestIds).size).toBe(recipe.commands.length);
    expect(
      requestIds.every(
        (requestId) => typeof requestId === 'string' && !requestId.includes('visible-username'),
      ),
    ).toBe(true);
    expect(repeated.commands.map((command) => command.request.path)).not.toEqual(
      recipe.commands.map((command) => command.request.path),
    );
  });
});

function readRecipe(source: string): Readonly<{
  commands: readonly Readonly<{
    request: Readonly<{
      path: string;
      body?: JsonWireObject;
    }>;
  }>[];
}> {
  const root = requireObject(decodeJsonWireValue(JSON.parse(source), 'auth recipe'));
  if (!Array.isArray(root.commands)) {
    throw new TypeError('Auth recipe commands must be an array');
  }
  return {
    commands: root.commands.map((commandValue) => {
      const command = requireObject(commandValue);
      const request = requireObject(command.request);
      if (typeof request.path !== 'string') {
        throw new TypeError('Auth recipe request path must be a string');
      }
      return {
        request: {
          path: request.path,
          ...(request.body === undefined ? {} : { body: requireObject(request.body) }),
        },
      };
    }),
  };
}

function requireObject(value: JsonWireValue | undefined): JsonWireObject {
  if (value === undefined || !isJsonWireObject(value)) {
    throw new TypeError('Expected auth recipe JSON object');
  }
  return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
