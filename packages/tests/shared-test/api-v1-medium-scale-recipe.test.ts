import { describe, expect, it } from 'vitest';

import {
  toFlatApiV1RecipeSteps as flattenRecipeSteps,
  readApiV1Matrix as readMatrix,
  readApiV1Recipe as readRecipe,
} from './api-v1-recipe-test-fixture.ts';

describe('API-v1 medium-scale recipe', () => {
  it('defines the isolated 100-client five-group medium-scale state churn gate', () => {
    const { entries } = readMatrix();
    const entry = entries.find((candidate) => candidate.id === 'api-v1-state-medium-scale-churn');

    expect(entry).toMatchObject({
      id: 'api-v1-state-medium-scale-churn',
      category: 'api-v1-black-box',
      mode: 'run',
      profiles: ['api-v1-black-box-medium-scale'],
      expectedExitCode: 0,
    });
    expect(entry?.requires?.httpServices).toHaveLength(3);
    expect(entry?.requires?.playwright).not.toBe(true);

    const recipe = readRecipe(entry!.recipe);
    const steps = recipe.steps as Array<Record<string, unknown>>;
    const generationStart = steps.find((step) => step.name === 'captureClientGenerationStartedAt');
    expect(generationStart).toMatchObject({
      type: 'set',
      output: 'clientGenerationStartedAtEpochMs',
      transform: { timestamp: true },
    });
    const parallel = steps.find((step) => step.name === 'runMediumScaleStateChurn') as {
      type?: string;
      maxConcurrency?: number;
      timeoutMs?: number;
      groups?: Array<{ name?: string; steps?: Array<Record<string, unknown>> }>;
    };
    expect(parallel.type).toBe('parallel');
    expect(parallel.maxConcurrency).toBe(15);
    expect(parallel.timeoutMs).toBe(300_000);
    expect(parallel.groups).toHaveLength(15);
    expect(
      Object.values(recipe.connections as Record<string, { timeoutMs?: number }>).map(
        (connection) => connection.timeoutMs,
      ),
    ).toEqual([15_000, 15_000, 15_000]);

    const clientGroups = parallel.groups!.filter((group) => group.name?.startsWith('client-lane-'));
    expect(clientGroups).toHaveLength(10);
    const clientLoops = clientGroups.map((group) =>
      group.steps?.find((step) => step.type === 'loop'),
    );
    expect(clientLoops.map((loop) => loop?.count)).toEqual(Array(10).fill(10));
    expect(clientLoops.reduce((total, loop) => total + Number(loop?.count), 0)).toBe(100);
    const apiConnections = ['apiPrimary', 'apiSecondary', 'apiTertiary'];
    clientLoops.forEach((loop, laneIndex) => {
      const lane = laneIndex + 1;
      const flow = flattenRecipeSteps([loop!]);
      const writer = apiConnections[laneIndex % apiConnections.length];
      const verifier = apiConnections[(laneIndex + 1) % apiConnections.length];
      expect(
        flow.find((step) => step.name === `registerLane${lane}Client{loop.iteration}`),
      ).toMatchObject({ connection: writer });
      expect(
        flow.find((step) => step.name === `heartbeatLane${lane}ClientSession{loop.iteration}`),
      ).toMatchObject({ connection: verifier });
      expect(
        flow.find((step) => step.name === `disconnectLane${lane}ClientSession{loop.iteration}`),
      ).toMatchObject({ connection: verifier });
    });

    const controlGroups = parallel.groups!.filter((group) =>
      group.name?.startsWith('group-control-lane-'),
    );
    expect(controlGroups).toHaveLength(5);
    expect(
      controlGroups.map((group) => group.steps?.find((step) => step.type === 'loop')?.count),
    ).toEqual(Array(5).fill(10));
    controlGroups.forEach((group, index) => {
      const label = ['one', 'two', 'three', 'four', 'five'][index]!;
      const loop = group.steps?.find((step) => step.type === 'loop');
      const operations = loop?.steps as Array<Record<string, unknown>>;
      expect(operations.map((operation) => operation.connection)).toEqual([
        apiConnections[index % apiConnections.length],
        apiConnections[(index + 1) % apiConnections.length],
        apiConnections[(index + 2) % apiConnections.length],
        apiConnections[index % apiConnections.length],
      ]);
      for (const operationName of [
        `put${label}TopologyConfig{loop.iteration}`,
        `delete${label}TopologyConfig{loop.iteration}`,
        `putFinal${label}TopologyConfig{loop.iteration}`,
      ]) {
        const operation = operations.find((step) => step.name === operationName);
        expect(operation?.expect).toMatchObject({
          status: 200,
          body: {
            receipt: {
              acceptedVersion: 'integer',
              outboxIds: ['string'],
            },
          },
        });
      }
    });

    const recipeText = JSON.stringify(recipe);
    const groupIds = ['groupOneId', 'groupTwoId', 'groupThreeId', 'groupFourId', 'groupFiveId'];
    groupIds.forEach((groupId) => {
      expect(recipeText).toContain(`{${groupId}}/members/`);
      expect(recipeText).toContain(`{${groupId}}/sessions/`);
      expect(recipeText).toContain(`{${groupId}}/topology/config`);
      expect(recipeText).toContain(`{${groupId}}/topology/reconfigure`);
      expect(recipeText).toContain(`groups/{${groupId}}`);
      const causalPrefix = `final${groupId[0].toUpperCase()}${groupId.slice(1)}`;
      expect(recipeText).toContain(`${causalPrefix}StateCausalRevision`);
      expect(recipeText).toContain(`${causalPrefix}PresenceCausalRevision`);
    });

    clientLoops.forEach((loop) => {
      const flow = JSON.stringify(loop);
      expect(flow).toContain('/api/auth/register');
      expect(flow).toContain('/api/auth/login');
      expect(flow).toContain('/principal');
      expect(flow).toContain('/instances/');
      expect(flow).toContain('/sessions/');
      expect(flow).toContain('/heartbeat');
      expect(flow).toContain('/disconnect');
      expect(flow).toContain('x-forwarded-for');
      expect(flow).toMatch(/10\.\d+\.\{loop\.iteration\}\.1/);
    });

    clientLoops.forEach((loop, laneIndex) => {
      const lane = laneIndex + 1;
      const flow = flattenRecipeSteps([loop!]);
      const clientSessionSteps = flow.filter((step) => {
        const request = step.request as { path?: string } | undefined;
        return (
          request?.path?.includes(`/clients/{lane${lane}ClientId}/`) === true &&
          request.path.includes('/sessions/')
        );
      });
      const generationFor = (namePrefix: string) =>
        (
          clientSessionSteps.find((step) => String(step.name).startsWith(namePrefix))?.request as
            { body?: { generationId?: string } } | undefined
        )?.body?.generationId;
      const connectedAtFor = (namePrefix: string) =>
        (
          clientSessionSteps.find((step) => String(step.name).startsWith(namePrefix))?.request as
            { body?: { connectedAtEpochMs?: number } } | undefined
        )?.body?.connectedAtEpochMs;
      expect(generationFor(`connectLane${lane}ClientSession`)).toBe(
        `lane-${lane}-generation-1-{loop.iteration}-{runId}`,
      );
      expect(connectedAtFor(`connectLane${lane}ClientSession`)).toBe(
        '{clientGenerationStartedAtEpochMs}',
      );
      expect(generationFor(`heartbeatLane${lane}ClientSession`)).toBe(
        `lane-${lane}-generation-1-{loop.iteration}-{runId}`,
      );
      expect(generationFor(`disconnectLane${lane}ClientSession`)).toBe(
        `lane-${lane}-generation-1-{loop.iteration}-{runId}`,
      );
      expect(generationFor(`reconnectLane${lane}ClientSession`)).toBe(
        `lane-${lane}-generation-2-{loop.iteration}-{runId}`,
      );
      expect(connectedAtFor(`reconnectLane${lane}ClientSession`)).toBe(
        '{clientGenerationStartedAtEpochMs}',
      );
      const groupSessionSteps = flow.filter((step) => {
        const request = step.request as { path?: string } | undefined;
        return request?.path?.includes('/groups/') === true && request.path.includes('/sessions/');
      });
      for (const step of groupSessionSteps) {
        const generationId = (
          step.request as {
            body?: { generationId?: string };
          }
        ).body?.generationId;
        if (String(step.name).startsWith(`reconnectLane${lane}ToRotatedGroup`)) {
          expect(generationId).toBe(`lane-${lane}-generation-3-{loop.iteration}-{runId}`);
        } else {
          expect(generationId).toBe(`lane-${lane}-generation-2-{loop.iteration}-{runId}`);
        }
      }
    });

    const churnIndex = steps.findIndex((step) => step.name === 'runMediumScaleStateChurn');
    const afterChurn = steps.slice(churnIndex + 1);
    const equalDuplicateWave = afterChurn.find((step) =>
      step.name === 'runBoundedEqualDuplicateWave'
    );
    const changedDuplicateWave = afterChurn.find((step) =>
      step.name === 'runBoundedChangedDuplicateWave'
    );
    expect(equalDuplicateWave).toMatchObject({
      type: 'parallel',
      maxConcurrency: 3,
      timeoutMs: 30_000,
      groups: expect.any(Array),
    });
    expect(changedDuplicateWave).toMatchObject({
      type: 'parallel',
      maxConcurrency: 2,
      timeoutMs: 30_000,
      groups: expect.any(Array),
    });
    const equalPaths = flattenRecipeSteps([equalDuplicateWave!])
      .filter((step) => String(step.name).startsWith('equalDuplicate'))
      .map((step) => (step.request as { path?: string }).path);
    const changedPaths = flattenRecipeSteps([changedDuplicateWave!])
      .filter((step) => String(step.name).startsWith('changedDuplicate'))
      .map((step) => (step.request as { path?: string }).path);
    expect(new Set(equalPaths)).toEqual(new Set([
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupOneId}/' +
      'requests/medium-scale-equal-duplicate-wave-{runId}',
    ]));
    expect(new Set(changedPaths)).toEqual(new Set([
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupTwoId}/' +
      'requests/medium-scale-changed-duplicate-wave-{runId}',
    ]));
    expect(afterChurn.find((step) => step.name === 'assertChangedDuplicateWave')).toMatchObject({
      expect: { anyOf: [{ statuses: [200, 409] }, { statuses: [409, 200] }] },
    });
    const pollDelays = afterChurn.filter((step) =>
      String(step.name).startsWith('delayBeforeConvergencePoll'),
    );
    expect(
      pollDelays.map((step) => Number((step.request as { delayMs?: number })?.delayMs)),
    ).toEqual([500, 1000, 2000, 4000, 8000]);
    const totalPollDelayMs = pollDelays.reduce(
      (total, step) => total + Number((step.request as { delayMs?: number })?.delayMs),
      0,
    );
    expect(totalPollDelayMs).toBeLessThanOrEqual(30_000);

    const pollSteps = afterChurn.filter((step) =>
      String(step.name).startsWith('pollConvergenceAttempt'),
    );
    expect(pollSteps).toHaveLength(5);
    pollSteps.forEach((step) => {
      expect(step.type).toBe('parallel');
      expect(step.maxConcurrency).toBe(15);
      expect(step.nonBlockingFailure).toBe(true);
      expect(step.groups as unknown[]).toHaveLength(15);
      const clientReads = (
        step.groups as Array<{
          name: string;
          steps: Array<Record<string, unknown>>;
        }>
      ).filter((group) => group.name.startsWith('last-client-lane-'));
      expect(clientReads).toHaveLength(10);
      clientReads.forEach((group) => {
        const request = group.steps[0]?.request as Record<string, unknown>;
        expect(request.method).toBe('GET');
        expect(String(request.path)).toMatch(/\/clients\/\{lane\d+ClientId\}\/presence$/);
        expect(request).not.toHaveProperty('body');
      });
    });

    const firstPollGroups = pollSteps[0].groups as Array<{
      name: string;
      steps: Array<Record<string, unknown>>;
    }>;
    expect(
      firstPollGroups.filter((group) => group.name.startsWith('last-client-lane-')),
    ).toHaveLength(10);
    expect(firstPollGroups.filter((group) => group.name.startsWith('cluster-group-'))).toHaveLength(
      5,
    );
    for (let lane = 1; lane <= 10; lane += 1) {
      const read = firstPollGroups.find((group) => group.name === `last-client-lane-${lane}`)
        ?.steps[0];
      expect(read?.connection).toBe(apiConnections[lane % apiConnections.length]);
      expect(String((read?.request as { path?: string })?.path)).toContain(
        `/clients/{lane${lane}ClientId}/presence`,
      );
      expect(read?.expect).toMatchObject({
        body: {
          principalId: `{lane${lane}ClientId}`,
          isOnline: true,
          activeSessions: [
            {
              generationId: `lane-${lane}-generation-2-10-{runId}`,
            },
          ],
        },
      });
    }

    groupIds.forEach((groupId) => {
      const groupLabel = groupId
        .replace(/^group/, '')
        .replace(/Id$/, '')
        .toLowerCase();
      const groupIndex = groupIds.indexOf(groupId);
      const pollingConnection = apiConnections[groupIndex % apiConnections.length];
      const verificationConnection = apiConnections[(groupIndex + 1) % apiConnections.length];
      const reconfigureConnection = apiConnections[(groupIndex + 2) % apiConnections.length];
      const polling = firstPollGroups.find((group) => group.name === `cluster-group-${groupLabel}`)
        ?.steps[0];
      expect(polling?.connection).toBe(pollingConnection);
      expect(polling?.request).toMatchObject({
        outputs: {
          [`final${groupId[0].toUpperCase()}${groupId.slice(1)}StateCausalRevision`]:
            'body.causalRevision.groupRevision',
          [`final${groupId[0].toUpperCase()}${groupId.slice(1)}PresenceCausalRevision`]:
            'body.causalRevision.presenceRevision',
        },
      });

      const verification = afterChurn.find(
        (step) => step.name === `verify${groupLabel}GroupAcrossCluster`,
      );
      expect(verification).toMatchObject({ connection: verificationConnection });
      expect(verification?.expect).toMatchObject({
        body: {
          causalRevision: {
            groupRevision: `{final${groupId[0].toUpperCase()}${groupId.slice(1)}StateCausalRevision}`,
            presenceRevision: `{final${groupId[0].toUpperCase()}${groupId.slice(1)}PresenceCausalRevision}`,
          },
        },
      });

      const finalTopology = afterChurn.find(
        (step) => step.name === `finalReconfigure${groupLabel}Topology`,
      );
      expect(finalTopology).toMatchObject({ connection: reconfigureConnection });
      expect(finalTopology?.expect).toMatchObject({
        body: {
          status: 'queued',
          groupRef: {
            applicationId: '{applicationId}',
            workspaceId: '{workspaceId}',
            groupId: `{${groupId}}`,
          },
          requestId: `final-reconfigure-{${groupId}}-{runId}`,
          outboxId: 'string',
        },
      });
      expect(
        (finalTopology?.request as { outputs?: Record<string, unknown> })?.outputs,
      ).toBeUndefined();

      const controlLoop = controlGroups
        .find((group) => group.name === `group-control-lane-${groupIds.indexOf(groupId) + 1}`)
        ?.steps?.find((step) => step.type === 'loop');
      const finalConfig = (controlLoop?.steps as Array<Record<string, unknown>> | undefined)?.find(
        (step) => step.name === `putFinal${groupLabel}TopologyConfig{loop.iteration}`,
      );
      expect(
        (finalConfig?.request as { outputs?: Record<string, unknown> })?.outputs,
      ).toMatchObject({
        [`final${groupId[0].toUpperCase()}${groupId.slice(1)}ConfigVersion`]: 'body.config.version',
        [`final${groupId[0].toUpperCase()}${groupId.slice(1)}TopologyOutboxIds`]:
          'body.receipt.outboxIds',
      });
    });

    const topologyPoll = afterChurn.find((step) => step.name === 'pollFinalTopologyEffects');
    expect(topologyPoll).toMatchObject({ type: 'loop', count: 5, intervalMs: 5_000 });
    const topologyPollSteps = topologyPoll?.steps as Array<Record<string, unknown>>;
    expect(topologyPollSteps).toHaveLength(5);
    groupIds.forEach((groupId) => {
      const groupLabel = groupId
        .replace(/^group/, '')
        .replace(/Id$/, '')
        .toLowerCase();
      const read = topologyPollSteps.find(
        (step) => step.name === `observe${groupLabel}PublishedTopologyEffect{loop.iteration}`,
      );
      expect(read).toMatchObject({
        type: 'http',
        nonBlockingFailure: true,
        expect: {
          body: {
            snapshot: {
              version: 'integer',
              sourceGroupStateCausalRevision: {
                groupRevision: `{final${groupId[0].toUpperCase()}${groupId.slice(1)}StateCausalRevision}`,
                presenceRevision: `{final${groupId[0].toUpperCase()}${groupId.slice(1)}PresenceCausalRevision}`,
              },
            },
          },
        },
      });
    });
    expect(
      afterChurn.find((step) => step.name === 'assertFinalTopologyEffectsConverged'),
    ).toMatchObject({
      type: 'assert',
      expect: {
        body: {
          statuses: {
            one: 'SUCCESS',
            two: 'SUCCESS',
            three: 'SUCCESS',
            four: 'SUCCESS',
            five: 'SUCCESS',
          },
        },
      },
    });

    expect(recipeText).not.toContain('body.groupStateCausalRevision');
    expect(recipeText).not.toContain('body.groupPresenceCausalRevision');
    expect(recipeText).not.toContain('body.receipt.outboxId"');

    const receipts = afterChurn.find(
      (step) => step.name === 'assertFinalBoundedConvergenceAndCausalHistory',
    );
    expect(receipts).toMatchObject({
      type: 'assert',
      actual: expect.any(Object),
      expect: { body: expect.any(Object) },
    });
    expect((receipts?.actual as Record<string, unknown>).causalHistory).toEqual(expect.any(Object));
    expect((receipts?.expect as { missingActualValue?: unknown }).missingActualValue).toBe(
      'MISSING',
    );
    expect((receipts?.expect as { monotonicPaths?: unknown }).monotonicPaths).toEqual(
      expect.any(Array),
    );

    groupIds.forEach((groupId) => {
      const groupLabel = groupId
        .replace(/^group/, '')
        .replace(/Id$/, '')
        .toLowerCase();
      const groupIndex = groupIds.indexOf(groupId);
      const finalTopology = afterChurn.find(
        (step) => step.name === `finalReconfigure${groupLabel}Topology`,
      );
      expect((finalTopology?.request as { body?: Record<string, unknown> })?.body?.publish).toBe(
        true,
      );

      const observedEffect = topologyPollSteps.find(
        (step) => step.name === `observe${groupLabel}PublishedTopologyEffect{loop.iteration}`,
      );
      expect(observedEffect).toMatchObject({
        type: 'http',
        connection: apiConnections[groupIndex % apiConnections.length],
        request: {
          method: 'GET',
          path: expect.stringContaining('/topology'),
        },
      });
      expect(
        (observedEffect?.request as { outputs?: Record<string, unknown> })?.outputs,
      ).toHaveProperty(`observedGroup${groupId.slice(5, -2)}IdTopologySnapshotVersion`);
    });

    const receiptEffects = afterChurn.find(
      (step) => step.name === 'assertPublishedTopologyEffectsMatchReceipts',
    );
    expect(receiptEffects).toMatchObject({
      type: 'assert',
      actual: { receipts: expect.any(Object), observedEffects: expect.any(Object) },
      expect: { body: expect.any(Object) },
    });
    expect(receiptEffects?.actual).toMatchObject({
      receipts: {
        groupOneId: '{finalGroupOneIdTopologyOutboxIds}',
        groupTwoId: '{finalGroupTwoIdTopologyOutboxIds}',
        groupThreeId: '{finalGroupThreeIdTopologyOutboxIds}',
        groupFourId: '{finalGroupFourIdTopologyOutboxIds}',
        groupFiveId: '{finalGroupFiveIdTopologyOutboxIds}',
      },
    });
    expect(receiptEffects?.expect).toMatchObject({
      body: {
        receipts: {
          groupOneId: ['string'],
          groupTwoId: ['string'],
          groupThreeId: ['string'],
          groupFourId: ['string'],
          groupFiveId: ['string'],
        },
      },
    });
  });
});
