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
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import { ALM_CONFORMANCE_LANE_FAMILIES } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import {
    closeAgentConnections,
    runRecipesOnAgents,
    toAgentRunPrincipalIds,
    type AgentRecipeRun
} from '../../../tests/playwright/rallar-black-box/full-stack-agent-run.ts';

const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

function toScenarios(carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number]) {
    return createAlmConformanceRecipes({
        group,
        carrier,
        typeId: 'probe',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000,
        laneFamilies: ALM_CONFORMANCE_LANE_FAMILIES,
        principalIdsByRole: { sender: 'alice', receiver: 'bob', 'publisher-b': 'charlie' }
    });
}

describe('ALM run on an agent per role', () => {
    it('selects exactly the paced list-isolation, receipted-audience, membership fence, leader, claim and reply-first-wins scenarios for the three-agent family on every carrier', () => {
        const rtcScenarioKeys = ['aggregated-receipt', 'missing-recipient-retry', 'unknown-ack-version', 'frozen-audience-membership'];
        const expectedKeys = {
            ws: [
                'paced-isolation-lists',
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
                'claim-expires-reclaims',
                'reply-first-wins'
            ],
            rtc: [
                'paced-isolation-lists',
                ...rtcScenarioKeys,
                'fenced-delivery',
                'fenced-catch-up',
                'leader-confirms',
                'no-leader-refused',
                'claim-refused-on-rtc'
            ],
            'rtc-with-ws-fallback': ['paced-isolation-lists', ...rtcScenarioKeys, 'leader-confirms', 'claim-first-wins']
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

    it('selects exactly the topic subscription cells for the four-role family over ws and the fallback carrier', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const fourRole = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'four-role');
            expect(fourRole.map((scenario) => scenario.scenarioKey), carrier).toEqual(
                carrier === 'rtc'
                    ? []
                    : ['subscription-delivery', 'subscription-token-count', 'subscription-revoke-held', 'subscription-reconnect']
            );
            expect(fourRole.every((scenario) => scenario.publisherB !== undefined && scenario.sibling !== undefined), carrier)
                .toBe(true);
        }
    });

    it('names each role\'s principal by the client id its agent signed in as', () => {
        const agents = new Map<AlmConformanceRole, Readonly<{ principalId: string; }>>([
            ['sender', { principalId: 'alice-client' }],
            ['sibling', { principalId: 'alice-client' }],
            ['publisher-b', { principalId: 'charlie-client' }]
        ]);

        expect(toAgentRunPrincipalIds({ agents })).toEqual({
            sender: 'alice-client',
            sibling: 'alice-client',
            'publisher-b': 'charlie-client'
        });
    });

    // The receiver's prologue creates the run's group, so it owns it; an only owner's leave is refused.
    it('starts every other role only after the receiver\'s connect barrier, and the sender after all of them', async () => {
        const baseline = toScenarios('ws').find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const third = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-b` };
        const fourth = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-c` };
        const runIds = {
            receiver: `${baseline.receiver.recipeId}-run`,
            third: `${third.recipeId}-run`,
            fourth: `${fourth.recipeId}-run`,
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
        const run: AgentRecipeRun = {
            request,
            runId: 'three-agent-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }],
                ['sibling', { agentId: 'sibling-agent' }],
                ['publisher-b', { agentId: 'publisher-b-agent' }]
            ]),
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
            const running = runRecipesOnAgents(
                run,
                new Map([
                    ['sender', baseline.sender],
                    ['publisher-b', fourth],
                    ['receiver', baseline.receiver],
                    ['sibling', third]
                ])
            );
            await vi.waitFor(() => expect(posted).toContain(runIds.receiver));
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(posted).toEqual([runIds.receiver]);

            receiverConnected.resolve();
            const outcome = await running;

            expect(posted).toEqual([runIds.receiver, runIds.fourth, runIds.third, runIds.sender]);
            expect(Object.fromEntries(outcome)).toEqual({
                sender: { commandId: runIds.sender, ok: true, summary: 'ok' },
                receiver: { commandId: runIds.receiver, ok: true, summary: 'ok' },
                sibling: { commandId: runIds.third, ok: true, summary: 'ok' },
                'publisher-b': { commandId: runIds.fourth, ok: true, summary: 'ok' }
            });
        }
        finally {
            vi.restoreAllMocks();
            await request.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
    it('closes every agent\'s room connection before the next cell, and returns once each close passed', async () => {
        const posted: { readonly commandId: string; readonly command: string; }[] = [];
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
        vi.spyOn(request, 'post').mockImplementation(async (_url, options) => {
            const data = options?.data;
            if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
                throw new Error('Expected the actual control HTTP command body.');
            }
            posted.push({ commandId: data.commandId, command: JSON.stringify(data.command) });
            return await post(`http://127.0.0.1:${address.port}`, options);
        });
        const run: AgentRecipeRun = {
            request,
            runId: 'four-role-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }]
            ]),
            readSnapshot: async () => ({
                runId: 'four-role-run',
                createdAtEpochMs: 1,
                updatedAtEpochMs: 2,
                agents: [],
                commands: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
                results: posted.map(({ commandId }) => ({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'four-role-run',
                    agentId: 'observed-agent',
                    commandId,
                    ok: true
                }))
            })
        };
        try {
            await closeAgentConnections(run, 'subscription-delivery');

            expect(posted).toEqual([
                { commandId: 'close-subscription-delivery-sender-agent', command: '{"kind":"close"}' },
                { commandId: 'close-subscription-delivery-receiver-agent', command: '{"kind":"close"}' }
            ]);
        }
        finally {
            vi.restoreAllMocks();
            await request.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
});
