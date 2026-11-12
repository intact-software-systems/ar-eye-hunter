import { describe, expect, it } from 'vitest';

import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import { createAlmConformanceRecipes, type AlmConformanceScenario } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    assessAlmConformanceIdentity,
    type AlmConformanceIdentityParticipant
} from '@shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-conformance-identity.ts';
import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const RUN_ID = 'run-relayed-receipt';
const ROLES: readonly AlmConformanceRole[] = ['sender', 'receiver', 'recipient-b'];

/** The sessions each origin addresses: the other two pages of the path. */
const RECIPIENTS_BY_ORIGIN: Readonly<Record<string, readonly string[]>> = {
    sender: ['receiver-session', 'recipient-b-session'],
    receiver: ['sender-session', 'recipient-b-session']
};

/** An origin that is a leaf confirms both recipients through the middle; one in the middle confirms each directly. */
type OriginRoute = 'relayed' | 'direct';

function toRelayPathScenario(): AlmConformanceScenario & { readonly recipientB: RallarBlackBoxTestRecipe; } {
    const scenario = createAlmConformanceRecipes(toConformanceInput('rtc'))
        .find((candidate) => candidate.scenarioKey === 'receipted-relay-path');
    if (scenario?.recipientB === undefined) {
        throw new Error('The generated relay-path scenario must declare recipient-b.');
    }
    return { ...scenario, recipientB: scenario.recipientB };
}

function toReceiptValue(role: string, route: OriginRoute) {
    const recipients = RECIPIENTS_BY_ORIGIN[role] ?? [];
    return {
        state: 'acknowledged',
        expectedRecipientPeerIds: recipients,
        confirmedRecipientPeerIds: recipients,
        unconfirmedRecipientPeerIds: [],
        outsideAudienceRecipientPeerIds: [],
        confirmedHopPeerIds: route === 'relayed' ? ['recipient-b-session'] : recipients,
        unconfirmedHopPeerIds: []
    };
}

/** Every command of the recipe recorded ok; a connect names the session of its role, a receipts read its route. */
function toParticipant(role: string, recipe: RallarBlackBoxTestRecipe, route: OriginRoute): AlmConformanceIdentityParticipant {
    const results = recipe.commands.map((command): RallarBlackBoxTestResult => ({
        commandId: command.commandId!,
        kind: command.kind,
        value: command.kind === 'rtc.connect'
            ? { sessionId: `${role}-session` }
            : command.kind === 'messages.receipts'
            ? toReceiptValue(role, route)
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

interface AssessRouteInput {
    readonly sender: OriginRoute;
    readonly owner: OriginRoute;
    readonly senderRecipe?: RallarBlackBoxTestRecipe;
}

function assessRoutes({ sender, owner, senderRecipe }: AssessRouteInput): readonly string[] {
    const scenario = toRelayPathScenario();
    return assessAlmConformanceIdentity({
        runId: RUN_ID,
        roles: ROLES,
        participants: [
            toParticipant('sender', senderRecipe ?? scenario.sender, sender),
            toParticipant('receiver', scenario.receiver, owner),
            toParticipant('recipient-b', scenario.recipientB, 'direct')
        ]
    });
}

describe('ALM relayed receipt identity', () => {
    it('fails the relay-path cell when both origins confirmed their two recipients through two hops: no send was relayed', () => {
        expect(assessRoutes({ sender: 'direct', owner: 'direct' })).toEqual([
            'receipted-relay-path: no ending receipt of an origin confirms both recipients through one hop, so no send was relayed.'
        ]);
    });

    it('passes the cell when one origin confirmed its two recipients through one hop, whichever origin it is', () => {
        expect(assessRoutes({ sender: 'relayed', owner: 'direct' })).toEqual([]);
        expect(assessRoutes({ sender: 'direct', owner: 'relayed' })).toEqual([]);
        expect(assessRoutes({ sender: 'relayed', owner: 'relayed' })).toEqual([]);
    });

    it('does not assess a recipe that carries no relayed receipt pin', () => {
        const scenario = toRelayPathScenario();
        const { almRelayedReceiptOrigins: _pin, ...metadata } = scenario.sender.metadata ?? {};
        expect(_pin).toBeDefined();
        expect(assessRoutes({ sender: 'direct', owner: 'direct', senderRecipe: { ...scenario.sender, metadata } }))
            .toEqual([]);
    });

    it('fails a malformed relayed receipt pin instead of skipping its check', () => {
        const scenario = toRelayPathScenario();
        const metadata = { ...scenario.sender.metadata, almRelayedReceiptOrigins: [{ role: 'sender' }] };
        expect(assessRoutes({ sender: 'relayed', owner: 'relayed', senderRecipe: { ...scenario.sender, metadata } }))
            .toEqual(['receipted-relay-path: the relayed receipt pin does not name each origin by its role and send handle.']);
    });
});
