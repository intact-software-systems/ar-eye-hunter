import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

interface RecipeInteraction {
    readonly [name: string]: unknown;
    readonly PARALLEL?: { readonly request: { readonly groups: readonly { readonly steps: readonly RecipeInteraction[]; }[]; }; };
}

interface CapturedReport {
    readonly connection: string;
    readonly message: ALMessage;
}

const CLI = fileURLToPath(new URL('../../shared-test/black-box-runner/scenario-black-box.ts', import.meta.url));
const RECIPE_ROOT = fileURLToPath(new URL('../../shared-test/black-box-runner/tests/api-v1/', import.meta.url));
const CASES = [
    {
        recipe: 'api-v1-group-formation-criterion.json',
        steps: ['deriveRttCreatedAt', 'deriveRttReporter', 'deriveRttResource', 'reportTheObservedEdge'],
        sessions: ['aliceSessionId', 'bobSessionId'],
        connections: ['wsAlice', 'wsBob']
    },
    {
        recipe: 'api-v1-match-preset.json',
        steps: ['captureArenaRttReportedAt', 'deriveArenaRttReporter', 'deriveArenaRttResource', 'reportTheArenaEdge'],
        sessions: ['carolSessionId', 'danSessionId'],
        connections: ['wsCarol', 'wsDan']
    },
    ...['medium', 'large'].map((size) => ({
        recipe: `api-v1-group-formation-managed-burst-${size}.json`,
        steps: ['captureRttReportedAt', 'deriveRtt1x2Reporter', 'deriveRtt1x2Resource', 'reportRtt1x2'],
        sessions: ['client1SessionId', 'client2SessionId'],
        connections: ['ws-client-1', 'ws-client-2']
    }))
];

describe('API-v1 RTC RTT recipe execution', () => {
    it.each(CASES)('strictly validates every expanded connection in $recipe', (testCase) => {
        const report = runRecipeCli(testCase.recipe, ['--validate', '--strict']);
        expect(report.status, report.stderr).toBe(0);
        expect(JSON.parse(report.stdout)).toMatchObject({ ok: true, connections: { missing: [] } });
    });

    it.each(CASES)('sends from the canonical socket with either session order in $recipe', async (testCase) => {
        const expansion = runRecipeCli(testCase.recipe, ['-e', 'dry']);
        expect(expansion.status, expansion.stderr).toBe(0);
        const compiled = flattenRecipeInteractions(JSON.parse(expansion.stdout));
        const reportSteps = testCase.steps.map((name) => {
            const operation = compiled.find((interaction) => Object.hasOwn(interaction, name));
            if (!operation) {
                throw new Error(`Missing authored RTT operation ${name}`);
            }
            return operation;
        });
        const capture = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        const reports: CapturedReport[] = [];
        capture.on('connection', (socket, request) => {
            socket.on('message', (data) =>
                reports.push({
                    connection: request.url ?? '',
                    message: decodePersistedALMessage(data.toString())
                }));
        });
        await once(capture, 'listening');
        const address = capture.address();
        if (typeof address === 'string' || address === null) {
            throw new Error('Expected local WebSocket listener');
        }

        try {
            for (const sessionIds of [['a-session', 'z-session'], ['z-session', 'a-session']]) {
                reports.length = 0;
                const setup = testCase.sessions.map((output, index) => ({
                    SET: { request: { output, value: sessionIds[index] }, response: {} },
                    [`seed-${output}`]: { type: 'set' }
                }));
                const opens = testCase.connections.map((connection) => ({
                    WS: { request: { action: 'open', connection, url: `ws://127.0.0.1:${address.port}/${connection}` }, response: {} },
                    [`open-${connection}`]: { type: 'ws.open' }
                }));
                const result = await executeBlackBox([...setup, ...opens, ...structuredClone(reportSteps)], 0, { failFast: true });
                expect(result, JSON.stringify(result.results)).toMatchObject({ summary: { failure: 0 } });
                await vi.waitFor(() => expect(reports).toHaveLength(1));
                expect(reports[0].connection).toBe(`/${testCase.connections[sessionIds[0] === 'a-session' ? 0 : 1]}`);
                expect(reports[0].message.id).toMatchObject({ senderId: 'a-session', sessionId: 'a-session' });
                expect(JSON.parse(reports[0].message.payload.resource)).toMatchObject({
                    sessionIdFrom: 'a-session',
                    sessionIdTo: 'z-session',
                    version: 1
                });
            }
        }
        finally {
            for (const socket of capture.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve, reject) => capture.close((error) => error ? reject(error) : resolve()));
        }
    });
});

function runRecipeCli(recipe: string, args: readonly string[]) {
    return spawnSync('deno', ['run', '-A', CLI, '-w', RECIPE_ROOT, '-c', recipe, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000
    });
}

function flattenRecipeInteractions(interactions: readonly RecipeInteraction[]): RecipeInteraction[] {
    return interactions.flatMap((interaction) => [
        interaction,
        ...interaction.PARALLEL?.request.groups.flatMap((group) => flattenRecipeInteractions(group.steps)) ?? []
    ]);
}
