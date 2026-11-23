import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

interface CueDeparture {
    readonly cell: string;
    readonly cue: RallarBlackBoxTestMessagesSendCommand;
    /** The commands between the cue's send and the page's departure. */
    readonly between: readonly RallarBlackBoxTestCommand[];
}

function toCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.flatMap((command) =>
        command.kind === 'loop'
            ? [command, ...toCommands(command.commands)]
            : command.kind === 'parallel'
            ? [command, ...command.groups.flatMap((group) => toCommands(group.commands))]
            : [command]
    );
}

function isCueSend(command: RallarBlackBoxTestCommand): command is RallarBlackBoxTestMessagesSendCommand {
    return command.kind === 'messages.send' && /-cue-/u.test(command.commandId ?? '') &&
        !/-cue-listen$/u.test(command.commandId ?? '');
}

/** The sending page closes, reloads or drops its socket, which ends the session the cue's admission needs. */
function isDeparture(command: RallarBlackBoxTestCommand): boolean {
    return command.kind === 'close' || command.kind === 'agent.reload' || command.kind === 'ws.close' ||
        (command.kind === 'fault.inject' && command.carrier === 'product-socket' && command.action === 'close');
}

/** A wait or a barrier holds the page until another role acted, which the cue's own delivery may be part of. */
function holdsForPeer(command: RallarBlackBoxTestCommand): boolean {
    return command.kind === 'wait' || command.kind === 'barrier';
}

/** Every cue a page sends and then departs after, with nothing between that holds it for another role. */
function toCueDepartures(cell: string, recipe: RallarBlackBoxTestRecipe): readonly CueDeparture[] {
    const commands = toCommands(recipe.commands);
    return commands.flatMap((command, index) => {
        if (!isCueSend(command)) {
            return [];
        }
        const rest = commands.slice(index + 1);
        const departure = rest.findIndex(isDeparture);
        const between = departure < 0 ? [] : rest.slice(0, departure);
        return departure < 0 || between.some(holdsForPeer) ? [] : [{ cell, cue: command, between }];
    });
}

function toAllRoleRecipes(): readonly Readonly<{ cell: string; recipe: RallarBlackBoxTestRecipe; }>[] {
    return ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes(toConformanceInput(carrier)).flatMap((scenario) =>
            [
                scenario.sender,
                scenario.receiver,
                scenario.recipientB,
                scenario.successor,
                scenario.sibling,
                scenario.publisherB,
                scenario.continuation?.recipe
            ]
                .flatMap((recipe) => recipe === undefined ? [] : [{ cell: `${carrier} ${scenario.scenarioId}`, recipe }])
        )
    );
}

describe('a cue its page departs after', () => {
    // Run 45221540520: the churn sender closed its page 8 ms after its cue read transport-accepted, the close-driven
    // disconnect committed first, and the server fenced the cue (member-not-active); the receiver waited out its cue.
    it('is acknowledged by its room before the page departs, not merely accepted by its transport', () => {
        const departures = toAllRoleRecipes().flatMap(({ cell, recipe }) => toCueDepartures(cell, recipe));

        expect(departures.map(({ cell, cue }) => `${cell} ${cue.commandId?.replace(/.*-cue-/u, 'cue-')}`).toSorted())
            .toEqual([
                'rtc churn-bounded-tracks cue-tracks-sent',
                'rtc subscription-ordered-reconnect cue-leaving',
                'rtc-with-ws-fallback subscription-ordered-reconnect cue-leaving',
                'ws subscription-ordered-reconnect cue-leaving'
            ]);
        for (const { cell, cue, between } of departures) {
            // A room cue's receipt expects every session the server froze at admission: an acknowledgement proves the
            // server admitted the cue past the membership fence and that every listener has it.
            expect(cue, cell).toMatchObject({ carrier: 'ws', ack: 'receiver', reliability: 'at-least-once' });
            expect(between, cell).toContainEqual(expect.objectContaining({
                kind: 'messages.observe',
                handleId: cue.handleId,
                state: ['acknowledged']
            }));
            expect(between.filter((command) => command.kind === 'messages.observe').map(({ state }) => state), cell)
                .not.toContainEqual(['transport-accepted']);
        }
    });

    it('leaves every cue whose page stays connected confirming nothing to its sender', () => {
        const recipes = toAllRoleRecipes();
        const departing = new Set(
            recipes.flatMap(({ cell, recipe }) => toCueDepartures(cell, recipe)).map(({ cue }) => cue)
        );
        const staying = recipes.flatMap(({ recipe }) => toCommands(recipe.commands))
            .filter(isCueSend)
            .filter((cue) => !departing.has(cue));

        expect(staying.length).toBeGreaterThan(0);
        for (const cue of staying) {
            expect(cue.ack, cue.commandId).toBe('none');
        }
    });
});
