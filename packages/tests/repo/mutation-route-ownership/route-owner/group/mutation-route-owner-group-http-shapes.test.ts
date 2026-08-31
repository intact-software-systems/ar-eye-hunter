import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { expect } from 'vitest';

import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from '../../routing/mutation-routing-inventory.ts';
import { readFlexibleAnchor } from '../mutation-route-owner-anchors.ts';

const MEMBERSHIP_ROUTES = 'apps/api-v1/src/group-state/register-group-membership-routes.ts';
const PRESENCE_ROUTES = 'apps/api-v1/src/group-state/register-group-presence-routes.ts';
const COMMAND_TRANSLATOR = 'apps/api-v1/src/group-state/to-group-state-command.ts';
const CONNECT_OWNER = `function registerConnectGroupPresenceRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {`;
const PRESENCE_FAMILY = `export function registerGroupPresenceRoutes(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {`;
const REMOVE_HANDLER = `  app.post(
    \`\${GROUP_MEMBER_PATH}/remove/requests/:requestId\`,
    async (context) => {`;

describe('group HTTP mutation route source shapes', () => {
    it('rejects an operation overridden by a later command-object spread', () => {
        const source = readFileSync(MEMBERSHIP_ROUTES, 'utf8');
        const mutated = spliceReplace(
            source,
            '              operation: \'remove-group-member\',',
            `              operation: 'remove-group-member',
              ...JSON.parse('{"operation":"ban-group-member"}'),`
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects an operation overridden by a computed command-object property', () => {
        const source = readFileSync(MEMBERSHIP_ROUTES, 'utf8');
        const mutated = spliceReplace(
            source,
            '              operation: \'remove-group-member\',',
            '              operation: \'remove-group-member\',\n              [\'operation\']: \'ban-group-member\','
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects duplicate direct operation properties in the command object', () => {
        const source = readFileSync(MEMBERSHIP_ROUTES, 'utf8');
        const mutated = spliceReplace(
            source,
            '              operation: \'remove-group-member\',',
            '              operation: \'remove-group-member\',\n              operation: \'ban-group-member\','
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects an AppInbox type overridden by a later result-object spread', () => {
        const source = readFileSync(COMMAND_TRANSLATOR, 'utf8');
        const mutated = spliceReplace(
            source,
            '    type: AppInboxType.GROUP_MEMBER_REMOVE,',
            `    type: AppInboxType.GROUP_MEMBER_REMOVE,
    ...JSON.parse('{"type":"GROUP_MEMBER_BAN"}'),`
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects an AppInbox type overridden by a computed result-object property', () => {
        const source = readFileSync(COMMAND_TRANSLATOR, 'utf8');
        const mutated = spliceReplace(
            source,
            '    type: AppInboxType.GROUP_MEMBER_REMOVE,',
            '    type: AppInboxType.GROUP_MEMBER_REMOVE,\n    [\'type\']: AppInboxType.GROUP_MEMBER_BAN,'
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects duplicate direct AppInbox type properties in the result object', () => {
        const source = readFileSync(COMMAND_TRANSLATOR, 'utf8');
        const mutated = spliceReplace(
            source,
            '    type: AppInboxType.GROUP_MEMBER_REMOVE,',
            `    type: AppInboxType.GROUP_MEMBER_REMOVE,
    type: AppInboxType.GROUP_MEMBER_BAN,`
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects a second exact registration in the exported family registrar', () => {
        const source = readFileSync(PRESENCE_ROUTES, 'utf8');
        const mutated = spliceAt(
            source,
            PRESENCE_FAMILY,
            '  app.put(GROUP_PRESENCE_PATH, async () => new Response(null));'
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('registration is absent')])
        );
    });

    it('rejects a removed private-owner call from the exported family registrar', () => {
        const source = readFileSync(PRESENCE_ROUTES, 'utf8');
        const mutated = spliceReplace(
            source,
            '  registerConnectGroupPresenceRoute(app, dependencies, authorization);\n',
            ''
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('registration is absent')])
        );
    });

    it('rejects a conditional private-owner call in the exported family registrar', () => {
        const source = readFileSync(PRESENCE_ROUTES, 'utf8');
        const mutated = spliceReplace(
            source,
            '  registerConnectGroupPresenceRoute(app, dependencies, authorization);',
            '  if (false) registerConnectGroupPresenceRoute(app, dependencies, authorization);'
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('registration is absent')])
        );
    });

    it('rejects a private-owner call after a family-registrar return', () => {
        const source = readFileSync(PRESENCE_ROUTES, 'utf8');
        const mutated = spliceReplace(
            source,
            '  registerConnectGroupPresenceRoute(app, dependencies, authorization);',
            '  return;\n  registerConnectGroupPresenceRoute(app, dependencies, authorization);'
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('registration is absent')])
        );
    });

    it('rejects a duplicate private-owner call in the exported family registrar', () => {
        const source = readFileSync(PRESENCE_ROUTES, 'utf8');
        const call = '  registerConnectGroupPresenceRoute(app, dependencies, authorization);';
        const mutated = source.replace(call, `${call}\n${call}`);
        expect(mutated).not.toBe(source);

        expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('registration is absent')])
        );
    });

    it('rejects an exact registration inside a literal-false owner branch', () => {
        const source = readFileSync(PRESENCE_ROUTES, 'utf8');
        const wrongLiveRoute = spliceReplace(
            source,
            '`${GROUP_PRESENCE_PATH}/requests/:requestId`,',
            '      `${GROUP_PRESENCE_PATH}/wrong`,'
        );
        const mutated = spliceAt(
            wrongLiveRoute,
            CONNECT_OWNER,
            '  if (false) {\n    app.put(\n      GROUP_PRESENCE_PATH,\n      async (context) =>\n        toGroupStateCommand({\n          operation: \'connect-group-presence\',\n          authSession: context,\n        }),\n    );\n  }'
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('registration is absent')])
        );
    });

    it('rejects an exact registration after an unconditional owner return', () => {
        const source = readFileSync(PRESENCE_ROUTES, 'utf8');
        const mutated = spliceAt(
            source,
            CONNECT_OWNER,
            '  return;'
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(PRESENCE_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('registration is absent')])
        );
    });

    it('rejects a correct handoff found only in an uninvoked nested handler function', () => {
        const mutated = spliceAt(
            withWrongLiveRemoveTranslation(),
            REMOVE_HANDLER,
            '      function deadCorrectRemoveTranslation() {\n        return toGroupStateCommand({ operation: \'remove-group-member\' });\n      }'
        );
        expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));

        expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects a correct handoff found only in a literal-false handler branch', () => {
        const mutated = spliceAt(
            withWrongLiveRemoveTranslation(),
            REMOVE_HANDLER,
            '      if (false) {\n        dependencies.processGroupAppInbox(\n          authSession,\n          toGroupStateCommand({ operation: \'remove-group-member\' }),\n        );\n      }'
        );
        expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));

        expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects a correct handoff found only after the handler return', () => {
        const mutated = withWrongLiveRemoveTranslation().replace(
            '        return context.json(written.snapshot);',
            `        return context.json(written.snapshot);\n        await dependencies.processGroupAppInbox(\n          authSession,\n          toGroupStateCommand({ operation: 'remove-group-member' }),\n        );`
        );
        expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));

        expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects a separately bound command declared after its submission', () => {
        const source = readFileSync(MEMBERSHIP_ROUTES, 'utf8');
        const commandDeclaration = `        const command = toGroupStateCommand({
          operation: 'upsert-group-member',
          authSession,
          scope,
          groupId,
          principalId,
          request,
        });
`;
        const declaredCommand = readFlexibleAnchor(source, commandDeclaration);
        const submission = readFlexibleAnchor(
            source,
            `written: await dependencies.processGroupAppInbox(authSession, command)
});`
        );
        const mutated = source
            .replace(declaredCommand, '')
            .replace(submission, `${submission}\n${declaredCommand}`);
        expect(mutated).not.toBe(source);

        expect(validateOverride(MEMBERSHIP_ROUTES, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects an expected translator type found only in a literal-false branch', () => {
        const source = withWrongRemoveTranslatorType();
        const mutated = spliceReplace(
            source,
            '  const request = withActor(input);\n  const issues = validateGroupMutationRequest(\'removeGroupMember\', request);',
            '  if (false) AppInboxType.GROUP_MEMBER_REMOVE;\n  const request = withActor(input);\n  const issues = validateGroupMutationRequest(\'removeGroupMember\', request);'
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects an expected translator type found only in an uninvoked nested helper', () => {
        const source = withWrongRemoveTranslatorType();
        const mutated = spliceReplace(
            source,
            '  const request = withActor(input);\n  const issues = validateGroupMutationRequest(\'removeGroupMember\', request);',
            '  function deadExpectedType() { return AppInboxType.GROUP_MEMBER_REMOVE; }\n  const request = withActor(input);\n  const issues = validateGroupMutationRequest(\'removeGroupMember\', request);'
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('rejects an expected translator type found only after its helper return', () => {
        const source = withWrongRemoveTranslatorType();
        const mutated = spliceReplace(
            source,
            '  };\n}\n\nfunction toBanGroupMemberCommand(',
            '  };\n  AppInboxType.GROUP_MEMBER_REMOVE;\n}\n\nfunction toBanGroupMemberCommand('
        );
        expect(mutated).not.toBe(source);

        expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it.each(['true', '!false', '1', 'true || input.request', 'alwaysReject'])('rejects an unconditional throwing translator guard: %s', (condition) => {
        const source = readFileSync(COMMAND_TRANSLATOR, 'utf8');
        const mutated = spliceReplace(
            source,
            'const request = withActor(input);\nconst issues = validateGroupMutationRequest(\'removeGroupMember\', request);',
            `const alwaysReject = true;\nif (${condition}) { throw new Error('unconditional rejection'); }\n` +
                'const request = withActor(input);\nconst issues = validateGroupMutationRequest(\'removeGroupMember\', request);'
        );

        expect(mutated).not.toBe(source);
        expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual(
            expect.arrayContaining([expect.stringContaining('operation is not connected')])
        );
    });

    it('accepts legitimate input rejection guards and an unreachable throwing branch', () => {
        const source = readFileSync(COMMAND_TRANSLATOR, 'utf8');
        const mutated = spliceReplace(
            source,
            'const request = withActor(input);\nconst issues = validateGroupMutationRequest(\'removeGroupMember\', request);',
            'if (false) { throw new Error(\'unreachable rejection\'); }\n' +
                'const request = withActor(input);\nconst issues = validateGroupMutationRequest(\'removeGroupMember\', request);'
        );

        expect(validateOverride(COMMAND_TRANSLATOR, source)).toEqual([]);
        expect(mutated).not.toBe(source);
        expect(validateOverride(COMMAND_TRANSLATOR, mutated)).toEqual([]);
    });
});

// Splices immediately after a construct located by meaning rather than layout.
function spliceAt(source: string, fragment: string, insertion: string): string {
    const anchor = readFlexibleAnchor(source, fragment);
    return source.replace(anchor, `${anchor}\n${insertion}`);
}

// Rewrites a construct located the same way, so the replacement text sets the new layout.
function spliceReplace(source: string, fragment: string, replacement: string): string {
    return source.replace(readFlexibleAnchor(source, fragment), replacement);
}

function withWrongLiveRemoveTranslation(): string {
    return spliceReplace(
        readFileSync(MEMBERSHIP_ROUTES, 'utf8'),
        'toGroupStateCommand({\n   operation: \'remove-group-member\',',
        'toWrongGroupStateCommand({\n   operation: \'remove-group-member\','
    );
}

function withWrongRemoveTranslatorType(): string {
    return spliceReplace(
        readFileSync(COMMAND_TRANSLATOR, 'utf8'),
        'type: AppInboxType.GROUP_MEMBER_REMOVE,',
        '   type: AppInboxType.GROUP_MEMBER_BAN,'
    );
}

function validateOverride(filePath: string, source: string): readonly string[] {
    return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[filePath, source]])
    });
}
