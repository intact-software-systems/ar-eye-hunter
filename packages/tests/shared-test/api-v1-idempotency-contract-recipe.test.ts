import { describe, expect, it } from 'vitest';
import {
  decodeJsonWireValue,
  type JsonWireObject,
  type JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';

import {
  readApiV1Matrix,
  readApiV1Recipe,
  toFlatApiV1RecipeSteps,
} from './api-v1-recipe-test-fixture.ts';

const RECIPE_ID = 'api-v1-idempotency-contract';
const GROUP_MUTATION_PATH =
  '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
  '/groups/{groupId}/requests/idem-contract-group-replay-{runId}';
const EQUAL_CONTENDER_PATH =
  '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
  '/groups/{groupId}/topology/config/requests/' +
  'idem-contract-equal-contenders-{runId}';
const DIFFERENT_CONTENDER_PATH =
  '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
  '/groups/{groupId}/topology/override/requests/' +
  'idem-contract-different-contenders-{runId}';

describe('API-v1 equal AppInbox HTTP idempotency contract recipe', () => {
  it('is a Tier 2 three-node cluster recipe', () => {
    const entry = readApiV1Matrix().entries.find((candidate) => candidate.id === RECIPE_ID);

    expect(entry).toMatchObject({
      recipe: `tests/api-v1/${RECIPE_ID}.json`,
      category: 'api-v1-black-box',
      mode: 'run',
      tier: 2,
      profiles: ['api-v1-black-box-cluster'],
      expectedExitCode: 0,
    });
    expect(entry?.requires?.httpServices?.map((service) => service.env)).toEqual([
      'RALLAR_API_BASE_URL',
      'RALLAR_API_BASE_URL_SECONDARY',
      'RALLAR_API_BASE_URL_TERTIARY',
    ]);
  });

  it('owns every locked behavior and durable evidence block', () => {
    const steps = readSteps();
    const names = new Set(steps.map((step) => step.name));

    for (const name of [
      'firstGroupMutation',
      'exactGroupReplayAfterSessionRenewal',
      'normalizedGroupReplay',
      'rejectChangedGroupIntent',
      'rejectBodyRequestIdentity',
      'rejectHeaderRequestIdentity',
      'rejectOldMutationPath',
      'acceptMinimumRequestId',
      'acceptMaximumRequestId',
      'replayNoOpMutation',
      'raceEqualContendersAcrossThreeNodes',
      'assertEqualContenderResults',
      'raceDifferentContendersAcrossNodes',
      'assertOneDifferentIntentWinner',
      'proveOperationIsolation',
      'proveActorIsolation',
      'proveScopeIsolation',
      'proveDocumentIsolation',
      'replayTerminalFailure',
      'replayLogout',
      'issueWebSocketTicket',
      'issueSingleUseAgentTicket',
      'raceSingleUseAgentTicketConsumption',
      'assertSingleTicketConsumption',
      'appendCrdtUpdateThroughWebSocket',
      'redeliverCrdtUpdateWithDistinctDeliveryId',
      'readCrdtThroughTertiary',
      'replayCrdtHttpMutation',
      'rejectChangedCrdtHttpIntent',
      'replayNormalizedPruneCategories',
      'proveAdminActorIsolation',
      'replayTopologyAfterRestartBoundary',
      'exposeStateWriteEvidence',
      'assertAtomicAppInboxCompletion',
      'assertSecretsStayRedacted',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('reuses identity only for replay and contender sets', () => {
    const byName = new Map(
      readSteps().flatMap((step) =>
        typeof step.name === 'string' ? [[step.name, step] as const] : [],
      ),
    );
    expect(
      paths(byName, [
        'firstGroupMutation',
        'exactGroupReplayAfterSessionRenewal',
        'normalizedGroupReplay',
        'rejectChangedGroupIntent',
      ]),
    ).toEqual(new Set([GROUP_MUTATION_PATH]));
    expect(
      paths(byName, ['equalContenderPrimary', 'equalContenderSecondary', 'equalContenderTertiary']),
    ).toEqual(new Set([EQUAL_CONTENDER_PATH]));
    expect(paths(byName, ['differentContenderPrimary', 'differentContenderSecondary'])).toEqual(
      new Set([DIFFERENT_CONTENDER_PATH]),
    );
  });

  it('collects exact durable completion without exposing secret selectors', () => {
    const recipe = readRecipe();
    const steps = readSteps();
    const evidence = steps.find((step) => step.name === 'exposeStateWriteEvidence');
    const assertion = steps.find((step) => step.name === 'assertAtomicAppInboxCompletion');
    const serialized = JSON.stringify(recipe);

    expect(evidence).toMatchObject({
      type: 'set.state-write-evidence',
      output: 'stateWriteEvidence',
      request: {
        stateWriteEvidence: {
          match: 'idem-contract-group-replay-{runId}',
          commandTypes: ['GROUP_UPDATE'],
          commandIdPrefixes: ['idem-contract-group-replay-'],
          minimumMatchedRows: 1,
          expectedEffectsByCommandType: {
            GROUP_UPDATE: ['group-presence-summary'],
          },
        },
      },
    });
    expect(assertion).toMatchObject({
      actual: {
        atomicCompletionFailures: '{stateWriteEvidence.atomicCompletionFailures}',
        intermediateMutationIntentCount: '{stateWriteEvidence.intermediateMutationIntentCount}',
      },
      expect: {
        body: {
          atomicCompletionFailures: 0,
          intermediateMutationIntentCount: 0,
        },
      },
    });
    expect(serialized).not.toMatch(/requests\/[^"}]*\{(?:password|accessToken|authHeader|ticket)/i);
  });
});

function readRecipe(): JsonWireObject {
  const entry = readApiV1Matrix().entries.find((candidate) => candidate.id === RECIPE_ID);
  if (!entry) {
    throw new Error(`Missing ${RECIPE_ID} recipe matrix entry`);
  }
  return requireObject(decodeJsonWireValue(readApiV1Recipe(entry.recipe), `${RECIPE_ID} recipe`));
}

function readSteps(): readonly JsonWireObject[] {
  const recipe = readRecipe();
  if (!Array.isArray(recipe.steps)) {
    throw new TypeError(`${RECIPE_ID} steps must be an array`);
  }
  return toFlatApiV1RecipeSteps(recipe.steps).map((step) =>
    requireObject(decodeJsonWireValue(step, `${RECIPE_ID} step`)),
  );
}

function paths(
  byName: ReadonlyMap<string, JsonWireObject>,
  names: readonly string[],
): ReadonlySet<string | undefined> {
  return new Set(
    names.map((name) => {
      const step = byName.get(name);
      const request = optionalObject(step?.request);
      return typeof request?.path === 'string' ? request.path : undefined;
    }),
  );
}

function requireObject(value: JsonWireValue | undefined): JsonWireObject {
  const object = optionalObject(value);
  if (!object) {
    throw new TypeError(`Expected ${RECIPE_ID} JSON object`);
  }
  return object;
}

function optionalObject(value: JsonWireValue | undefined): JsonWireObject | undefined {
  return value !== undefined && isJsonWireObject(value) ? value : undefined;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
