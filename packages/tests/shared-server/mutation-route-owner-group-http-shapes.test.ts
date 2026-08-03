import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';

const MEMBERSHIP_ROUTES = 'apps/api-v1/src/group-state/register-group-membership-routes.ts';
const PRESENCE_ROUTES = 'apps/api-v1/src/group-state/register-group-presence-routes.ts';
const COMMAND_TRANSLATOR = 'apps/api-v1/src/group-state/to-group-state-command.ts';
const CONNECT_OWNER = `function registerConnectGroupPresenceRoute(
  app: Hono,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {`;
const REMOVE_HANDLER = `  app.post(
    \`\${GROUP_MEMBER_PATH}/remove\`,
    async (context) => {`;

describe('group HTTP mutation route source shapes', () => {
  it('rejects an exact registration inside a literal-false owner branch', () => {
    const source = readFileSync(PRESENCE_ROUTES, 'utf8');
    const wrongLiveRoute = source.replace(
      '    GROUP_PRESENCE_PATH,',
      '    `${GROUP_PRESENCE_PATH}/wrong`,',
    );
    const mutated = wrongLiveRoute.replace(
      `${CONNECT_OWNER}\n  app.put(`,
      `${CONNECT_OWNER}\n  if (false) {\n    app.put(\n      GROUP_PRESENCE_PATH,\n      async (context) =>\n        toGroupStateCommand({\n          operation: 'connect-group-presence',\n          authSession: context,\n        }),\n    );\n  }\n  app.put(`,
    );
    expect(mutated).not.toBe(source);

    expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
      expect.arrayContaining([expect.stringContaining('registration is absent')]),
    );
  });

  it('rejects an exact registration after an unconditional owner return', () => {
    const source = readFileSync(PRESENCE_ROUTES, 'utf8');
    const mutated = source.replace(
      `${CONNECT_OWNER}\n  app.put(`,
      `${CONNECT_OWNER}\n  return;\n  app.put(`,
    );
    expect(mutated).not.toBe(source);

    expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
      expect.arrayContaining([expect.stringContaining('registration is absent')]),
    );
  });

  it('rejects a correct handoff found only in an uninvoked nested handler function', () => {
    const mutated = withWrongLiveRemoveTranslation().replace(
      REMOVE_HANDLER,
      `${REMOVE_HANDLER}\n      function deadCorrectRemoveTranslation() {\n        return toGroupStateCommand({ operation: 'remove-group-member' });\n      }`,
    );
    expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));

    expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
      expect.arrayContaining([expect.stringContaining('operation is not connected')]),
    );
  });

  it('rejects a correct handoff found only in a literal-false handler branch', () => {
    const mutated = withWrongLiveRemoveTranslation().replace(
      `${REMOVE_HANDLER}\n      try {`,
      `${REMOVE_HANDLER}\n      if (false) {\n        dependencies.processGroupAppInbox(\n          authSession,\n          toGroupStateCommand({ operation: 'remove-group-member' }),\n        );\n      }\n      try {`,
    );
    expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));

    expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
      expect.arrayContaining([expect.stringContaining('operation is not connected')]),
    );
  });

  it('rejects a correct handoff found only after the handler return', () => {
    const mutated = withWrongLiveRemoveTranslation().replace(
      '        return context.json(written.snapshot);',
      `        return context.json(written.snapshot);\n        await dependencies.processGroupAppInbox(\n          authSession,\n          toGroupStateCommand({ operation: 'remove-group-member' }),\n        );`,
    );
    expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));

    expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
      expect.arrayContaining([expect.stringContaining('operation is not connected')]),
    );
  });

  it('rejects an expected translator type found only in a literal-false branch', () => {
    const source = withWrongRemoveTranslatorType();
    const mutated = source.replace(
      "  const request = withActor(input);\n  validateGroupMutationRequest('removeGroupMember', request);",
      "  if (false) AppInboxType.GROUP_MEMBER_REMOVE;\n  const request = withActor(input);\n  validateGroupMutationRequest('removeGroupMember', request);",
    );
    expect(mutated).not.toBe(source);

    expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
      expect.arrayContaining([expect.stringContaining('operation is not connected')]),
    );
  });

  it('rejects an expected translator type found only in an uninvoked nested helper', () => {
    const source = withWrongRemoveTranslatorType();
    const mutated = source.replace(
      "  const request = withActor(input);\n  validateGroupMutationRequest('removeGroupMember', request);",
      "  function deadExpectedType() { return AppInboxType.GROUP_MEMBER_REMOVE; }\n  const request = withActor(input);\n  validateGroupMutationRequest('removeGroupMember', request);",
    );
    expect(mutated).not.toBe(source);

    expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
      expect.arrayContaining([expect.stringContaining('operation is not connected')]),
    );
  });

  it('rejects an expected translator type found only after its helper return', () => {
    const source = withWrongRemoveTranslatorType();
    const mutated = source.replace(
      '  };\n}\n\nfunction toBanGroupMemberCommand(',
      '  };\n  AppInboxType.GROUP_MEMBER_REMOVE;\n}\n\nfunction toBanGroupMemberCommand(',
    );
    expect(mutated).not.toBe(source);

    expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
      expect.arrayContaining([expect.stringContaining('operation is not connected')]),
    );
  });
});

function withWrongLiveRemoveTranslation(): string {
  return readFileSync(MEMBERSHIP_ROUTES, 'utf8').replace(
    "toGroupStateCommand({\n              operation: 'remove-group-member'",
    "toWrongGroupStateCommand({\n              operation: 'remove-group-member'",
  );
}

function withWrongRemoveTranslatorType(): string {
  return readFileSync(COMMAND_TRANSLATOR, 'utf8').replace(
    '    type: AppInboxType.GROUP_MEMBER_REMOVE,',
    '    type: AppInboxType.GROUP_MEMBER_BAN,',
  );
}

function validateOverride(filePath: string, source: string): readonly string[] {
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[filePath, source]]),
  });
}
