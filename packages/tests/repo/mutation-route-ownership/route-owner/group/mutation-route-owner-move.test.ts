import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from '../../routing/mutation-routing-inventory.ts';

const ROUTES = 'apps/api-v1/src/group-state/register-group-move-routes.ts';
const ROOT = 'apps/api-v1/src/group-state/register-group-state-routes.ts';
const INBOX = 'packages/shared-server/rallar-system/group-state/move/group-move-inbox.ts';

describe('Move together mutation ownership', () => {
    it('traces HTTP admission and durable deadline expiry to their AppInbox owners', () => {
        expect(MUTATION_ROUTE_INVENTORY.filter((entry) => entry.type.startsWith('GROUP_MOVE')).map((entry) => entry.type))
            .toEqual(['GROUP_MOVE', 'GROUP_MOVE_EXPIRE']);
        expect(validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY)).toEqual([]);
    });

    it.each([
        { name: 'missing root', file: ROOT, before: 'registerGroupMoveRoutes(app, dependencies);', after: '' },
        { name: 'wrong mutation method', file: ROUTES, before: 'app.post(', after: 'app.put(' },
        { name: 'wrong read method', file: ROUTES, before: 'app.get(', after: 'app.head(' },
        { name: 'wrong path', file: ROUTES, before: 'group-moves\';', after: 'other-moves\';' },
        {
            name: 'dynamic path',
            file: ROUTES,
            before: 'const path = \'/api/state/apps/:applicationId/workspaces/:workspaceId/group-moves\';',
            after: 'const path = getPath();'
        },
        { name: 'conditional registration', file: ROUTES, before: 'app.post(', after: 'if (false) app.post(' },
        { name: 'unreachable registration', file: ROUTES, before: 'app.post(', after: 'return; app.post(' },
        { name: 'extra route', file: ROUTES, before: '    app.get(path,', after: '    app.get(\'/extra\', async () => new Response());\n    app.get(path,' },
        { name: 'disconnected handoff', file: ROUTES, before: 'dependencies.processGroupMove(', after: 'dependencies.unrelatedOperation(' },
        {
            name: 'wrong inbox dispatch',
            file: INBOX,
            before: 'type: AppInboxType.GROUP_MOVE,\n        decodeCommand:',
            after: 'type: AppInboxType.GROUP_MOVE_EXPIRE,\n        decodeCommand:'
        }
    ])('rejects $name', ({ file, before, after }) => {
        const source = readFileSync(file, 'utf8');
        const changed = source.replace(before, after);
        expect(changed).not.toBe(source);
        expect(validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, { sourceOverrides: new Map([[file, changed]]) }))
            .toEqual(expect.arrayContaining([expect.stringContaining('GROUP_MOVE')]));
    });
});
