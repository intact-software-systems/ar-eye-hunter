import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
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
import { AL_TRACE_ID_PATTERN } from '@shared/al-contracts/trace/al-trace-id.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const PREFIX = 'alm-ws-server-originated';
const TRACE_LEFT = `${PREFIX}-sender-trace-left`;
const TRACE_ACTIVE = `${PREFIX}-sender-trace-active`;

function readServerOriginated(): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput('ws'))
        .find((candidate) => candidate.scenarioId === 'server-originated');
    if (scenario === undefined) {
        throw new Error('The ws cell builds no server-originated scenario.');
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

function toScenarioCommandIds(recipe: RallarBlackBoxTestRecipe, role: string): readonly string[] {
    return recipe.commands.map((command) => command.commandId!.replace(`${PREFIX}-${role}-`, ''));
}

describe('ALM server-originated cell', () => {
    it('runs over ws only, as a smoke cell of the two-agent family', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarioIds = createAlmConformanceRecipes(toConformanceInput(carrier)).map(({ scenarioId }) => scenarioId);
            expect(scenarioIds.includes('server-originated'), carrier).toBe(carrier === 'ws');
        }
        const scenario = readServerOriginated();
        expect(scenario).toMatchObject({ scenarioKey: 'server-originated', roles: ['sender', 'receiver'], laneFamily: 'two-agent' });
        expect(scenario.tags).toEqual(['smoke', 'full']);
    });

    it('leaves and rejoins under two distinct request traces in the trace grammar, each echo asserted', () => {
        const sender = readServerOriginated().sender;
        expect(toScenarioCommandIds(sender, 'sender')).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'storage-counters-connected',
            'leave-traced',
            'assert-leave-traced-echo',
            'rejoin-traced',
            'assert-rejoin-traced-echo',
            'stats'
        ]);
        const traced = [['leave-traced', 'left', TRACE_LEFT], ['rejoin-traced', 'active', TRACE_ACTIVE]] as const;
        for (const [name, status, traceId] of traced) {
            expect(traceId).toMatch(AL_TRACE_ID_PATTERN);
            expect(findCommand(sender, `${PREFIX}-sender-${name}`)).toMatchObject({
                kind: 'http.request',
                request: { method: 'PUT', headers: { 'x-request-id': traceId }, body: { status } },
                response: { body: 'json', acceptedStatusCodes: [200, 201] }
            });
            expect(findCommand(sender, `${PREFIX}-sender-assert-${name}-echo`)).toMatchObject({
                kind: 'assert',
                source: `resultCache.${PREFIX}-sender-${name}.value.headers.x-request-id`,
                operator: 'equals',
                expected: traceId
            });
        }
        expect(TRACE_LEFT).not.toBe(TRACE_ACTIVE);
    });

    it('observes each traced delta, holds one settle margin and reads the admin receipt entry', () => {
        const receiver = readServerOriginated().receiver;
        expect(toScenarioCommandIds(receiver, 'receiver')).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'delta-trace-left',
            'delta-trace-active',
            'receipt-settles',
            'read-admin-realtime',
            'assert-admin-receipt',
            'stats'
        ]);
        for (const [name, traceId] of [['delta-trace-left', TRACE_LEFT], ['delta-trace-active', TRACE_ACTIVE]] as const) {
            expect(findCommand(receiver, `${PREFIX}-receiver-${name}`)).toEqual({
                kind: 'wait',
                commandId: `${PREFIX}-receiver-${name}`,
                match: {
                    kind: 'message',
                    topic: 'rallar.browser.ws.message',
                    connection: 'receiver',
                    payloadFields: {
                        'data.topicId': 'group-state.event',
                        'data.traceId': traceId,
                        'data.payload.event.traceId': traceId
                    }
                },
                timeoutMs: 27_000
            });
        }
        expect(findCommand(receiver, `${PREFIX}-receiver-receipt-settles`)).toMatchObject({
            kind: 'wait',
            match: { kind: 'diagnostic' },
            absent: true,
            timeoutMs: 1_000
        });
        expect(findCommand(receiver, `${PREFIX}-receiver-read-admin-realtime`)).toMatchObject({
            kind: 'http.request',
            request: { method: 'GET', path: '/api/admin/operations/realtime' },
            response: { body: 'json', acceptedStatusCodes: [200] }
        });
        expect(findCommand(receiver, `${PREFIX}-receiver-assert-admin-receipt`)).toMatchObject({
            kind: 'assert',
            source: `resultCache.${PREFIX}-receiver-read-admin-realtime.value.body.almReceipts.diagnostics.messages`,
            operator: 'matchesShape',
            expected: [{ traceId: TRACE_ACTIVE, lastSettlementKind: 'acknowledgement' }]
        });
    });

    it('subscribes both connects to the group-state topic instead of the scenario channel', () => {
        const scenario = readServerOriginated();
        for (const [role, recipe] of [['sender', scenario.sender], ['receiver', scenario.receiver]] as const) {
            expect(findCommand(recipe, `${PREFIX}-${role}-connect`)).toMatchObject({
                kind: 'rtc.connect',
                transport: 'messages.ws',
                rallar: { messageSelector: { topicId: 'group-state.event' } }
            });
        }
        const other = createAlmConformanceRecipes(toConformanceInput('ws')).find(({ scenarioId }) => scenarioId === 'server-command')!;
        const connect = findCommand(other.receiver, 'alm-ws-server-command-receiver-connect');
        expect(connect.kind === 'rtc.connect' ? connect.rallar?.messageSelector : 'not a connect').toBeUndefined();
    });

    it('validates every command against the recipe schema and the control protocol', () => {
        const scenario = readServerOriginated();
        for (const recipe of [scenario.sender, scenario.receiver]) {
            const validated = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe);
            expect(validated.ok, validated.ok ? undefined : formatJsonSchemaValidationErrors(validated.errors)).toBe(true);
            for (const command of recipe.commands) {
                const accepted = validateRallarBlackBoxTestCommand(command);
                expect(accepted.ok, accepted.ok ? command.commandId : accepted.error).toBe(true);
            }
        }
    });
});
