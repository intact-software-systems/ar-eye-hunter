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

import type { TwoAgentRun, TwoAgentRunParticipant } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';
import { runRecipeTrioOnSameContext } from '../../../tests/playwright/rallar-black-box/full-stack-same-context-run.ts';

const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

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

function toParticipant(agentId: string, page: Playwright.Page | undefined): TwoAgentRunParticipant {
    return {
        agentId,
        actor: agentId,
        connection: agentId,
        get context(): Playwright.BrowserContext {
            throw new Error('Enqueue must not create a browser context.');
        },
        get page(): Playwright.Page {
            if (page === undefined) {
                throw new Error('Only the owner page is closed.');
            }
            return page;
        }
    };
}

describe('same-context ALM run', () => {
    it('selects exactly durable-takeover for the same-context family on every carrier', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const sameContext = createAlmConformanceRecipes({
                group,
                carrier,
                typeId: 'probe',
                senderConnection: 'sender',
                receiverConnection: 'receiver',
                deadlineMs: 18_000
            }).filter((scenario) => scenario.laneFamily === 'same-context');

            expect(sameContext.map((scenario) => scenario.scenarioKey), carrier).toEqual(['durable-takeover']);
            expect(sameContext.every((scenario) => scenario.successor !== undefined), carrier).toBe(true);
        }
    });

    // One auth session keeps one server socket: the successor connects only once the owner page is gone.
    it('runs the owner\'s recipe, closes the owner page, then runs the successor, the receiver started first', async () => {
        const baseline = createAlmConformanceRecipes({
            group,
            carrier: 'ws',
            typeId: 'probe',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
        }).find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const successor = { ...baseline.sender, recipeId: `${baseline.sender.recipeId}-successor` };
        const order: string[] = [];
        const ownerPage = { close: async () => void order.push('close-owner') } as Partial<Playwright.Page> as Playwright.Page;
        const request = await Playwright.request.newContext();
        vi.spyOn(request, 'post').mockImplementation(async (url, options) => {
            const data = options?.data;
            if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
                throw new Error('Expected the actual control HTTP command body.');
            }
            order.push(data.commandId);
            return toAcceptedResponse(url);
        });
        const run: TwoAgentRun = {
            request,
            runId: 'same-context-run',
            group,
            sender: toParticipant('owner-agent', ownerPage),
            receiver: toParticipant('receiver-agent', undefined),
            readSnapshot: async () => ({ results: order.map((commandId) => ({ commandId, ok: true })) }),
            close: async () => {
                throw new Error('Enqueue must not close the run.');
            }
        };
        try {
            const outcome = await runRecipeTrioOnSameContext(
                run,
                { owner: run.sender, successor: toParticipant('successor-agent', undefined) },
                { sender: baseline.sender, receiver: baseline.receiver, successor }
            );

            expect(order).toEqual([
                `${baseline.receiver.recipeId}-run`,
                `${baseline.sender.recipeId}-run`,
                'close-owner',
                `${successor.recipeId}-run`
            ]);
            expect(outcome).toEqual({
                sender: { commandId: `${baseline.sender.recipeId}-run`, ok: true, summary: 'ok' },
                receiver: { commandId: `${baseline.receiver.recipeId}-run`, ok: true, summary: 'ok' },
                successor: { commandId: `${successor.recipeId}-run`, ok: true, summary: 'ok' }
            });
        }
        finally {
            vi.restoreAllMocks();
            await request.dispose();
        }
    });
});
