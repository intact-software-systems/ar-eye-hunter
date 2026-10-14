import * as Playwright from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { runRecipePairOnTwoAgents, type RecipePairRun } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';

interface PostedCommand {
    readonly url: string;
    readonly commandId: string;
    readonly agentId: string;
    readonly command: RallarBlackBoxTestCommand;
}

describe('local paired reload enqueue', () => {
    for (const malformed of [false, true]) {
        it(
            malformed
                ? 'rejects missing peer checkpoints before sending either root'
                : 'binds both actual HTTP addresses before waiting for receiver readiness or a root outcome',
            async () => {
                const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
                const scenario = createAlmConformanceRecipes({
                    group,
                    carrier: 'ws',
                    typeId: 'probe',
                    senderConnection: 'sender',
                    receiverConnection: 'receiver',
                    deadlineMs: 18_000
                }).find((candidate) => candidate.scenarioId === 'delivery-reload')!;
                const posted: PostedCommand[] = [];
                let readBeforeBothEnqueued = false;
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
                    const data: unknown = options?.data;
                    if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
                        throw new Error('Expected the actual control HTTP command body.');
                    }
                    const agentId = decodeURIComponent(new URL(url).pathname.split('/').at(-2)!);
                    const decoded = parseControlServerMessage(
                        { kind: 'command', protocolVersion: 1, runId: 'actual-local-run', agentId, ...data },
                        { runId: 'actual-local-run', agentId }
                    );
                    if (!decoded.ok) {
                        throw new Error(decoded.error);
                    }
                    posted.push({ url, commandId: data.commandId, agentId, command: decoded.envelope.command });
                    return await post(responseUrl, options);
                });
                const run: RecipePairRun = {
                    request,
                    runId: 'actual-local-run',
                    sender: { agentId: 'actual-sender' },
                    receiver: { agentId: 'actual-receiver' },
                    readSnapshot: async () => {
                        readBeforeBothEnqueued ||= posted.length !== 2;
                        return {
                            runId: 'actual-local-run',
                            createdAtEpochMs: 1,
                            updatedAtEpochMs: 2,
                            agents: [],
                            commands: [],
                            results: posted.map((command): ControlResultEnvelope => ({
                                kind: 'result',
                                protocolVersion: 1,
                                runId: 'actual-local-run',
                                agentId: command.agentId,
                                commandId: command.commandId,
                                ok: true
                            })),
                            events: [],
                            stats: [],
                            reports: [],
                            heartbeats: []
                        };
                    }
                };
                try {
                    if (malformed) {
                        await expect(runRecipePairOnTwoAgents(run, {
                            sender: scenario.sender,
                            receiver: { ...scenario.receiver, metadata: {} }
                        })).rejects.toThrow('Cannot enqueue paired reload:');
                        expect(posted, 'invalid pairing must not leave a one-sided durable root').toEqual([]);
                        return;
                    }
                    const outcome = await runRecipePairOnTwoAgents(run, scenario);
                    expect(posted.map((command) => new URL(command.url).pathname).sort()).toEqual([
                        '/runs/actual-local-run/agents/actual-receiver/commands',
                        '/runs/actual-local-run/agents/actual-sender/commands'
                    ]);
                    expect(readBeforeBothEnqueued, 'both roots must exist before readiness/result polling').toBe(false);
                    const pair = toAlmReloadPair(posted[0].command);
                    expect(pair).toMatchObject({
                        runId: 'actual-local-run',
                        sender: { agentId: 'actual-sender', commandId: outcome.sender.commandId },
                        receiver: { agentId: 'actual-receiver', commandId: outcome.receiver.commandId }
                    });
                    expect(toAlmReloadPair(posted[1].command)).toEqual(pair);
                    expect(posted.map((command) => command.command.timeoutMs)).toEqual([180_000, 180_000]);
                    expect(outcome).toEqual({
                        sender: { commandId: `${scenario.sender.recipeId}-run`, ok: true, summary: 'ok' },
                        receiver: { commandId: `${scenario.receiver.recipeId}-run`, ok: true, summary: 'ok' }
                    });
                }
                finally {
                    vi.restoreAllMocks();
                    await request.dispose();
                    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
                }
            }
        );
    }
});
