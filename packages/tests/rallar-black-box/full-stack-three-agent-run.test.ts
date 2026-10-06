import * as Playwright from '@playwright/test';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import type { TwoAgentRunParticipant } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';
import {
    runRecipeTrioOnThreeAgents,
    type ThreeAgentRun
} from '../../../tests/playwright/rallar-black-box/full-stack-three-agent-run.ts';

const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

function toScenarios(carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number]) {
    return createAlmConformanceRecipes({
        group,
        carrier,
        typeId: 'probe',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000
    });
}

function toParticipant(agentId: string): TwoAgentRunParticipant {
    return {
        agentId,
        actor: agentId,
        connection: agentId,
        get context(): Playwright.BrowserContext {
            throw new Error('Enqueue must not create a browser context.');
        },
        get page(): Playwright.Page {
            throw new Error('Enqueue must not touch an agent page.');
        }
    };
}

function toAcceptedResponse(url: string): Playwright.APIResponse {
    return {
        url: () => url,
        ok: () => true,
        status: () => 202,
        statusText: () => 'Accepted',
        headers: () => ({}),
        headersArray: () => [],
        securityDetails: async () => null,
        serverAddr: async () => null,
        body: async () => Buffer.from('{}'),
        text: async () => '{}',
        json: async () => ({}),
        dispose: async () => {},
        [Symbol.asyncDispose]: async () => {}
    };
}

describe('three-agent ALM run', () => {
    it('selects exactly the receipted-audience and membership fence scenarios for the three-agent family on every carrier', () => {
        const rtcScenarioKeys = ['aggregated-receipt', 'missing-recipient-retry', 'unknown-ack-version', 'frozen-audience-membership'];
        const expectedKeys = {
            ws: [
                'aggregated-receipt',
                'missing-recipient-retry',
                'frozen-audience-membership',
                'fenced-delivery',
                'fenced-catch-up',
                'fenced-rejection'
            ],
            rtc: [...rtcScenarioKeys, 'fenced-delivery', 'fenced-catch-up'],
            'rtc-with-ws-fallback': rtcScenarioKeys
        };
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const threeAgent = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'three-agent');
            expect(threeAgent.map((scenario) => scenario.scenarioKey), carrier).toEqual(expectedKeys[carrier]);
            expect(threeAgent.every((scenario) => scenario.recipientB !== undefined), carrier).toBe(true);
        }
    });

    // The receiver's prologue creates the run's group, so it owns it; an only owner's leave is refused.
    it('starts recipient-b only after the receiver\'s connect barrier, and the sender only after both', async () => {
        const baseline = toScenarios('ws').find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const recipientB = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-b` };
        const runIds = {
            receiver: `${baseline.receiver.recipeId}-run`,
            recipientB: `${recipientB.recipeId}-run`,
            sender: `${baseline.sender.recipeId}-run`
        };
        const posted: string[] = [];
        const receiverConnected = Promise.withResolvers<void>();
        const request = await Playwright.request.newContext();
        vi.spyOn(request, 'post').mockImplementation(async (url, options) => {
            const data = options?.data;
            if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
                throw new Error('Expected the actual control HTTP command body.');
            }
            posted.push(data.commandId);
            return toAcceptedResponse(url);
        });
        const run: ThreeAgentRun = {
            request,
            runId: 'three-agent-run',
            group,
            sender: toParticipant('sender-agent'),
            receiver: toParticipant('receiver-agent'),
            recipientB: toParticipant('recipient-b-agent'),
            readSnapshot: async () => {
                await receiverConnected.promise;
                return { results: posted.map((commandId) => ({ commandId, ok: true })) };
            },
            close: async () => {
                throw new Error('Enqueue must not close the agents.');
            }
        };
        try {
            const running = runRecipeTrioOnThreeAgents(run, {
                sender: baseline.sender,
                receiver: baseline.receiver,
                recipientB
            });
            await vi.waitFor(() => expect(posted).toContain(runIds.receiver));
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(posted).toEqual([runIds.receiver]);

            receiverConnected.resolve();
            const outcome = await running;

            expect(posted).toEqual([runIds.receiver, runIds.recipientB, runIds.sender]);
            expect(outcome).toEqual({
                sender: { commandId: runIds.sender, ok: true, summary: 'ok' },
                receiver: { commandId: runIds.receiver, ok: true, summary: 'ok' },
                recipientB: { commandId: runIds.recipientB, ok: true, summary: 'ok' }
            });
        }
        finally {
            vi.restoreAllMocks();
            await request.dispose();
        }
    });
});
