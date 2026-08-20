import { describe, expect, it } from 'vitest';

import {
  toFlatApiV1RecipeSteps as flattenRecipeSteps,
  readApiV1Matrix as readMatrix,
  readApiV1Recipe as readRecipe,
} from './api-v1-recipe-test-fixture.ts';

describe('API-v1 state-write convergence recipe', () => {
  it('defines three-server API state-write convergence with bounded causal polling', () => {
    const { entries } = readMatrix();
    const entry = entries.find((candidate) => candidate.id === 'api-v1-state-write-convergence');

    expect(entry).toMatchObject({
      id: 'api-v1-state-write-convergence',
      recipe: 'tests/api-v1/api-v1-state-write-convergence.json',
      category: 'api-v1-black-box',
      mode: 'run',
      profiles: ['api-v1-black-box-cluster'],
      expectedExitCode: 0,
    });
    if (!entry) return;
    expect(entry.requires?.httpServices).toHaveLength(3);
    expect(entry.requires?.playwright).not.toBe(true);

    const recipe = readRecipe(entry.recipe);
    const steps = recipe.steps as Array<Record<string, unknown>>;
    const allSteps = flattenRecipeSteps(steps);
    const recipeText = JSON.stringify(recipe);
    for (const contender of ['Primary', 'Secondary']) {
      const registerName = `register${contender}Contender`;
      const loginName = `login${contender}Contender`;
      const deriveName = `derive${contender}ContenderAuthHeader`;
      const register = steps.find((step) => step.name === registerName);
      const login = steps.find((step) => step.name === loginName);
      expect(steps.indexOf(register!)).toBeLessThan(steps.indexOf(login!));
      expect(steps.indexOf(login!)).toBeLessThan(
        steps.indexOf(steps.find((step) => step.name === deriveName)!),
      );
      expect(register?.request).toMatchObject({
        method: 'POST',
        path: expect.stringMatching(/^\/api\/auth\/register\/requests\/[^/]+$/),
        outputs: {
          [`${contender.toLowerCase()}ContenderClientId`]: 'body.clientId',
        },
      });
      expect(register?.expect).toEqual({
        status: 201,
        body: { clientId: 'string' },
      });
      expect(login?.request).toMatchObject({
        method: 'POST',
        path: expect.stringMatching(/^\/api\/auth\/login\/requests\/[^/]+$/),
        outputs: {
          [`${contender.toLowerCase()}ContenderAccessToken`]: {
            path: 'body.accessToken',
            secret: true,
          },
        },
      });
      expect(login?.expect).toMatchObject({
        status: 200,
        body: { accessToken: 'string', sessionId: 'string' },
      });
    }
    const race = steps.find((step) => step.name === 'raceBoundedMembershipPresenceAndConfig') as {
      type?: string;
      maxConcurrency?: number;
      groups?: Array<{ steps?: Array<Record<string, unknown>> }>;
    };
    expect(race).toMatchObject({ type: 'parallel', maxConcurrency: 4 });
    expect(race.groups).toHaveLength(4);
    expect(
      new Set(race.groups?.flatMap((group) => (group.steps ?? []).map((step) => step.connection))),
    ).toEqual(new Set(['apiPrimary', 'apiSecondary', 'apiTertiary']));
    const capacityAssertion = steps.find((step) => step.name === 'assertExactlyOneCapacityWinner');
    expect(capacityAssertion).toMatchObject({
      type: 'assert',
      actual: {
        statuses: [
          '{resultsByName.activatePrimaryContenderMembership.0.actual.statusCode}',
          '{resultsByName.activateSecondaryContenderMembership.0.actual.statusCode}',
        ],
      },
      expect: {
        anyOf: [{ statuses: [200, 403] }, { statuses: [403, 200] }],
      },
    });
    expect(steps.find((step) => step.name === 'createBoundedGroup')?.request).toMatchObject({
      body: { maxMembers: 2, joinMode: 'open' },
    });

    const configNames = [
      'putInitialTopologyConfig',
      'deleteTopologyConfig',
      'putFinalTopologyConfig',
    ];
    const configSequence = steps.filter((step) => configNames.includes(String(step.name)));
    expect(configSequence.map((step) => step.name)).toEqual(configNames);
    expect(configSequence.map((step) => (step.request as { method?: string })?.method)).toEqual([
      'PUT',
      'DELETE',
      'PUT',
    ]);
    expect(JSON.stringify(recipe)).not.toContain('/topology/reconfigure');
    const reconnect = allSteps.find((step) => step.name === 'reconnectReusedSession');
    expect(reconnect?.request).toMatchObject({
      path: expect.stringContaining('{reusedSessionId}'),
      body: {
        generationId: 'generation-2-{runId}',
        expiresAtEpochMs: expect.any(Number),
      },
      outputs: {
        acceptedLifecyclePresenceRevision: 'body.causalRevision.presenceRevision',
        acceptedLifecycleGenerationId: 'body.activeSessions.0.generationId',
      },
    });
    expect(steps.find((step) => step.name === 'submitStaleExpiryCandidate')).toBeUndefined();
    const captureExpiredPresenceAt = steps.find((step) => step.name === 'captureExpiredPresenceAt');
    expect(captureExpiredPresenceAt).toMatchObject({
      type: 'set',
      output: 'expiredPresenceAtEpochMs',
      transform: { timestamp: true },
    });
    expect(
      steps.find((step) => step.name === 'connectReusedSessionGenerationOne')?.request,
    ).toMatchObject({
      body: {
        generationId: 'generation-1-{runId}',
        connectedAtEpochMs: '{expiredPresenceAtEpochMs}',
        lastHeartbeatAtEpochMs: '{expiredPresenceAtEpochMs}',
        expiresAtEpochMs: '{expiredPresenceAtEpochMs}',
      },
    });
    expect(
      steps.find((step) => step.name === 'connectExpiredPresenceProbe')?.request,
    ).toMatchObject({
      body: {
        connectedAtEpochMs: '{expiredPresenceAtEpochMs}',
        lastHeartbeatAtEpochMs: '{expiredPresenceAtEpochMs}',
        expiresAtEpochMs: '{expiredPresenceAtEpochMs}',
      },
    });
    expect(steps.indexOf(captureExpiredPresenceAt!)).toBeLessThan(
      steps.indexOf(steps.find((step) => step.name === 'connectReusedSessionGenerationOne')!),
    );
    const backgroundExpiry = steps.find(
      (step) => step.name === 'waitForBackgroundExpiryReconciliation',
    );
    expect(backgroundExpiry).toMatchObject({
      type: 'set',
      request: { delayMs: expect.any(Number) },
    });
    expect(Number((backgroundExpiry?.request as { delayMs?: number })?.delayMs)).toBeGreaterThan(
      60_000,
    );
    expect(allSteps.indexOf(reconnect!)).toBeLessThan(allSteps.indexOf(backgroundExpiry!));

    const pollDelays = steps.filter((step) =>
      String(step.name).startsWith('delayBeforeStateConvergencePoll'),
    );
    expect(
      pollDelays.map((step) => Number((step.request as { delayMs?: number })?.delayMs)),
    ).toEqual([250, 500, 1000, 2000, 4000]);
    const polls = steps.filter((step) =>
      String(step.name).startsWith('pollStateConvergenceAttempt'),
    );
    expect(polls).toHaveLength(5);
    polls.forEach((step) =>
      expect(step).toMatchObject({
        type: 'parallel',
        maxConcurrency: 2,
        nonBlockingFailure: true,
      }),
    );
    polls.forEach((step) => {
      const pollConnections = new Set(
        flattenRecipeSteps([step])
          .map((candidate) => candidate.connection)
          .filter(Boolean),
      );
      expect(pollConnections).toEqual(new Set(['apiPrimary', 'apiSecondary', 'apiTertiary']));
    });
    for (const server of ['Primary', 'Secondary', 'Tertiary']) {
      expect(allSteps.find((step) => step.name === `read${server}DurableConfig`)).toMatchObject({
        type: 'http',
        connection: `api${server}`,
        request: {
          method: 'GET',
          path: expect.stringContaining('/topology/config'),
        },
        expect: {
          body: {
            durable: {
              version:
                '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
              requestId: 'put-final-config-{groupId}-{runId}',
            },
          },
        },
      });
    }

    const finalAssertion = steps.find(
      (step) => step.name === 'assertIdenticalFinalStateAndCausalHistory',
    );
    expect(finalAssertion).toMatchObject({
      type: 'assert',
      actual: {
        primary: expect.any(Object),
        secondary: expect.any(Object),
        tertiary: expect.any(Object),
        causalHistory: expect.any(Object),
      },
      expect: {
        body: expect.any(Object),
        monotonicPaths: expect.any(Array),
        missingActualValue: 'MISSING',
      },
    });
    expect(finalAssertion?.expect).toMatchObject({
      body: {
        primary: {
          groupStateCausalRevision: {
            presenceRevision: 'integer',
          },
          generationId: 'generation-2-{runId}',
          postExpiryGenerationId: 'generation-2-{runId}',
          sourceGroupStateCausalRevision:
            '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.causalRevision}',
          durableConfigVersion:
            '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
        },
        secondary: {
          sourceGroupStateCausalRevision:
            '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.causalRevision}',
          durableConfigVersion:
            '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
        },
        tertiary: {
          sourceGroupStateCausalRevision:
            '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.causalRevision}',
          durableConfigVersion:
            '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
        },
        causalHistory: {
          primary: {
            topologyPresence: expect.any(Array),
            topologyTuples: expect.any(Array),
          },
          secondary: {
            topologyPresence: expect.any(Array),
            topologyTuples: [
              '{resultsByName.readPrimaryTopologyAttempt1.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
              '{resultsByName.readPrimaryTopologyAttempt2.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
              '{resultsByName.readPrimaryTopologyAttempt3.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
              '{resultsByName.readPrimaryTopologyAttempt4.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
              '{resultsByName.readPrimaryTopologyAttempt5.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
            ],
          },
          tertiary: {
            topologyPresence: expect.any(Array),
            topologyTuples: expect.any(Array),
          },
        },
      },
    });
    expect((finalAssertion?.expect as { monotonicPaths?: unknown }).monotonicPaths).toEqual(
      expect.arrayContaining([
        'causalHistory.primary.topologyPresence',
        'causalHistory.secondary.topologyPresence',
        'causalHistory.tertiary.topologyPresence',
      ]),
    );
    for (const field of [
      '/members/',
      '/sessions/',
      '/topology/config',
      'groupStateCausalRevision',
      'members',
      'generationId',
      'postExpiryGenerationId',
      'durableConfigVersion',
      'config',
      'sourceGroupStateCausalRevision',
      'topologyTuples',
    ])
      expect(recipeText + JSON.stringify(finalAssertion)).toContain(field);
    expect(JSON.stringify(finalAssertion)).not.toContain('outboxIds');
  });
});
