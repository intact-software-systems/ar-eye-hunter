import { describe, expect, it } from 'vitest';
import {
  decodeJsonWireValue,
  type JsonWireObject,
  type JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import { createHetznerGroupAssertionsRecipe } from
  '../../../apps/rallar-black-box/src/hetzner/create-hetzner-group-assertions-recipe.ts';
import { createHetznerRtcAbsenceWaitRecipe } from
  '../../../apps/rallar-black-box/src/hetzner/create-hetzner-rtc-absence-wait-recipe.ts';

const GROUP = {
  applicationId: 'application-visible-target',
  workspaceId: 'workspace-visible-target',
  groupId: 'group-visible-target',
};

describe.each([
  ['group assertions', createHetznerGroupAssertionsRecipe],
  ['RTC absence wait', createHetznerRtcAbsenceWaitRecipe],
] as const)('%s generated recipe mutation identity', (_name, createRecipe) => {
  it('owns opaque path request IDs and semantic-only bodies per recipe construction', () => {
    const first = mutationRequests(createRecipe(GROUP));
    expect(first).toHaveLength(2);
    expect(first.map((request) => request.path)).toEqual([
      expect.stringMatching(/\/groups\/requests\/[^/]+$/),
      expect.stringMatching(/\/members\/\{auth\.clientId\}\/requests\/[^/]+$/),
    ]);
    expect(
      first.every(
        (request) =>
          request.body === undefined || !Object.hasOwn(requireObject(request.body), 'requestId'),
      ),
    ).toBe(true);
    const firstRequestIds = first.map((request) => request.path.split('/').at(-1));
    expect(new Set(firstRequestIds).size).toBe(first.length);
    expect(
      firstRequestIds.every(
        (requestId) =>
          typeof requestId === 'string' &&
          !Object.values(GROUP).some((targetPart) => requestId.includes(targetPart)) &&
          !requestId.includes('auth.'),
      ),
    ).toBe(true);
    expect(firstRequestIds.every((requestId) => requestId?.endsWith('-{runId}'))).toBe(true);
  });
});

function mutationRequests(
  recipe: ReturnType<typeof createHetznerGroupAssertionsRecipe>,
): readonly Readonly<{
  path: string;
  body?: JsonWireValue;
}>[] {
  return recipe.commands.flatMap((command) => {
    if (
      command.kind !== 'http.request' ||
      !command.request?.path ||
      command.request.method === 'GET'
    ) {
      return [];
    }
    return [
      {
        path: command.request.path,
        ...(command.request.body === undefined
          ? {}
          : { body: decodeJsonWireValue(command.request.body, 'Hetzner recipe body') }),
      },
    ];
  });
}

function requireObject(value: JsonWireValue): JsonWireObject {
  if (!isJsonWireObject(value)) {
    throw new TypeError('Expected Hetzner recipe body object');
  }
  return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
