import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { formatJsonSchemaValidationErrors, validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const PREFIX = 'alm-ws-server-ordered-entry';

function readServerOrderedEntry(): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput('ws'))
        .find((candidate) => candidate.scenarioId === 'server-ordered-entry');
    if (scenario === undefined) {
        throw new Error('The ws cell builds no server-ordered-entry scenario.');
    }
    return scenario;
}

function findCommand(recipe: RallarBlackBoxTestRecipe, commandId: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find((candidate) => candidate.commandId === commandId);
    if (command === undefined) {
        throw new Error(`Missing ${commandId}.`);
    }
    return command;
}

describe('ALM server-ordered-entry cell', () => {
    it('runs over ws only, as a full cell of the same-principal family', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarioIds = createAlmConformanceRecipes(toConformanceInput(carrier)).map(({ scenarioId }) => scenarioId);
            expect(scenarioIds.includes('server-ordered-entry'), carrier).toBe(carrier === 'ws');
        }
        const scenario = readServerOrderedEntry();
        expect(scenario).toMatchObject({
            scenarioKey: 'server-ordered-entry',
            roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
            laneFamily: 'same-principal'
        });
        expect(scenario.tags).toEqual(['full']);
        expect(findCommand(scenario.sibling!, `${PREFIX}-sibling-connect`)).toMatchObject({
            kind: 'rtc.connect',
            transport: 'messages.ws',
            rallar: { messageSelector: { topicId: 'client-state.event' } }
        });
    });

    it('writes the principal three times under distinct request ids', () => {
        const sender = readServerOrderedEntry().sender;
        const writes = sender.commands.flatMap((command) =>
            command.kind === 'http.request' && command.request.path?.includes('/principal/') === true ? [command.request.path] : []
        );
        expect(writes).toEqual(
            [1, 2, 3].map((n) => `/api/state/apps/app/workspaces/ws/clients/{auth.clientId}/principal/requests/${PREFIX}-sender-profile-${n}`)
        );
        for (const n of [1, 2, 3]) {
            expect(findCommand(sender, `${PREFIX}-sender-profile-${n}`)).toMatchObject({
                kind: 'http.request',
                request: {
                    method: 'PUT',
                    body: { username: '{auth.username}', displayName: `server-ordered-entry ${n}`, status: 'active', roles: ['black-box'] }
                },
                response: { body: 'json', acceptedStatusCodes: [200, 201] }
            });
            expect(findCommand(sender, `${PREFIX}-sender-profile-${n}-settles`)).toMatchObject({ kind: 'wait', absent: true, timeoutMs: 1_000 });
        }
    });

    it('waits on every page for the last write, its entry at prior 0 and no before-entry; the sender at seq 2 and the receiver on the sender principal track', () => {
        const scenario = readServerOrderedEntry();
        const expectations = [
            ['sender', scenario.sender, { track: true, seq: 2 }],
            ['sibling', scenario.sibling!, { track: false, seq: undefined }],
            ['receiver', scenario.receiver, { track: true, seq: undefined }]
        ] as const;
        for (const [role, recipe, entry] of expectations) {
            const names = ['last-write-arrived', 'entered', 'no-before-entry'].map((name) => `${PREFIX}-${role}-${name}`);
            expect(recipe.commands.slice(-4, -1).map(({ commandId }) => commandId), role).toEqual(names);
            const arrival = `resultCache.${names[0]}.value.event.payload`;
            expect(findCommand(recipe, names[0]!), role).toEqual({
                kind: 'wait',
                commandId: names[0],
                match: {
                    kind: 'message',
                    topic: 'rallar.browser.ws.message',
                    connection: role === 'sender' ? 'sender' : 'receiver',
                    payloadFields: {
                        'data.topicId': 'client-state.event',
                        'data.payload.principalId': 'principal-alice',
                        'data.payload.requestId': `${PREFIX}-sender-profile-3`
                    }
                },
                timeoutMs: 27_000
            });
            expect(findCommand(recipe, names[1]!), role).toEqual({
                kind: 'wait',
                commandId: names[1],
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.inbound_diagnostics',
                    payloadPath: 'data',
                    ...(entry.track ? { contains: `"trackKey":"{${arrival}.contextId}:{${arrival}.senderId}:` } : {}),
                    payloadFields: {
                        'data.kind': 'ordering-position',
                        'data.status': 'entered',
                        'data.priorSeq': 0,
                        ...(entry.seq === undefined ? {} : { 'data.seq': entry.seq })
                    }
                },
                timeoutMs: 27_000
            });
            expect(findCommand(recipe, names[2]!), role).toEqual({
                kind: 'wait',
                commandId: names[2],
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.inbound_diagnostics',
                    payloadPath: 'data',
                    payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'before-entry' }
                },
                absent: true,
                timeoutMs: 5_000
            });
        }
    });

    it('validates every command against the recipe schema and the control protocol', () => {
        const scenario = readServerOrderedEntry();
        for (const recipe of [scenario.sender, scenario.receiver, scenario.sibling!]) {
            const validated = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe);
            expect(validated.ok, validated.ok ? undefined : formatJsonSchemaValidationErrors(validated.errors)).toBe(true);
            for (const command of recipe.commands) {
                const accepted = validateRallarBlackBoxTestCommand(command);
                expect(accepted.ok, accepted.ok ? command.commandId : accepted.error).toBe(true);
            }
        }
    });
});
