import { describe, expect, it } from 'vitest';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import { NON_EXPIRING_TTL_MS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import { createAlmConformanceRecipes, type AlmConformanceScenario } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    assessAlmConformanceIdentity,
    type AlmConformanceIdentityParticipant
} from '@shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-conformance-identity.ts';
import { assessAlmRelayedGapRenewal } from '@shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-relayed-gap-renewal.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const RUN_ID = 'run-relayed-gap-renewal';
const ROLES: readonly AlmConformanceRole[] = ['sender', 'receiver', 'recipient-b'];
const CELLS = [
    { key: 'relayed-gap-renewal', requestNumber: 3, ack: 'receiver', handleState: 'acknowledged' },
    { key: 'relayed-unreceipted-gap-renewal', requestNumber: 2, ack: 'none', handleState: 'transport-accepted' }
] as const;

type RelayedGapRenewalKey = (typeof CELLS)[number]['key'];

/** Who sent each request an origin admitted: every receiver itself, or a relay for its far receiver. */
type OriginRoute = 'relayed' | 'direct';

function toScenario(key: RelayedGapRenewalKey): AlmConformanceScenario & { readonly recipientB: RallarBlackBoxTestRecipe; } {
    const scenario = createAlmConformanceRecipes(toConformanceInput('rtc'))
        .find((candidate) => candidate.scenarioKey === key);
    if (scenario?.recipientB === undefined) {
        throw new Error(`The generated ${key} scenario must declare recipient-b.`);
    }
    return { ...scenario, recipientB: scenario.recipientB };
}

function toCommandIds(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.map((command) => command.commandId ?? '');
}

function toCommand(recipe: RallarBlackBoxTestRecipe, commandId: string): RallarBlackBoxTestCommand | undefined {
    return recipe.commands.find((command) => command.commandId === commandId);
}

/** The admitted NACK a gap request wait recorded: relayed, the middle sent it for the far receiver. */
function toGapRequestValue(commandId: string, requestNumber: number, route: OriginRoute) {
    const logicalRecipientPeerId = commandId.endsWith('-for-recipient-b') ? 'recipient-b-session' : 'peer-session';
    return {
        matched: true,
        event: {
            payload: {
                data: {
                    kind: 'control-admission',
                    outcome: 'committed',
                    nackReason: 'gap',
                    nackGapRequestNumber: requestNumber,
                    nackLogicalRecipientPeerId: logicalRecipientPeerId,
                    nackFromPeerId: route === 'relayed' ? 'middle-session' : logicalRecipientPeerId
                }
            }
        }
    };
}

/** Every command of the recipe recorded ok; a gap request wait recorded its admitted NACK by the origin's route. */
function toParticipant(
    role: string,
    recipe: RallarBlackBoxTestRecipe,
    { route, requestNumber }: { readonly route: OriginRoute; readonly requestNumber: number; }
): AlmConformanceIdentityParticipant {
    const results = recipe.commands.map((command): RallarBlackBoxTestResult => ({
        commandId: command.commandId!,
        kind: command.kind,
        value: command.commandId?.includes(`-gap-request-${requestNumber}-for-`)
            ? toGapRequestValue(command.commandId, requestNumber, route)
            : {},
        ok: true,
        status: 'ok',
        startedAtEpochMs: 1,
        endedAtEpochMs: 2,
        durationMs: 1
    }));
    const commandId = `${role}-root`;
    return {
        role,
        agentId: role,
        commandId,
        recipe,
        result: {
            kind: 'result',
            protocolVersion: 1,
            runId: RUN_ID,
            agentId: role,
            commandId,
            ok: true,
            result: {
                commandId,
                kind: 'recipe.run',
                value: { recipeId: recipe.recipeId, results },
                ok: true,
                status: 'ok',
                startedAtEpochMs: 1,
                endedAtEpochMs: 2,
                durationMs: 1
            }
        }
    };
}

function toRecordedResults(
    participant: AlmConformanceIdentityParticipant
): ReadonlyMap<string, RallarBlackBoxTestResult> {
    const value = participant.result?.result?.value as { readonly results: readonly RallarBlackBoxTestResult[]; };
    return new Map(value.results.map((result) => [result.commandId, result]));
}

interface AssessRouteInput {
    readonly key: RelayedGapRenewalKey;
    readonly sender: OriginRoute;
    readonly owner: OriginRoute;
    readonly senderRecipe?: RallarBlackBoxTestRecipe;
}

function assessRoutes({ key, sender, owner, senderRecipe }: AssessRouteInput): readonly string[] {
    const scenario = toScenario(key);
    const requestNumber = CELLS.find((cell) => cell.key === key)!.requestNumber;
    return assessAlmConformanceIdentity({
        runId: RUN_ID,
        roles: ROLES,
        participants: [
            toParticipant('sender', senderRecipe ?? scenario.sender, { route: sender, requestNumber }),
            toParticipant('receiver', scenario.receiver, { route: owner, requestNumber }),
            toParticipant('recipient-b', scenario.recipientB, { route: 'direct', requestNumber })
        ]
    });
}

describe.each(CELLS)('the $key cell', ({ key, requestNumber, ack, handleState }) => {
    const prefix = `alm-rtc-${key}`;

    it('runs over rtc alone, three-agent, in a room it reshapes', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const keys = createAlmConformanceRecipes(toConformanceInput(carrier)).map((scenario) => scenario.scenarioKey);
            expect(keys.includes(key), carrier).toBe(carrier === 'rtc');
        }
        const scenario = toScenario(key);
        expect(scenario.laneFamily).toBe('three-agent');
        expect(scenario.roomTopology).toBe('reshaped');
        expect(scenario.roles).toEqual(ROLES);
    });

    it(`holds each origin's second send until it admitted request ${requestNumber} from both receivers, then releases it`, () => {
        const scenario = toScenario(key);
        for (const [role, recipe] of [['sender', scenario.sender], ['receiver', scenario.receiver]] as const) {
            const ids = toCommandIds(recipe);
            const page = `${prefix}-${role}`;
            const waits = ROLES.filter((recipient) => recipient !== role)
                .map((recipient) => ids.indexOf(`${page}-gap-request-${requestNumber}-for-${recipient}`));
            const releases = ids.flatMap((id, index) => id.startsWith(`${page}-release-message-2`) ? [index] : []);

            expect(ids.indexOf(`${page}-hold-message-2-rtc`)).toBeLessThan(ids.indexOf(`${page}-send-3`));
            expect(waits.every((index) => index > ids.indexOf(`${page}-send-3`)), role).toBe(true);
            expect(releases, role).toEqual([Math.max(...waits) + 1]);
        }
    });

    it('ends each origin\'s hold within half its second send\'s lifetime, leaving the other half for the release and the repair', () => {
        const scenario = toScenario(key);
        for (const [role, recipe] of [['sender', scenario.sender], ['receiver', scenario.receiver]] as const) {
            const page = `${prefix}-${role}`;
            const send = recipe.commands.find((command) => command.commandId === `${page}-send-2`);
            const waits = ROLES.filter((recipient) => recipient !== role)
                .map((recipient) => toCommand(recipe, `${page}-gap-request-${requestNumber}-for-${recipient}`));

            // The send states no lifetime of its own, so it lives the browser's default.
            expect(send && 'ttlMs' in send ? send.ttlMs : undefined, role).toBeUndefined();
            expect(waits.map((wait) => wait?.timeoutMs), role).toEqual(waits.map(() => NON_EXPIRING_TTL_MS / 2));
        }
    });

    it('matches a committed gap NACK of the request number that speaks for the receiver the cue named', () => {
        const wait = toCommand(toScenario(key).sender, `${prefix}-sender-gap-request-${requestNumber}-for-recipient-b`);

        expect(wait).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                contains: `"nackGapRequestNumber":${requestNumber},"nackLogicalRecipientPeerId":` +
                    `"{resultCache.alm-rtc-${key}-cues-sender-cue-recipient-b-here-received.value.event.payload.senderId}"`,
                payloadFields: { 'data.kind': 'control-admission', 'data.outcome': 'committed', 'data.nackReason': 'gap' }
            }
        });
    });

    it(`sends each origin's track with ack ${ack} on a key of its own and reads every handle ${handleState}`, () => {
        const scenario = toScenario(key);
        for (const [role, recipe] of [['sender', scenario.sender], ['receiver', scenario.receiver]] as const) {
            const page = `${prefix}-${role}`;
            const sends = recipe.commands.flatMap((command) =>
                isRallarBlackBoxTestMessagesSendCommand(command) && command.commandId?.startsWith(`${page}-send-`)
                    ? [[command.ack, command.orderingKey, command.seq]]
                    : []
            );
            expect(sends, role).toEqual([1, 2, 3].map((seq) => [ack, `${prefix}:${role}`, seq]));
            for (const index of [1, 2, 3]) {
                expect(toCommand(recipe, `${page}-observe-${handleState}-${index}`), `${role} ${index}`).toBeDefined();
            }
        }
    });

    it('fails the cell when every origin admitted the request from the receiver itself: no renewal was relayed', () => {
        expect(assessRoutes({ key, sender: 'direct', owner: 'direct' })).toEqual([
            `${key}: no origin admitted a gap request numbered ${requestNumber} through a relay, so no renewal was relayed.`
        ]);
    });

    it('passes the cell when one origin admitted the request through a relay, whichever origin it is', () => {
        expect(assessRoutes({ key, sender: 'relayed', owner: 'direct' })).toEqual([]);
        expect(assessRoutes({ key, sender: 'direct', owner: 'relayed' })).toEqual([]);
        expect(assessRoutes({ key, sender: 'relayed', owner: 'relayed' })).toEqual([]);
    });

    it('does not assess a recipe that carries no relayed gap renewal pin', () => {
        const scenario = toScenario(key);
        const { almRelayedGapRenewalOrigins: pin, ...metadata } = scenario.sender.metadata ?? {};

        expect(pin).toEqual(['sender', 'receiver'].map((role) => ({
            role,
            requestNumber,
            waitCommandIds: ROLES.filter((recipient) => recipient !== role)
                .map((recipient) => `${prefix}-${role}-gap-request-${requestNumber}-for-${recipient}`)
        })));
        const participants = [
            toParticipant('sender', { ...scenario.sender, metadata }, { route: 'direct', requestNumber }),
            toParticipant('receiver', scenario.receiver, { route: 'direct', requestNumber })
        ].map((participant) => ({ participant, results: toRecordedResults(participant) }));
        expect(assessAlmRelayedGapRenewal({ sender: participants[0]!, participants })).toEqual([]);
    });

    it('fails a malformed relayed gap renewal pin instead of skipping its check', () => {
        const scenario = toScenario(key);
        const metadata = { ...scenario.sender.metadata, almRelayedGapRenewalOrigins: [{ role: 'sender', requestNumber }] };

        expect(assessRoutes({ key, sender: 'relayed', owner: 'relayed', senderRecipe: { ...scenario.sender, metadata } }))
            .toEqual([`${key}: the relayed gap renewal pin does not name each origin by its role, request number and waits.`]);
    });
});
