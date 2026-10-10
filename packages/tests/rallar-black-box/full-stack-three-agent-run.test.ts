import * as Playwright from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import {
    runRecipeTrioOnThreeAgents,
    type ThreeAgentRecipeRun
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

describe('three-agent ALM run', () => {
    it('selects exactly the receipted-audience, membership fence, leader and claim scenarios for the three-agent family on every carrier', () => {
        const rtcScenarioKeys = ['aggregated-receipt', 'missing-recipient-retry', 'unknown-ack-version', 'frozen-audience-membership'];
        const expectedKeys = {
            ws: [
                'aggregated-receipt',
                'missing-recipient-retry',
                'frozen-audience-membership',
                'fenced-delivery',
                'fenced-catch-up',
                'fenced-rejection',
                'leader-confirms',
                'no-leader-refused',
                'leader-outside-list',
                'claim-first-wins',
                'claim-expires-reclaims'
            ],
            rtc: [
                ...rtcScenarioKeys,
                'fenced-delivery',
                'fenced-catch-up',
                'leader-confirms',
                'no-leader-refused',
                'claim-refused-on-rtc'
            ],
            'rtc-with-ws-fallback': [...rtcScenarioKeys, 'leader-confirms', 'claim-first-wins']
        };
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const threeAgent = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'three-agent');
            expect(threeAgent.map((scenario) => scenario.scenarioKey), carrier).toEqual(expectedKeys[carrier]);
            expect(threeAgent.every((scenario) => scenario.recipientB !== undefined), carrier).toBe(true);
        }
    });

    it('selects exactly the audience scenarios for the same-principal family on every carrier, each with a sibling', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const samePrincipal = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'same-principal');
            expect(samePrincipal.map((scenario) => scenario.scenarioKey), carrier)
                .toEqual(['principal-delivery', 'fixed-list-delivery', 'world-routing']);
            expect(samePrincipal.every((scenario) => scenario.sibling !== undefined && scenario.recipientB === undefined), carrier)
                .toBe(true);
        }
    });

    // The receiver's prologue creates the run's group, so it owns it; an only owner's leave is refused.
    it('starts the third agent only after the receiver\'s connect barrier, and the sender only after both', async () => {
        const baseline = toScenarios('ws').find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const third = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-b` };
        const runIds = {
            receiver: `${baseline.receiver.recipeId}-run`,
            third: `${third.recipeId}-run`,
            sender: `${baseline.sender.recipeId}-run`
        };
        const posted: string[] = [];
        const receiverConnected = Promise.withResolvers<void>();
        const server = createServer((_request, response) => {
            response.writeHead(202, { 'content-type': 'application/json' });
            response.end('{}');
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Expected the owned HTTP server address.');
        }
        const request = await Playwright.request.newContext();
        const post = request.post.bind(request);
        const responseUrl = `http://127.0.0.1:${address.port}`;
        vi.spyOn(request, 'post').mockImplementation(async (url, options) => {
            const data = options?.data;
            if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
                throw new Error('Expected the actual control HTTP command body.');
            }
            posted.push(data.commandId);
            return await post(responseUrl, options);
        });
        const run: ThreeAgentRecipeRun = {
            request,
            runId: 'three-agent-run',
            sender: { agentId: 'sender-agent' },
            receiver: { agentId: 'receiver-agent' },
            third: { agentId: 'recipient-b-agent' },
            readSnapshot: async () => {
                await receiverConnected.promise;
                return {
                    runId: 'three-agent-run',
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 2,
                    agents: [],
                    commands: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                    results: posted.map((commandId) => ({
                        kind: 'result',
                        protocolVersion: 1,
                        runId: 'three-agent-run',
                        agentId: 'observed-agent',
                        commandId,
                        ok: true
                    }))
                };
            }
        };
        try {
            const running = runRecipeTrioOnThreeAgents(run, {
                sender: baseline.sender,
                receiver: baseline.receiver,
                third
            });
            await vi.waitFor(() => expect(posted).toContain(runIds.receiver));
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(posted).toEqual([runIds.receiver]);

            receiverConnected.resolve();
            const outcome = await running;

            expect(posted).toEqual([runIds.receiver, runIds.third, runIds.sender]);
            expect(outcome).toEqual({
                sender: { commandId: runIds.sender, ok: true, summary: 'ok' },
                receiver: { commandId: runIds.receiver, ok: true, summary: 'ok' },
                third: { commandId: runIds.third, ok: true, summary: 'ok' }
            });
        }
        finally {
            vi.restoreAllMocks();
            await request.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
});
