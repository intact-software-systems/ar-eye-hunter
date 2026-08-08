import { describe, expect, it } from 'vitest';

import {
  toFlatApiV1RecipeSteps as flattenRecipeSteps,
  readApiV1Matrix as readMatrix,
  readApiV1Recipe as readRecipe,
} from './api-v1-recipe-test-fixture.ts';

describe('API-v1 three-server recipe semantics', () => {
  it('requires the tertiary HTTP service for every built-in Postgres cluster recipe', () => {
    const { entries } = readMatrix();
    const clusterRecipeIds = [
      'api-v1-state-read-convergence',
      'api-v1-rtc-topology-convergence',
      'api-v1-state-topology-churn',
      'api-v1-state-write-convergence',
      'api-v1-crdt-app-inbox',
      'api-v1-state-medium-scale-churn',
    ];

    for (const recipeId of clusterRecipeIds) {
      const entry = entries.find((candidate) => candidate.id === recipeId);
      expect(
        entry?.requires?.httpServices?.map((service) => service.env),
        recipeId,
      ).toEqual([
        'RALLAR_API_BASE_URL',
        'RALLAR_API_BASE_URL_SECONDARY',
        'RALLAR_API_BASE_URL_TERTIARY',
      ]);
    }
  });

  it('defines a no-browser three-server topology convergence recipe', () => {
    const { entries } = readMatrix();
    const entry = entries.find((candidate) => candidate.id === 'api-v1-rtc-topology-convergence');

    expect(entry).toMatchObject({
      category: 'api-v1-black-box',
      mode: 'run',
      expectedExitCode: 0,
      profiles: ['api-v1-black-box-cluster'],
      requires: {
        httpServices: [
          {
            name: 'Rallar API primary',
            env: 'RALLAR_API_BASE_URL',
            default: 'http://127.0.0.1:18080',
          },
          {
            name: 'Rallar API secondary',
            env: 'RALLAR_API_BASE_URL_SECONDARY',
            default: 'http://127.0.0.1:18081',
          },
          {
            name: 'Rallar API tertiary',
            env: 'RALLAR_API_BASE_URL_TERTIARY',
            default: 'http://127.0.0.1:18082',
          },
        ],
      },
    });
    expect(entry?.requires?.playwright).not.toBe(true);
    expect(entry?.profiles).not.toContain('api-v1-black-box-recipes');

    const recipe = readRecipe(entry!.recipe);
    const connections = recipe.connections as Record<string, { type?: string }>;
    expect(
      Object.values(connections).filter((connection) => connection.type === 'http'),
    ).toHaveLength(3);
    expect(
      Object.values(connections).filter((connection) => connection.type === 'ws'),
    ).toHaveLength(2);
    expect(connections.wsTertiary).toMatchObject({ type: 'ws' });
    expect(Object.values(connections).some((connection) => connection.type === 'rtc')).toBe(false);
    expect(JSON.stringify(recipe)).not.toContain('rallar-browser');
    expect(JSON.stringify(recipe)).not.toContain('RTCPeerConnection');
    expect(
      (recipe.steps as Array<{ type?: string }>).some((step) => step.type === 'parallel'),
    ).toBe(true);
    const allSteps = flattenRecipeSteps(recipe.steps as Array<Record<string, unknown>>);
    expect(allSteps.find((step) => step.name === 'updateGroupThroughSecondary')).toMatchObject({
      connection: 'apiSecondary',
    });
    expect(allSteps.find((step) => step.name === 'waitForBothRevisionsOnTertiary')).toMatchObject({
      type: 'ws.wait',
      connection: 'wsTertiary',
    });
  });

  it('defines bounded three-server multi-client and multi-group churn coverage', () => {
    const { entries } = readMatrix();
    const entry = entries.find((candidate) => candidate.id === 'api-v1-state-topology-churn');

    expect(entry).toMatchObject({
      category: 'api-v1-black-box',
      mode: 'run',
      expectedExitCode: 0,
      profiles: ['api-v1-black-box-cluster'],
    });
    expect(entry?.requires?.playwright).not.toBe(true);

    const recipe = readRecipe(entry!.recipe);
    const parallel = (recipe.steps as Array<Record<string, unknown>>).find(
      (step) => step.name === 'runConcurrentClientChurn',
    ) as {
      type?: string;
      groups?: Array<{ steps?: Array<Record<string, unknown>> }>;
    };
    expect(parallel.type).toBe('parallel');
    expect(parallel.groups).toHaveLength(3);
    expect(
      parallel.groups?.map((group) => {
        const loop = group.steps?.find((step) => step.type === 'loop');
        return loop?.count;
      }),
    ).toEqual([4, 4, 4]);
    expect(
      parallel.groups?.map((group) => {
        const steps = flattenRecipeSteps(group.steps ?? []);
        return new Set(steps.map((step) => step.connection).filter(Boolean));
      }),
    ).toEqual([new Set(['apiPrimary']), new Set(['apiSecondary']), new Set(['apiTertiary'])]);
    const finalReads = (recipe.steps as Array<Record<string, unknown>>)
      .filter((step) => String(step.name).startsWith('read'))
      .filter((step) => String((step.request as { path?: string })?.path).includes('/groups/'));
    expect(new Set(finalReads.map((step) => step.connection))).toEqual(
      new Set(['apiPrimary', 'apiTertiary']),
    );
    expect(JSON.stringify(recipe)).toContain('disconnect');
    expect(JSON.stringify(recipe)).toContain('topology/reconfigure');
  });

  it('uses the secondary auth boundary and tertiary fanout and catch-up for CRDT', () => {
    const recipe = readRecipe('tests/api-v1/api-v1-crdt-app-inbox.json');
    const steps = recipe.steps as Array<Record<string, unknown>>;

    expect(steps.find((step) => step.name === 'loginCrdtReader')).toMatchObject({
      connection: 'apiSecondary',
    });
    expect(steps.find((step) => step.name === 'appendCrdtUpdateThroughPrimary')).toMatchObject({
      connection: 'wsPrimary',
    });
    expect(steps.find((step) => step.name === 'observeDurableFanoutOnTertiary')).toMatchObject({
      connection: 'wsTertiary',
    });
    expect(steps.find((step) => step.name === 'readCommittedCrdtThroughTertiary')).toMatchObject({
      connection: 'apiTertiary',
    });
  });
});
