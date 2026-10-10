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

import type { RecipePairRun } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';
import { openSuccessorPage, runRecipeTrioOnSameContext } from '../../../tests/playwright/rallar-black-box/full-stack-same-context-run.ts';

const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('same-context ALM run', () => {
    it('selects durable-takeover on every carrier and flush-on-hide over ws and rtc for the same-context family', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const sameContext = createAlmConformanceRecipes({
                group,
                carrier,
                typeId: 'probe',
                senderConnection: 'sender',
                receiverConnection: 'receiver',
                deadlineMs: 18_000
            }).filter((scenario) => scenario.laneFamily === 'same-context');

            expect(sameContext.map((scenario) => scenario.scenarioKey), carrier)
                .toEqual(carrier === 'rtc-with-ws-fallback' ? ['durable-takeover'] : ['durable-takeover', 'flush-on-hide']);
            expect(sameContext.every((scenario) => scenario.successor !== undefined), carrier).toBe(true);
        }
    });

    // One auth session keeps one server socket: the successor connects only once the owner page is gone.
    it.each(
        [
            ['close', ['close-owner']],
            ['flush-and-crash', ['dispatch:freeze', 'settle', 'Page.crash', 'crashed', 'close-owner']]
        ] as const
    )('runs the owner\'s recipe, ends the owner page by %s, then runs the successor, the receiver started first', async (ownerEnd, ending) => {
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
        const browser = await Playwright.chromium.launch({ headless: true });
        const context = await browser.newContext();
        const ownerPage = await context.newPage();
        const close = ownerPage.close.bind(ownerPage);
        vi.spyOn(ownerPage, 'close').mockImplementation(async () => {
            await close();
            order.push('close-owner');
        });
        await ownerPage.exposeFunction('observeFreeze', () => order.push('dispatch:freeze'));
        await ownerPage.evaluate(() =>
            document.addEventListener('freeze', () => {
                Reflect.get(window, 'observeFreeze')();
            })
        );
        const wait = ownerPage.waitForTimeout.bind(ownerPage);
        vi.spyOn(ownerPage, 'waitForTimeout').mockImplementation(async (ms) => {
            expect(ms).toBe(250);
            await wait(ms);
            order.push('settle');
        });
        const createSession = context.newCDPSession.bind(context);
        vi.spyOn(context, 'newCDPSession').mockImplementation(async (page) => {
            const session = await createSession(page);
            const send = session.send.bind(session);
            vi.spyOn(session, 'send').mockImplementation(async (...args) => {
                order.push(args[0]);
                return await send(...args);
            });
            return session;
        });
        ownerPage.on('crash', () => order.push('crashed'));
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
            order.push(data.commandId);
            return await post(responseUrl, options);
        });
        const run: RecipePairRun = {
            request,
            runId: 'same-context-run',
            sender: { agentId: 'owner-agent' },
            receiver: { agentId: 'receiver-agent' },
            readSnapshot: async () => ({
                runId: 'same-context-run',
                createdAtEpochMs: 1,
                updatedAtEpochMs: 2,
                agents: [],
                commands: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
                results: order.filter((commandId) => commandId.endsWith('-run')).map((commandId) => ({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'same-context-run',
                    agentId: 'observed-agent',
                    commandId,
                    ok: true
                }))
            })
        };
        try {
            const outcome = await runRecipeTrioOnSameContext(
                run,
                { owner: { ...run.sender, page: ownerPage }, successor: { agentId: 'successor-agent' }, ownerEnd },
                { sender: baseline.sender, receiver: baseline.receiver, successor }
            );

            expect(order).toEqual([
                `${baseline.receiver.recipeId}-run`,
                `${baseline.sender.recipeId}-run`,
                ...ending,
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
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await browser.close();
        }
    });
});

it('closes a newly opened successor page when registration fails, keeping its shared owner context usable', async () => {
    const browser = await Playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const ownerPage = await context.newPage();
    const request = await Playwright.request.newContext();
    const failure = new Error('successor registration read failed');
    vi.spyOn(request, 'get').mockRejectedValueOnce(failure);
    await context.addInitScript(() =>
        localStorage.setItem(
            'auth.session',
            JSON.stringify({
                clientId: 'fixture-client',
                username: 'fixture-user',
                sessionId: 'fixture-session',
                accessToken: 'fixture-token',
                expiresAtEpochMs: 1
            })
        )
    );
    await context.route('**/*', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<button role="tab" aria-selected="true">Advanced</button><div id="panel-local-workbench"><div class="control-panel">registered</div></div>'
        }));
    let acquired: Playwright.Page | undefined;
    context.on('page', (page) => acquired = page);
    const owner = { agentId: 'owner', actor: 'owner', connection: 'sender', context, page: ownerPage };
    const run = {
        request,
        runId: 'successor-lifetime',
        group
    };
    try {
        await expect(openSuccessorPage({
            run,
            owner,
            testInfo: { project: { name: 'successor' }, workerIndex: 0, titlePath: ['successor'] }
        })).rejects.toBe(failure);
        expect(acquired?.isClosed()).toBe(true);
        expect(ownerPage.isClosed()).toBe(false);
        expect(browser.contexts()).toContain(context);
        await expect(ownerPage.evaluate(() => 42)).resolves.toBe(42);
    }
    finally {
        vi.restoreAllMocks();
        await request.dispose();
        await context.close();
        await browser.close();
    }
});
