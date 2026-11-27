import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;
/** Every cell's recipe ends on the page's stats. */
const EPILOGUE = ['stats'] as const;

/** Written by hand from the product's refusal, never read from the matrix: a cell that drifts from it fails here. */
const SERVER_PEER_REFUSAL = { path: '$.peerId', code: 'unsupported' } as const;

const CELL_CARRIERS: Readonly<Record<AlmConformanceCarrier, boolean>> = {
    ws: false,
    rtc: true,
    'rtc-with-ws-fallback': true
};

function findCell(carrier: AlmConformanceCarrier): AlmConformanceScenario | undefined {
    return createAlmConformanceRecipes(toConformanceInput(carrier))
        .find(({ scenarioId }) => scenarioId === 'server-command-refused-at-call');
}

function requireCell(carrier: AlmConformanceCarrier): AlmConformanceScenario {
    const cell = findCell(carrier);
    if (cell === undefined) {
        throw new Error(`The catalogue holds no server-command-refused-at-call over ${carrier}.`);
    }
    return cell;
}

function toCommandNames(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const prefix = `${recipe.recipeId}-`;
    return recipe.commands.map((command) => (command.commandId ?? '').replace(prefix, ''));
}

/** Runs the sender's body as the lane would, the page answering its one send with `answer`. */
async function runSenderBody(recipe: RallarBlackBoxTestRecipe, answer: object): Promise<boolean> {
    const body = recipe.commands.filter((command) => command.kind === 'messages.send' || command.kind === 'assert');
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: (command) => command.kind === 'messages.send' ? { status: 'ok', value: answer } : undefined
    });
    return (await runtime.execute({ kind: 'recipe.run', recipe: { ...recipe, commands: body } })).ok;
}

describe('the server command refused at its call', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('is catalogued over %s exactly where the product refuses the call', (carrier) => {
        expect(findCell(carrier) !== undefined).toBe(CELL_CARRIERS[carrier]);
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)('runs over %s in the full scope on the addressed agents', (carrier) => {
        const { laneFamily, roles, tags } = requireCell(carrier);

        expect({ laneFamily, roles, tags }).toEqual({ laneFamily: 'addressed', roles: ['sender', 'receiver'], tags: ['full'] });
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)('sends to the server over %s observing the refusal, then asserts it, and nothing else', (carrier) => {
        const { sender, receiver } = requireCell(carrier);
        const send = sender.commands.find((command) => command.kind === 'messages.send');

        expect(toCommandNames(sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'send-1',
            'assert-one-issue-1',
            'assert-issue-path-1',
            'assert-issue-code-1',
            ...EPILOGUE
        ]);
        expect(send).toMatchObject({ carrier, toPeer: 'server', observe: 'call-refused' });
        expect(toCommandNames(receiver)).toEqual([...PROLOGUE, ...EPILOGUE]);
        expect([...sender.commands, ...receiver.commands].filter((command) => !validateRallarBlackBoxTestCommand(command).ok)).toEqual([]);
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)('passes over %s only on the one issue the product refuses the call with', async (carrier) => {
        const { sender } = requireCell(carrier);
        const refusal = { handleId: 'h', carrier, callRefusal: [SERVER_PEER_REFUSAL] };

        expect(await runSenderBody(sender, refusal)).toBe(true);
        expect(await runSenderBody(sender, { ...refusal, callRefusal: [{ ...SERVER_PEER_REFUSAL, code: 'invalid-scope' }] })).toBe(false);
        expect(await runSenderBody(sender, { ...refusal, callRefusal: [{ ...SERVER_PEER_REFUSAL, path: '$.scope' }] })).toBe(false);
        expect(await runSenderBody(sender, { ...refusal, callRefusal: [SERVER_PEER_REFUSAL, SERVER_PEER_REFUSAL] })).toBe(false);
        expect(
            await runSenderBody(sender, {
                handleId: 'h',
                msgId: 'msg-1',
                carrier,
                status: 'acknowledged',
                traceId: 'trace-1',
                corrId: 'msg-1'
            })
        ).toBe(false);
    });
});
