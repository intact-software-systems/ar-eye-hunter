import * as Playwright from '@playwright/test';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { runRecipePairOnTwoAgents, type TwoAgentRun } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';

interface PostedCommand {
    readonly url: string;
    readonly commandId: string;
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
                const request = await Playwright.request.newContext();
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
                    posted.push({ url, commandId: data.commandId, command: decoded.envelope.command });
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
                });
                const run: TwoAgentRun = {
                    request,
                    runId: 'actual-local-run',
                    group,
                    sender: {
                        agentId: 'actual-sender',
                        actor: 'sender',
                        connection: 'sender',
                        get context(): Playwright.BrowserContext {
                            throw new Error('Enqueue must not create a browser context.');
                        },
                        get page(): Playwright.Page {
                            throw new Error('Enqueue must not replace the sender page.');
                        }
                    },
                    receiver: {
                        agentId: 'actual-receiver',
                        actor: 'receiver',
                        connection: 'receiver',
                        get context(): Playwright.BrowserContext {
                            throw new Error('Enqueue must not create a browser context.');
                        },
                        get page(): Playwright.Page {
                            throw new Error('Enqueue must not replace receiver subscriptions.');
                        }
                    },
                    readSnapshot: async () => {
                        readBeforeBothEnqueued ||= posted.length !== 2;
                        return { results: posted.map((command) => ({ commandId: command.commandId, ok: true })) };
                    },
                    close: async () => {
                        throw new Error('Enqueue must not close the agents.');
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
                }
            }
        );
    }
});
