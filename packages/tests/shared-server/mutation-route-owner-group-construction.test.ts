import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';

const ROOT_ROUTES = 'apps/api-v1/src/group-state/register-group-state-routes.ts';
const PRESENCE_ROUTES = 'apps/api-v1/src/group-state/register-group-presence-routes.ts';
const ROOT_PRESENCE_CALL =
  '  registerGroupPresenceRoutes(app, resolvedDependencies, authorization);';
const PRIVATE_PRESENCE_CALL =
  '  registerConnectGroupPresenceRoute(app, dependencies, authorization);';

describe('group HTTP mutation route construction', () => {
  it('rejects a canonical family name rebound to a different imported family', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source
      .replace(
        "import { registerGroupMembershipRoutes } from './register-group-membership-routes.ts';\n",
        '',
      )
      .replace(
        "import { registerGroupPresenceRoutes } from './register-group-presence-routes.ts';",
        `import {
  registerGroupPresenceRoutes,
  registerGroupPresenceRoutes as registerGroupMembershipRoutes,
} from './register-group-presence-routes.ts';`,
      );
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects an uninventoryed live private owner and route in a family', () => {
    const source = readFileSync(PRESENCE_ROUTES, 'utf8');
    const mutated = source.replace(
      PRIVATE_PRESENCE_CALL,
      `${PRIVATE_PRESENCE_CALL}\n  registerUnexpectedGroupRoute(app);`,
    ).concat(`
function registerUnexpectedGroupRoute(app: Hono): void {
  app.get('/api/state/unexpected-group-route', async () => new Response(null));
}
`);
    expectInvalid(PRESENCE_ROUTES, source, mutated);
  });

  it('rejects a family removed from the exported root', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source.replace(
      '  registerGroupMembershipRoutes(app, resolvedDependencies, authorization);\n',
      '',
    );
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects a conditional family call in the exported root', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source.replace(
      ROOT_PRESENCE_CALL,
      `  if (false) registerGroupPresenceRoutes(app, resolvedDependencies, authorization);`,
    );
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects a duplicate family call in the exported root', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source.replace(
      ROOT_PRESENCE_CALL,
      `${ROOT_PRESENCE_CALL}\n${ROOT_PRESENCE_CALL}`,
    );
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects a family call after an exported-root return', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source.replace(ROOT_PRESENCE_CALL, `  return;\n${ROOT_PRESENCE_CALL}`);
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects wrong root-to-family arguments', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source.replace(
      ROOT_PRESENCE_CALL,
      '  registerGroupPresenceRoutes(undefined, resolvedDependencies, authorization);',
    );
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects reordered root-to-family arguments', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source.replace(
      ROOT_PRESENCE_CALL,
      '  registerGroupPresenceRoutes(resolvedDependencies, app, authorization);',
    );
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects an extra root-to-family argument', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source.replace(
      ROOT_PRESENCE_CALL,
      '  registerGroupPresenceRoutes(app, resolvedDependencies, authorization, app);',
    );
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects a family call before resolved dependencies and authorization exist', () => {
    const source = readFileSync(ROOT_ROUTES, 'utf8');
    const mutated = source.replace(
      '  const resolvedDependencies = createGroupStateRouteDependencies(dependencies);',
      `${ROOT_PRESENCE_CALL.trim()}\n  const resolvedDependencies = createGroupStateRouteDependencies(dependencies);`,
    );
    expectInvalid(ROOT_ROUTES, source, mutated);
  });

  it('rejects a different app passed from a family to its private owner', () => {
    const source = readFileSync(PRESENCE_ROUTES, 'utf8');
    const mutated = source.replace(
      PRIVATE_PRESENCE_CALL,
      '  registerConnectGroupPresenceRoute(undefined, dependencies, authorization);',
    );
    expectInvalid(PRESENCE_ROUTES, source, mutated);
  });

  it('rejects reordered family-to-private-owner arguments', () => {
    const source = readFileSync(PRESENCE_ROUTES, 'utf8');
    const mutated = source.replace(
      PRIVATE_PRESENCE_CALL,
      '  registerConnectGroupPresenceRoute(dependencies, app, authorization);',
    );
    expectInvalid(PRESENCE_ROUTES, source, mutated);
  });

  it('rejects a missing family-to-private-owner argument', () => {
    const source = readFileSync(PRESENCE_ROUTES, 'utf8');
    const mutated = source.replace(
      PRIVATE_PRESENCE_CALL,
      '  registerConnectGroupPresenceRoute(app, dependencies);',
    );
    expectInvalid(PRESENCE_ROUTES, source, mutated);
  });

  it('rejects an extra family-to-private-owner argument', () => {
    const source = readFileSync(PRESENCE_ROUTES, 'utf8');
    const mutated = source.replace(
      PRIVATE_PRESENCE_CALL,
      '  registerConnectGroupPresenceRoute(app, dependencies, authorization, app);',
    );
    expectInvalid(PRESENCE_ROUTES, source, mutated);
  });
});

function expectInvalid(filePath: string, source: string, mutated: string): void {
  expect(mutated).not.toBe(source);
  expect(
    validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
      sourceOverrides: new Map([[filePath, mutated]]),
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining('registration is absent')]));
}
