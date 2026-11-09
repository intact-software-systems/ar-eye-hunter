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
    it('selects exactly the exhausted repair, paced list-isolation, receipted-audience, membership fence, leader, claim and reply-first-wins scenarios for the three-agent family on every carrier', () => {
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
                'repair-exhausted',
                'paced-isolation-lists',
                ...rtcScenarioKeys,
                'fenced-delivery',
                'fenced-catch-up',
                'leader-confirms',
                'no-leader-refused',
                'claim-refused-on-rtc'
            ],
            'rtc-with-ws-fallback': [
                'repair-exhausted',
                'paced-isolation-lists',
                ...rtcScenarioKeys,
                'leader-confirms',
                'claim-first-wins'
            ]
        };
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const threeAgent = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'three-agent');
            expect(threeAgent.map((scenario) => scenario.scenarioKey), carrier).toEqual(expectedKeys[carrier]);
            expect(threeAgent.every((scenario) => scenario.recipientB !== undefined), carrier).toBe(true);
        }
    });

    it('selects exactly the audience scenarios and, over ws, the server-ordered entry cell for the same-principal family, each with a sibling', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const samePrincipal = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'same-principal');
            expect(samePrincipal.map((scenario) => scenario.scenarioKey), carrier).toEqual([
                ...(carrier === 'ws' ? ['server-ordered-entry'] : []),
                'principal-delivery',
                'fixed-list-delivery',
                'world-routing',
                ...(carrier === 'rtc' ? ['granted-rtc-principal-delivered'] : [])
            ]);
            expect(samePrincipal.every((scenario) => scenario.sibling !== undefined && scenario.recipientB === undefined), carrier)
                .toBe(true);
        }
    });

    it('selects exactly the topic subscription cells for the four-role family on every carrier', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const fourRole = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'four-role');
            expect(fourRole.map((scenario) => scenario.scenarioKey), carrier).toEqual([
                'subscription-delivery',
                'subscription-token-count',
                'subscription-revoke-disconnected',
                'subscription-ordered-entry',
                'subscription-ordered-omission',
                'subscription-ordered-reconnect'
            ]);
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
        const sibling = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-sibling` };
        const publisherB = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-publisher-b` };
        const runIds = {
            receiver: `${baseline.receiver.recipeId}-run`,
            sibling: `${sibling.recipeId}-run`,
            publisherB: `${publisherB.recipeId}-run`,
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
            runId: 'agent-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }],
                ['sibling', { agentId: 'sibling-agent' }],
                ['publisher-b', { agentId: 'publisher-b-agent' }]
            ]),
            readSnapshot: async () => {
                await receiverConnected.promise;
                return {
                    runId: 'agent-run',
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
                        runId: 'agent-run',
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
                    ['publisher-b', publisherB],
                    ['receiver', baseline.receiver],
                    ['sibling', sibling]
                ]),
                undefined
            );
            await vi.waitFor(() => expect(posted).toContain(runIds.receiver));
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(posted).toEqual([runIds.receiver]);

            receiverConnected.resolve();
            const outcome = await running;

            expect(posted).toEqual([runIds.receiver, runIds.publisherB, runIds.sibling, runIds.sender]);
            expect(outcome.continuation).toBeUndefined();
            expect(Object.fromEntries(outcome.roles)).toEqual({
                sender: { commandId: runIds.sender, ok: true, summary: 'ok' },
                receiver: { commandId: runIds.receiver, ok: true, summary: 'ok' },
                sibling: { commandId: runIds.sibling, ok: true, summary: 'ok' },
                'publisher-b': { commandId: runIds.publisherB, ok: true, summary: 'ok' }
            });
        }
        finally {
            vi.restoreAllMocks();
            await request.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it('starts the sibling\'s continuation on its own agent only once its first recipe ended and the gate passed in the receiver\'s still running recipe', async () => {
        const baseline = toScenarios('ws').find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const sibling = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-sibling` };
        const continuation = {
            role: 'sibling',
            gate: { role: 'receiver', commandId: 'receiver-p4-confirmed' },
            recipe: { ...sibling, recipeId: `${sibling.recipeId}-continuation` }
        } as const;
        const receiverRunId = `${baseline.receiver.recipeId}-run`;
        const siblingRunId = `${sibling.recipeId}-run`;
        const continuationRunId = `${continuation.recipe.recipeId}-run`;
        // The sibling copies the receiver's recipe, so one passed connect releases both barriers.
        const connect = sibling.commands.find((command) => command.kind === 'rtc.connect')!.commandId!;
        const posted: string[] = [];
        const agentsByCommand = new Map<string, string>();
        let gateOpen = false;
        let siblingDone = false;
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
        vi.spyOn(request, 'post').mockImplementation(async (url, options) => {
            const data = options?.data;
            if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
                throw new Error('Expected the actual control HTTP command body.');
            }
            posted.push(data.commandId);
            agentsByCommand.set(data.commandId, decodeURIComponent(String(url).split('/agents/')[1]?.split('/')[0] ?? ''));
            return await post(`http://127.0.0.1:${address.port}`, options);
        });
        const toPassedEvent = (agentId: string, commandId: string) => ({
            kind: 'event' as const,
            protocolVersion: 1 as const,
            runId: 'gated-run',
            agentId,
            atEpochMs: 1,
            eventId: `event-${agentId}-${commandId}`,
            commandId,
            payload: { kind: 'result', topic: 'rallar.bb.command.result', commandId, payload: { commandId, ok: true } }
        });
        const run: AgentRecipeRun = {
            request,
            runId: 'gated-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }],
                ['sibling', { agentId: 'sibling-agent' }]
            ]),
            readSnapshot: async () => ({
                runId: 'gated-run',
                createdAtEpochMs: 1,
                updatedAtEpochMs: 2,
                agents: [],
                commands: [],
                // The receiver runs on until the gate opens; the sibling's first recipe until it is done.
                events: [
                    toPassedEvent('receiver-agent', connect),
                    ...(gateOpen ? [toPassedEvent('receiver-agent', 'receiver-p4-confirmed')] : [])
                ],
                stats: [],
                reports: [],
                heartbeats: [],
                results: posted.filter((commandId) => (gateOpen || commandId !== receiverRunId) && (siblingDone || commandId !== siblingRunId)).map((
                    commandId
                ) => ({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'gated-run',
                    agentId: 'observed-agent',
                    commandId,
                    ok: true
                }))
            })
        };
        try {
            const running = runRecipesOnAgents(
                run,
                new Map([['sender', baseline.sender], ['receiver', baseline.receiver], ['sibling', sibling]]),
                continuation
            );
            await vi.waitFor(() => expect(posted).toContain(siblingRunId));
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(posted).not.toContain(continuationRunId);

            // The gate passed, but the continuation is the sibling's later steps: its first recipe must end first.
            gateOpen = true;
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(posted).not.toContain(continuationRunId);

            siblingDone = true;
            const outcome = await running;

            expect(posted.at(-1)).toBe(continuationRunId);
            expect(agentsByCommand.get(continuationRunId)).toBe('sibling-agent');
            expect(outcome.continuation).toEqual({ commandId: continuationRunId, ok: true, summary: 'ok' });
            expect([...outcome.roles.keys()].toSorted()).toEqual(['receiver', 'sender', 'sibling']);
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

    it('throws when an agent\'s close has not passed within the close timeout, reading no snapshot after it', async () => {
        const posted: string[] = [];
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
            posted.push(data.commandId);
            return await post(`http://127.0.0.1:${address.port}`, options);
        });
        let nowEpochMs = 1_000;
        let reads = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => nowEpochMs);
        // Each read moves the clock 10 s: the receiver's close never passes, the sender's passes at once.
        const run: AgentRecipeRun = {
            request,
            runId: 'close-timeout-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }]
            ]),
            readSnapshot: async () => {
                reads += 1;
                nowEpochMs += 10_000;
                return {
                    runId: 'close-timeout-run',
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
                        runId: 'close-timeout-run',
                        agentId: 'observed-agent',
                        commandId,
                        ok: commandId !== 'close-subscription-delivery-receiver-agent'
                    }))
                };
            }
        };
        try {
            await expect(closeAgentConnections(run, 'subscription-delivery')).rejects.toThrow(
                'subscription-delivery: not every agent closed its room connection within 30000 ms.'
            );
            expect(reads).toBe(3);
        }
        finally {
            vi.restoreAllMocks();
            await request.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
});
