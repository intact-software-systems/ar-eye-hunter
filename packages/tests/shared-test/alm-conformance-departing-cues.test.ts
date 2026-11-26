import { isDeepStrictEqual } from 'node:util';
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

interface RoleRecipe {
    readonly cell: string;
    readonly recipe: RallarBlackBoxTestRecipe;
    /** The cues the cell's other roles send, which this role can only receive once they acted. */
    readonly peerCues: readonly RallarBlackBoxTestMessagesSendCommand[];
}

/**
 * A barrier, or a wait for a cue another role sends, holds the page until that role acted, which may itself follow the
 * cue's delivery. Any other wait, such as one for the page's own traffic, does not.
 */
function holdsForPeer(command: RallarBlackBoxTestCommand, peerCues: RoleRecipe['peerCues']): boolean {
    return command.kind === 'barrier' ||
        (command.kind === 'wait' && command.absent !== true &&
            peerCues.some((cue) => isDeepStrictEqual(cue.payload, command.match.equals)));
}

/** Every cue a page sends and then departs after, with nothing between that holds it for another role. */
function toCueDepartures({ cell, recipe, peerCues }: RoleRecipe): readonly CueDeparture[] {
    const commands = toCommands(recipe.commands);
    return commands.flatMap((command, index) => {
        if (!isCueSend(command)) {
            return [];
        }
        const rest = commands.slice(index + 1);
        const departure = rest.findIndex(isDeparture);
        const between = departure < 0 ? [] : rest.slice(0, departure);
        return departure < 0 || between.some((held) => holdsForPeer(held, peerCues))
            ? []
            : [{ cell, cue: command, between }];
    });
}

function toAllRoleRecipes(): readonly RoleRecipe[] {
    return ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes(toConformanceInput(carrier)).flatMap((scenario) => {
            const recipes = [
                scenario.sender,
                scenario.receiver,
                scenario.recipientB,
                scenario.successor,
                scenario.sibling,
                scenario.publisherB,
                scenario.continuation?.recipe
            ].flatMap((recipe) => recipe === undefined ? [] : [recipe]);
            const cuesOf = (recipe: RallarBlackBoxTestRecipe) => toCommands(recipe.commands).filter(isCueSend);
            return recipes.map((recipe) => ({
                cell: `${carrier} ${scenario.scenarioId}`,
                recipe,
                peerCues: recipes.filter((peer) => peer !== recipe).flatMap(cuesOf)
            }));
        })
    );
}

describe('a cue departure\'s hold for another role', () => {
    const toCue = (cue: string): RallarBlackBoxTestMessagesSendCommand => ({
        kind: 'messages.send',
        commandId: `cell-cue-${cue}`,
        carrier: 'ws',
        typeId: 'cell.type',
        payload: { marker: 'cell', cue },
        ack: 'none'
    });
    const toWait = (equals: Readonly<Record<string, string>>): RallarBlackBoxTestCommand => ({
        kind: 'wait',
        commandId: 'cell-wait',
        match: { kind: 'message', payloadPath: 'data.payload', equals },
        timeoutMs: 1_000
    });
    const toSender = (held: RallarBlackBoxTestCommand): RallarBlackBoxTestRecipe => ({
        schemaVersion: 1,
        recipeId: 'sender',
        commands: [toCue('sent'), held, { kind: 'close', commandId: 'cell-close' }]
    });
    const peerCues = [toCue('peer')];

    // A wait for the page's own traffic hid the departure as any wait did, though nothing in it waits on the cue.
    it('reports a departure that only a wait for the page\'s own traffic precedes', () => {
        const departures = toCueDepartures({
            cell: 'cell',
            recipe: toSender(toWait({ marker: 'cell', own: 'echo' })),
            peerCues
        });

        expect(departures.map(({ cue }) => cue.commandId)).toEqual(['cell-cue-sent']);
    });

    it('lets a wait for another role\'s cue or a barrier hold the page', () => {
        const held: readonly RallarBlackBoxTestCommand[] = [
            toWait({ marker: 'cell', cue: 'peer' }),
            { kind: 'barrier', commandId: 'cell-barrier', barrierId: 'cell', timeoutMs: 1_000 }
        ];

        for (const command of held) {
            expect(toCueDepartures({ cell: 'cell', recipe: toSender(command), peerCues }), command.kind).toEqual([]);
        }
    });
});

describe('a cue its page departs after', () => {
    // Run 45221540520: the churn sender closed its page 8 ms after its cue read transport-accepted, the close-driven
    // disconnect committed first, and the server fenced the cue (member-not-active); the receiver waited out its cue.
    it('is acknowledged by its room before the page departs, not merely accepted by its transport', () => {
        const departures = toAllRoleRecipes().flatMap(toCueDepartures);

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
            recipes.flatMap(toCueDepartures).map(({ cue }) => cue)
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
