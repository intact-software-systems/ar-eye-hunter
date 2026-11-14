import * as Playwright from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunArtifactBundle, ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import {
    createTwoAgentRun,
    exportControlRunArtifacts,
    loginUser,
    openBrowserControlAgent,
    openBrowserControlAgentInContext,
    readBrowserAuthSession,
    readControlRun,
    readFullStackConfig,
    runRecipePairOnTwoAgents,
    runWithRallarReceiverPage,
    startRecipeRun,
    startRecipientRecipeRun,
    type RecipePairRun,
    type RecipeRun
} from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';

import { runRecipesOnAgents } from '../../../tests/playwright/rallar-black-box/full-stack-agent-run.ts';
import { runRecipeTrioOnSameContext } from '../../../tests/playwright/rallar-black-box/full-stack-same-context-run.ts';

import { openRecordingControlRequest, type RecordingControlRequest } from './recording-control-request-fixture.ts';

let browser: Playwright.Browser;

const snapshot = {
    runId: 'valid',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 2,
    agents: [],
    commands: [],
    results: [],
    events: [],
    stats: [],
    reports: [],
    heartbeats: []
} satisfies ControlRunSnapshot;

const artifact = {
    artifactSchemaVersion: 1,
    runId: 'valid',
    generatedAtEpochMs: 3,
    files: {
        'report.json': '{}',
        'results.jsonl': '',
        'events.jsonl': '',
        'failures.json': '{}',
        'metadata.json': '{}'
    }
} satisfies ControlRunArtifactBundle;

describe('full-stack helper HTTP boundaries', () => {
    it.each([
        {
            boundary: 'control snapshot',
            read: readControlRun,
            valid: snapshot,
            malformed: { ...snapshot, results: 'not an envelope collection' }
        },
        {
            boundary: 'ordinary control artifact',
            read: exportControlRunArtifacts,
            valid: artifact,
            malformed: { ...artifact, files: { 'report.json': '{}' } }
        }
    ])('rejects malformed successful JSON at the $boundary handoff', async ({ read, valid, malformed }) => {
        const server = createServer((request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(request.url?.includes('/invalid') ? malformed : valid));
        });
        const tunnels = new Set<Duplex>();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                throw new Error('The test response server did not bind an HTTP port.');
            }
            server.on('connect', (_request, socket, head) => {
                tunnels.add(socket);
                const upstream = createConnection(address.port, '127.0.0.1');
                upstream.once('connect', () => {
                    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    upstream.write(head);
                    socket.pipe(upstream).pipe(socket);
                });
                upstream.on('error', () => socket.destroy());
                socket.on('error', () => upstream.destroy());
                socket.once('close', () => {
                    tunnels.delete(socket);
                    upstream.destroy();
                });
            });
            const request = await Playwright.request.newContext({
                proxy: { server: `http://127.0.0.1:${address.port}` }
            });
            try {
                await expect(read(request, 'valid')).resolves.toEqual(valid);
                await expect(read(request, 'invalid')).rejects.toThrow();
            }
            finally {
                await request.dispose();
            }
        }
        finally {
            for (const tunnel of tunnels) {
                tunnel.destroy();
            }
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
});

beforeAll(async () => {
    browser = await Playwright.chromium.launch({ headless: true });
});

afterAll(async () => {
    await browser.close();
});

describe('full-stack acquired browser lifetime', () => {
    it.each(['page creation', 'navigation'])('closes an owned context after %s fails and preserves the failure', async (stage) => {
        const failure = new Error(`owned ${stage} failed`);
        const createContext = browser.newContext.bind(browser);
        let acquired: Playwright.BrowserContext | undefined;
        vi.spyOn(browser, 'newContext').mockImplementationOnce(async (options) => {
            acquired = await createContext(options);
            if (stage === 'page creation') {
                vi.spyOn(acquired, 'newPage').mockRejectedValueOnce(failure);
            }
            else {
                acquired.on('page', (page) => vi.spyOn(page, 'goto').mockRejectedValueOnce(failure));
            }
            return acquired;
        });
        const config = readFullStackConfig();
        try {
            await expect(
                openBrowserControlAgent({
                    browser,
                    config,
                    user: config.userA,
                    runId: 'lifetime',
                    agentId: 'owned',
                    groupId: 'room',
                    diagnosticsRole: 'sender'
                })
            ).rejects.toBe(failure);
            expect(acquired).toBeDefined();
            expect(browser.contexts()).not.toContain(acquired);
        }
        finally {
            vi.restoreAllMocks();
            await acquired?.close();
        }
    });

    it('closes only the newly acquired page and capture when a borrowed context setup fails', async () => {
        const context = await browser.newContext();
        const existing = await context.newPage();
        const failure = new Error('borrowed navigation failed');
        let acquired: Playwright.Page | undefined;
        context.on('page', (page) => {
            acquired = page;
            vi.spyOn(page, 'goto').mockRejectedValueOnce(failure);
        });
        const config = readFullStackConfig();
        try {
            await expect(openBrowserControlAgentInContext(context, {
                config,
                user: config.userA,
                runId: 'lifetime',
                agentId: 'borrowed',
                groupId: 'room',
                diagnosticsRole: 'sender'
            })).rejects.toBe(failure);
            expect(acquired?.isClosed()).toBe(true);
            if (acquired === undefined) {
                throw new Error('Expected the actual acquired page.');
            }
            const listenerCount: unknown = Reflect.get(acquired, 'listenerCount');
            if (typeof listenerCount !== 'function') {
                throw new Error('The actual page has no listener observation port.');
            }
            expect(listenerCount.call(acquired, 'pageerror')).toBe(0);
            expect(listenerCount.call(acquired, 'console')).toBe(0);
            expect(browser.contexts()).toContain(context);
            expect(existing.isClosed()).toBe(false);
            await expect(existing.evaluate(() => 42)).resolves.toBe(42);
        }
        finally {
            vi.restoreAllMocks();
            await context.close();
        }
    });

    it('cleans the completed first participant and partially acquired second context after pair opening fails', async () => {
        const failure = new Error('second participant page failed');
        const acquired: Playwright.BrowserContext[] = [];
        const createContext = browser.newContext.bind(browser);
        vi.spyOn(browser, 'newContext').mockImplementation(async (options) => {
            const context = await createContext(options);
            acquired.push(context);
            if (acquired.length === 2) {
                vi.spyOn(context, 'newPage').mockRejectedValueOnce(failure);
            }
            else {
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
                        body:
                            '<button role="tab" aria-selected="true">Advanced</button><div id="panel-local-workbench"><div class="control-panel">registered</div></div>'
                    }));
            }
            return context;
        });
        const request = await Playwright.request.newContext();
        try {
            await expect(createTwoAgentRun({
                browser,
                request,
                runId: 'lifetime',
                testInfo: { project: { name: 'lifetime' }, workerIndex: 0, titlePath: ['lifetime'] }
            })).rejects.toBe(failure);
            expect(acquired).toHaveLength(2);
            expect(browser.contexts().filter((context) => acquired.includes(context))).toEqual([]);
        }
        finally {
            vi.restoreAllMocks();
            await Promise.all(acquired.map((context) => context.close()));
            await request.dispose();
        }
    });
});

describe('recipient recipe promise ownership', () => {
    it('observes an enqueue rejection while the connect barrier is pending and stops barrier work', async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const request = await Playwright.request.newContext();
        const failure = new Error('recipient enqueue failed');
        const barrier = Promise.withResolvers<ControlRunSnapshot>();
        let reads = 0;
        const baseline = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
            carrier: 'ws',
            typeId: 'lifetime',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000,
            laneFamilies: ['two-agent'],
            principalIdsByRole: {}
        }).find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const participant = { agentId: 'recipient', actor: 'recipient', connection: 'recipient', context, page };
        const run: RecipeRun = {
            request,
            runId: 'lifetime',
            startedRoots: [],
            readSnapshot: async () => {
                reads++;
                return barrier.promise;
            }
        };
        vi.spyOn(request, 'post').mockRejectedValueOnce(failure);
        const started = startRecipientRecipeRun(run, participant, baseline.receiver);
        const observed = started.then(() => undefined, (error: unknown) => error);
        try {
            await expect(Promise.race([observed, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 30))]))
                .resolves.toBe(failure);
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(reads).toBe(0);
        }
        finally {
            barrier.resolve({
                ...snapshot,
                runId: 'lifetime',
                results: [{
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'lifetime',
                    agentId: 'recipient',
                    commandId: `${baseline.receiver.recipeId}-run`,
                    ok: true
                }]
            });
            await observed;
            vi.restoreAllMocks();
            await request.dispose();
            await context.close();
        }
    });
});

describe('recipient barrier failure', () => {
    it('accounts for the initiated enqueue before reporting a barrier failure and leaves no result poller', async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const request = await Playwright.request.newContext();
        const server = createServer((_request, response) => {
            response.writeHead(202, { 'content-type': 'application/json' });
            response.end('{}');
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('The test command response server did not bind.');
        }
        const failure = new Error('recipient barrier read failed');
        const enqueue = Promise.withResolvers<void>();
        const post = request.post.bind(request);
        const posted = Promise.withResolvers<void>();
        vi.spyOn(request, 'post').mockImplementation(async (_url, options) => {
            await enqueue.promise;
            try {
                return await post(`http://127.0.0.1:${address.port}`, options);
            }
            finally {
                posted.resolve();
            }
        });
        const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
        const baseline = createAlmConformanceRecipes({
            group,
            carrier: 'ws',
            typeId: 'lifetime',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000,
            laneFamilies: ['two-agent'],
            principalIdsByRole: {}
        }).find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const participant = { agentId: 'recipient', actor: 'recipient', connection: 'recipient', context, page };
        let reads = 0;
        let reported = false;
        const run: RecipeRun = {
            request,
            runId: 'lifetime',
            startedRoots: [],
            readSnapshot: async () => {
                reads++;
                throw failure;
            }
        };
        const observed = startRecipientRecipeRun(run, participant, baseline.receiver).then(
            () => {
                reported = true;
                return undefined;
            },
            (error: unknown) => {
                reported = true;
                return error;
            }
        );
        try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(reported, 'enqueue ownership must settle before recipe setup reports failure').toBe(false);
            enqueue.resolve();
            await expect(observed).resolves.toBe(failure);
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(reads, 'barrier failure must not leave a recipient result poller').toBe(1);
        }
        finally {
            enqueue.resolve();
            await posted.promise;
            await observed;
            vi.restoreAllMocks();
            await request.dispose();
            await context.close();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
});

describe('control poll timeouts', () => {
    const baseline = createAlmConformanceRecipes({
        group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        carrier: 'ws',
        typeId: 'poll-timeout',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000,
        laneFamilies: ['two-agent'],
        principalIdsByRole: {}
    }).find((scenario) => scenario.scenarioId === 'delivery-baseline')!;

    interface SilentRun {
        readonly run: RecipeRun;
        readCount(): number;
    }

    // Each read moves the clock by `stepMs` and finds no event, and only the results `results` lists at the moved clock.
    function createSilentRun(
        request: Playwright.APIRequestContext,
        stepMs: number,
        results: (nowEpochMs: number) => readonly ControlResultEnvelope[] = () => []
    ): SilentRun {
        let nowEpochMs = 1_000;
        let reads = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => nowEpochMs);
        const run: RecipeRun = {
            request,
            runId: 'poll-timeout',
            startedRoots: [],
            readSnapshot: async () => {
                reads += 1;
                nowEpochMs += stepMs;
                return { ...snapshot, runId: 'poll-timeout', results: [...results(nowEpochMs)] };
            }
        };
        return { run, readCount: () => reads };
    }

    const rootCommandId = `${baseline.sender.recipeId}-run`;

    function toFailedRootResult(code: string): ControlResultEnvelope {
        return {
            kind: 'result',
            protocolVersion: 1,
            runId: 'poll-timeout',
            agentId: 'sender',
            commandId: rootCommandId,
            ok: false,
            error: { code, message: `the root ended ${code}` }
        };
    }

    function toPostedKinds(control: RecordingControlRequest): readonly string[] {
        return control.posted.map(({ command }) => command.kind);
    }

    it('enqueues every recipe root with the role deadline as its own timeoutMs', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        try {
            const { run } = createSilentRun(control.request, 60_000);
            await startRecipeRun(run, { agentId: 'sender' }, baseline.sender);

            expect(control.posted.map(({ commandId, command }) => [commandId, command.kind, command.timeoutMs])).toEqual([
                [rootCommandId, 'recipe.run', 180_000]
            ]);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('reads the agent\'s own timeout result that arrives inside the grace after the deadline', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        try {
            // The deadline is at 181 000; the agent's own timeout result lands at 201 000, inside the grace.
            const { run } = createSilentRun(
                control.request,
                20_000,
                (nowEpochMs) => nowEpochMs > 181_000 ? [toFailedRootResult('RALLAR_BLACK_BOX_RECIPE_TIMEOUT')] : []
            );
            const started = await startRecipeRun(run, { agentId: 'sender' }, baseline.sender);

            const outcome = await started.readOutcome();

            expect(outcome).toEqual({ commandId: rootCommandId, ok: false, summary: expect.any(String) });
            expect(outcome.summary.startsWith('RALLAR_BLACK_BOX_RECIPE_TIMEOUT')).toBe(true);
            expect(toPostedKinds(control)).toEqual(['recipe.run']);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('cancels a root with no result after its deadline and grace by a targeted recipe.cancel, and reads the result the cancel brings', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        try {
            // The agent answers only once the lane cancelled the root.
            const { run } = createSilentRun(
                control.request,
                30_000,
                () =>
                    control.posted.some(({ command }) => command.kind === 'recipe.cancel')
                        ? [toFailedRootResult('RALLAR_BLACK_BOX_COMMAND_CANCELLED')]
                        : []
            );
            const started = await startRecipeRun(run, { agentId: 'sender' }, baseline.sender);

            await expect(started.readOutcome()).resolves.toEqual({
                commandId: rootCommandId,
                ok: false,
                summary: 'RALLAR_BLACK_BOX_COMMAND_CANCELLED: the root ended RALLAR_BLACK_BOX_COMMAND_CANCELLED'
            });
            expect(
                control.posted.filter(({ command }) => command.kind === 'recipe.cancel').map(({ commandId, command }) => ({
                    commandId,
                    command
                }))
            ).toEqual([
                {
                    commandId: `cancel-${rootCommandId}`,
                    command: { kind: 'recipe.cancel', targetCommandId: rootCommandId, reason: expect.any(String) }
                }
            ]);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('reads a root once however often its outcome is read, so a later read past the grace cancels nothing', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        try {
            // The root's result is there at the first read, which moves the clock past the deadline and the grace.
            const { run, readCount } = createSilentRun(control.request, 250_000, () => [{
                kind: 'result',
                protocolVersion: 1,
                runId: 'poll-timeout',
                agentId: 'sender',
                commandId: rootCommandId,
                ok: true
            }]);
            const started = await startRecipeRun(run, { agentId: 'sender' }, baseline.sender);

            const first = await started.readOutcome();
            const second = await started.readOutcome();

            expect(second).toEqual(first);
            expect(first).toEqual({ commandId: rootCommandId, ok: true, summary: 'ok' });
            expect(readCount()).toBe(1);
            expect(toPostedKinds(control)).toEqual(['recipe.run']);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('rejects when neither the root nor its cancel settles within the grace, so no later cell runs on the pages', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        try {
            const { run } = createSilentRun(control.request, 30_000);
            const started = await startRecipeRun(run, { agentId: 'sender' }, baseline.sender);

            await expect(started.readOutcome()).rejects.toThrow(
                `${rootCommandId} is still running after its deadline and cancellation`
            );
            expect(toPostedKinds(control)).toEqual(['recipe.run', 'recipe.cancel']);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    const cancelCommandId = `cancel-${rootCommandId}`;

    function toCancelAnswer(
        input: { readonly ok: boolean; readonly value?: Readonly<Record<string, string | boolean>>; readonly error?: { code: string; message: string; }; }
    ): ControlResultEnvelope {
        return {
            kind: 'result',
            protocolVersion: 1,
            runId: 'poll-timeout',
            agentId: 'sender',
            commandId: cancelCommandId,
            ok: input.ok,
            ...(input.error === undefined ? {} : { error: input.error }),
            result: {
                commandId: cancelCommandId,
                kind: 'recipe.cancel',
                status: input.ok ? 'ok' : 'failed',
                ok: input.ok,
                startedAtEpochMs: 0,
                endedAtEpochMs: 0,
                durationMs: 0,
                value: input.value
            }
        };
    }

    // The cancel's answer is there at the first read after the cancel; the root's result, if any, from the second. Each
    // read moves the clock by 25 000 ms, so a lane that waits for the root alone spends a second read of the grace on it.
    async function readOutcomeAfterCancelAnswered(
        answer: ControlResultEnvelope,
        rootResult: readonly ControlResultEnvelope[]
    ): Promise<{ readonly outcome: Promise<unknown>; readonly readsAfterCancel: () => number; close(): Promise<void>; }> {
        const control = await openRecordingControlRequest('poll-timeout');
        let readsAfterCancel = 0;
        const { run } = createSilentRun(control.request, 25_000, () => {
            if (!control.posted.some(({ command }) => command.kind === 'recipe.cancel')) {
                return [];
            }
            readsAfterCancel += 1;
            return readsAfterCancel === 1 ? [answer] : [answer, ...rootResult];
        });
        const started = await startRecipeRun(run, { agentId: 'sender' }, baseline.sender);
        return { outcome: started.readOutcome(), readsAfterCancel: () => readsAfterCancel, close: () => control.close() };
    }

    it('fails the family at once when the cancel is answered target-not-exclusively-active, naming the command and the agent', async () => {
        const refused = toCancelAnswer({
            ok: true,
            value: { cancelRequested: false, targetCommandId: rootCommandId, reason: 'target-not-exclusively-active' }
        });
        const read = await readOutcomeAfterCancelAnswered(refused, []);
        try {
            await expect(read.outcome).rejects.toThrow(
                `recipe.cancel ${cancelCommandId} to agent sender was answered target-not-exclusively-active`
            );
            expect(read.readsAfterCancel()).toBe(1);
        }
        finally {
            vi.restoreAllMocks();
            await read.close();
        }
    });

    it('lets the run end as before when the cancel is answered with the ordinary answer', async () => {
        const accepted = toCancelAnswer({
            ok: true,
            value: { cancelRequested: true, targetCommandId: rootCommandId, reason: 'late' }
        });
        const read = await readOutcomeAfterCancelAnswered(accepted, [toFailedRootResult('RALLAR_BLACK_BOX_COMMAND_CANCELLED')]);
        try {
            await expect(read.outcome).resolves.toEqual({
                commandId: rootCommandId,
                ok: false,
                summary: 'RALLAR_BLACK_BOX_COMMAND_CANCELLED: the root ended RALLAR_BLACK_BOX_COMMAND_CANCELLED'
            });
        }
        finally {
            vi.restoreAllMocks();
            await read.close();
        }
    });

    it.each([
        {
            title: 'a refusal with a reason the lane does not know',
            answer: { ok: true, value: { cancelRequested: false, targetCommandId: rootCommandId, reason: 'something-new' } },
            named: 'was answered an unknown answer'
        },
        {
            title: 'an answer that carries no value',
            answer: { ok: true },
            named: 'was answered an unknown answer'
        },
        {
            title: 'an error answer',
            answer: { ok: false, error: { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', message: 'no such agent' } },
            named: 'was answered the error RALLAR_BLACK_BOX_COMMAND_FAILED: no such agent'
        }
    ])('fails the family at once on $title, naming it', async ({ answer, named }) => {
        const read = await readOutcomeAfterCancelAnswered(toCancelAnswer(answer), []);
        try {
            await expect(read.outcome).rejects.toThrow(`recipe.cancel ${cancelCommandId} to agent sender ${named}`);
            expect(read.readsAfterCancel()).toBe(1);
        }
        finally {
            vi.restoreAllMocks();
            await read.close();
        }
    });

    it('a run handed to the owner as a spread copy still has its started roots awaited, so the observation never reads a page whose root runs', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        try {
            // The clock starts at 1 000 and each read moves it by 1 000, so the root's result lands at the third read; the body
            // fails right after starting it.
            const { run, readCount } = createSilentRun(
                control.request,
                1_000,
                (nowEpochMs) => nowEpochMs >= 4_000 ? [toFailedRootResult('RALLAR_BLACK_BOX_RECIPE_TIMEOUT')] : []
            );
            const observed: { reads: number; posted: readonly string[]; } = { reads: 0, posted: [] };
            const bodyFailure = new Error('the scenario failed after starting a root');

            await expect(runObservedFamily({
                run: { ...run, close: async () => {} },
                testInfo: { errors: [] },
                body: async () => {
                    await startRecipeRun(run, { agentId: 'sender' }, baseline.sender);
                    throw bodyFailure;
                },
                observe: async () => {
                    observed.reads = readCount();
                    observed.posted = toPostedKinds(control);
                }
            })).rejects.toBe(bodyFailure);

            expect(observed.reads).toBeGreaterThanOrEqual(3);
            expect(observed.posted).toEqual(['recipe.run']);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('two runs do not see each other\'s roots', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        try {
            const { run: first, readCount } = createSilentRun(
                control.request,
                1_000,
                (nowEpochMs) => nowEpochMs >= 4_000 ? [toFailedRootResult('RALLAR_BLACK_BOX_RECIPE_TIMEOUT')] : []
            );
            const second: RecipeRun = { ...first, startedRoots: [] };
            const readsWhenObserved: number[] = [];

            await startRecipeRun(first, { agentId: 'sender' }, baseline.sender);
            await runObservedFamily({
                run: { ...second, close: async () => {} },
                testInfo: { errors: [] },
                body: async () => {},
                observe: async () => {
                    readsWhenObserved.push(readCount());
                }
            });

            expect(first.startedRoots.map(({ commandId }) => commandId)).toEqual([rootCommandId]);
            expect(second.startedRoots).toEqual([]);
            expect(readsWhenObserved).toEqual([0]);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('returns a root whose result is present although its cancel was refused', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        try {
            const refused = toCancelAnswer({
                ok: true,
                value: { cancelRequested: false, targetCommandId: rootCommandId, reason: 'target-not-exclusively-active' }
            });
            const { run } = createSilentRun(
                control.request,
                30_000,
                () =>
                    control.posted.some(({ command }) => command.kind === 'recipe.cancel')
                        ? [refused, toFailedRootResult('RALLAR_BLACK_BOX_COMMAND_CANCELLED')]
                        : []
            );
            const started = await startRecipeRun(run, { agentId: 'sender' }, baseline.sender);

            await expect(started.readOutcome()).resolves.toEqual({
                commandId: rootCommandId,
                ok: false,
                summary: 'RALLAR_BLACK_BOX_COMMAND_CANCELLED: the root ended RALLAR_BLACK_BOX_COMMAND_CANCELLED'
            });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('warns and releases the sender when the receiver neither connects nor ends within the barrier timeout', async () => {
        const control = await openRecordingControlRequest('poll-timeout');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { run, readCount } = createSilentRun(control.request, 30_000);
            const connectCommandId = baseline.receiver.commands.find((command) => command.kind === 'rtc.connect')
                ?.commandId;

            const started = await startRecipientRecipeRun(run, { agentId: 'receiver' }, baseline.receiver);

            expect(started.commandId).toBe(`${baseline.receiver.recipeId}-run`);
            expect(readCount()).toBe(2);
            expect(warn).toHaveBeenCalledExactlyOnceWith('Receiver connect barrier timed out; releasing the sender anyway', {
                runId: 'poll-timeout',
                connectCommandId,
                runCommandId: started.commandId,
                timeoutMs: 60_000
            });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });
});

it.each([undefined, false, true])('projects the optional leave-room intent %s at the actual navigation port', async (leaveRoomOnClose) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const config = readFullStackConfig();
    const sentinel = new Error('Owned navigation completed; auth UI is outside this query boundary.');
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Navigation boundary</h1>' }));
    const goto = page.goto.bind(page);
    vi.spyOn(page, 'goto').mockImplementation(async (url, options) => {
        await goto(url, options);
        throw sentinel;
    });
    try {
        await expect(
            loginUser({
                page,
                config,
                user: config.userA,
                groupId: 'query-room',
                sessionId: 'query-session',
                ...(leaveRoomOnClose === undefined ? {} : { rallarLeaveRoomOnClose: leaveRoomOnClose })
            })
        ).rejects.toBe(sentinel);
        const query = new URL(page.url()).searchParams;
        expect(query.get('rallarLeaveRoomOnClose')).toBe(leaveRoomOnClose === undefined ? null : leaveRoomOnClose ? '1' : '0');
        expect(query.get('roomId')).toBe('query-room');
        expect(query.get('sessionId')).toBe('query-session');
    }
    finally {
        vi.restoreAllMocks();
        await context.close();
    }
});

it('validates the mandatory auth handoff at actual browser storage', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Storage boundary</h1>' }));
    const valid = {
        clientId: 'storage-client',
        username: 'storage-user',
        sessionId: 'storage-session',
        accessToken: 'storage-fixture-token',
        expiresAtEpochMs: 1
    };
    try {
        await page.goto('http://localhost/storage-boundary');
        await page.evaluate((session) => localStorage.setItem('auth.session', JSON.stringify(session)), valid);
        await expect(readBrowserAuthSession(page)).resolves.toEqual(valid);
        for (const invalid of [{ ...valid, clientId: '' }, { ...valid, sessionId: 1 }, { ...valid, expiresAtEpochMs: null }]) {
            await page.evaluate((session) => localStorage.setItem('auth.session', JSON.stringify(session)), invalid);
            await expect(readBrowserAuthSession(page)).rejects.toThrow('authentication session is missing or invalid');
        }
    }
    finally {
        await context.close();
    }
});

describe('recipient outcome ownership after its connect barrier', () => {
    it.each(
        [
            { runner: 'agents', fault: 'snapshot', held: 'third enqueue' },
            { runner: 'same-context', fault: 'snapshot', held: 'owner enqueue' },
            { runner: 'agents', fault: 'operation', held: 'third enqueue' },
            { runner: 'same-context', fault: 'operation', held: 'owner enqueue' },
            { runner: 'same-context', fault: 'page end', held: 'owner page close' },
            { runner: 'pair', fault: 'operation', held: 'sender enqueue' }
        ] as const
    )('owns $fault failure during $held in the $runner run', async ({ runner, fault }) => {
        const baseline = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
            carrier: 'ws',
            typeId: 'outcome-owner',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000,
            laneFamilies: ['two-agent'],
            principalIdsByRole: {}
        }).find((scenario) => scenario.scenarioId === 'delivery-baseline');
        if (baseline === undefined) {
            throw new Error('Expected the real delivery-baseline recipes.');
        }
        const third = { ...baseline.receiver, recipeId: 'outcome-third' };
        const successor = { ...baseline.sender, recipeId: 'outcome-successor' };
        const receiverCommandId = `${baseline.receiver.recipeId}-run`;
        const senderCommandId = `${baseline.sender.recipeId}-run`;
        const receiverConnectId = baseline.receiver.commands.find((command) => command.kind === 'rtc.connect')?.commandId;
        if (receiverConnectId === undefined) {
            throw new Error('Expected the actual receiver connect command.');
        }
        const posted: string[] = [];
        const responseSnapshot: ControlRunSnapshot = {
            ...snapshot,
            runId: 'outcome-owner',
            events: [{
                kind: 'event',
                protocolVersion: 1,
                runId: 'outcome-owner',
                agentId: 'recipient',
                commandId: receiverConnectId,
                atEpochMs: 1,
                payload: { topic: 'rallar.bb.command.result', payload: { ok: true } }
            }]
        };
        const server = createServer((_request, response) => {
            response.writeHead(_request.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ...responseSnapshot,
                results: posted.filter((commandId) => commandId !== receiverCommandId).map((commandId) => ({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'outcome-owner',
                    agentId: 'other-agent',
                    commandId,
                    ok: true
                }))
            }));
        });
        const failure = new Error(`${runner} ${fault} original failure`);
        const operationEntered = Promise.withResolvers<void>();
        const operationRelease = Promise.withResolvers<void>();
        const snapshotFailureRelease = Promise.withResolvers<void>();
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown): void => {
            unhandled.push(error);
        };
        process.on('unhandledRejection', onUnhandled);
        let ownedContext: Playwright.BrowserContext | undefined;
        let ownedRequest: Playwright.APIRequestContext | undefined;
        let ownedObservation: Promise<unknown> | undefined;
        try {
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            const address = server.address();
            if (address === null || typeof address === 'string') {
                throw new Error('Expected the owned control response HTTP port.');
            }
            const context = await browser.newContext();
            ownedContext = context;
            const page = await context.newPage();
            const request = await Playwright.request.newContext();
            ownedRequest = request;
            const responseUrl = `http://127.0.0.1:${address.port}`;
            let reads = 0;
            let readsAfterDispose = 0;
            let activeReads = 0;
            let disposed = false;
            const get = request.get.bind(request);
            vi.spyOn(request, 'get').mockImplementation(async (_url, options) => {
                reads++;
                activeReads++;
                try {
                    if (disposed) {
                        readsAfterDispose++;
                    }
                    if (fault === 'snapshot' && reads > 1) {
                        await snapshotFailureRelease.promise;
                        throw failure;
                    }
                    return await get(responseUrl, options);
                }
                finally {
                    activeReads--;
                }
            });
            const post = request.post.bind(request);
            const heldCommandId = runner === 'agents' ? `${third.recipeId}-run` : senderCommandId;
            vi.spyOn(request, 'post').mockImplementation(async (_url, options) => {
                const data = options?.data;
                if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
                    throw new Error('Expected the actual authored command envelope.');
                }
                posted.push(data.commandId);
                if (fault !== 'page end' && data.commandId === heldCommandId) {
                    operationEntered.resolve();
                    await operationRelease.promise;
                    if (fault === 'operation') {
                        throw failure;
                    }
                }
                return await post(responseUrl, options);
            });
            if (fault === 'page end') {
                vi.spyOn(page, 'close').mockImplementationOnce(async () => {
                    operationEntered.resolve();
                    await operationRelease.promise;
                    throw failure;
                });
            }
            const run: RecipePairRun = {
                request,
                runId: 'outcome-owner',
                sender: { agentId: 'sender' },
                receiver: { agentId: 'recipient' },
                startedRoots: [],
                readSnapshot: () => readControlRun(request, 'outcome-owner')
            };
            const running = runner === 'agents'
                ? runRecipesOnAgents(
                    {
                        ...run,
                        agents: new Map([['sender', run.sender], ['receiver', run.receiver], ['recipient-b', { agentId: 'third' }]])
                    },
                    new Map([['sender', baseline.sender], ['receiver', baseline.receiver], ['recipient-b', third]]),
                    undefined
                )
                : runner === 'same-context'
                ? runRecipeTrioOnSameContext(run, {
                    owner: { ...run.sender, page },
                    successor: { agentId: 'successor' },
                    ownerEnd: 'close',
                    successorGate: undefined
                }, { sender: baseline.sender, receiver: baseline.receiver, successor })
                : runRecipePairOnTwoAgents(run, { sender: baseline.sender, receiver: baseline.receiver });
            const observed = running.then(() => undefined, (error: unknown) => error);
            ownedObservation = observed;
            await Promise.race([
                operationEntered.promise,
                observed.then((error) => {
                    throw error ?? new Error('Run settled before the held operation was reached.');
                })
            ]);
            expect(posted[0], 'the real receiver enqueue precedes every later operation').toBe(receiverCommandId);
            if (fault === 'snapshot') {
                snapshotFailureRelease.resolve();
                await new Promise((resolve) => setTimeout(resolve, 30));
                expect(unhandled, 'receiver outcome rejection must have an owner throughout the held operation').toEqual([]);
            }
            operationRelease.resolve();
            await expect(observed).resolves.toBe(failure);
            expect(activeReads, 'failed orchestration must join every initiated receiver HTTP read').toBe(0);
            disposed = true;
            await request.dispose();
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(readsAfterDispose, 'failed orchestration must not leave receiver observation reading a disposed request').toBe(0);
            expect(unhandled, 'all initiated observation failures must remain owned').toEqual([]);
        }
        finally {
            snapshotFailureRelease.resolve();
            operationRelease.resolve();
            try {
                await ownedObservation;
                await ownedRequest?.dispose();
                if (ownedObservation !== undefined) {
                    // Preserve delayed errors before retiring this test's event observation.
                    await new Promise((resolve) => setTimeout(resolve, 300));
                }
            }
            finally {
                process.off('unhandledRejection', onUnhandled);
                vi.restoreAllMocks();
                try {
                    await ownedContext?.close();
                }
                finally {
                    server.closeAllConnections();
                    if (server.listening) {
                        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
                    }
                }
            }
        }
    });
});

describe('owned Rallar receiver originating errors', () => {
    it.each(['page creation', 'body', 'evidence'])('retains %s failure together with a later real-port cleanup failure', async (stage) => {
        const original = new Error(`${stage} failed`);
        const cleanup = new Error('later cleanup failed');
        const senderContext = await browser.newContext();
        let acquired: Playwright.BrowserContext | undefined;
        let receiver: Playwright.Page | undefined;
        let contextCloseCalls = 0;
        try {
            await senderContext.route(
                'http://receiver-lifetime.test/',
                (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Owned page</title>' })
            );
            const sender = await senderContext.newPage();
            await sender.goto('http://receiver-lifetime.test/');
            const createContext = browser.newContext.bind(browser);
            vi.spyOn(browser, 'newContext').mockImplementationOnce(async (options) => {
                acquired = await createContext(options);
                await acquired.route(
                    'http://receiver-lifetime.test/',
                    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Owned page</title>' })
                );
                const closeContext = acquired.close.bind(acquired);
                vi.spyOn(acquired, 'close').mockImplementationOnce(async () => {
                    contextCloseCalls += 1;
                    await closeContext();
                    if (stage !== 'evidence') {
                        throw cleanup;
                    }
                });
                if (stage === 'page creation') {
                    vi.spyOn(acquired, 'newPage').mockRejectedValueOnce(original);
                }
                return acquired;
            });
            const senderEvaluation = vi.spyOn(sender, 'evaluate');
            if (stage === 'evidence') {
                senderEvaluation.mockRejectedValueOnce(cleanup);
            }
            const reported = await runWithRallarReceiverPage({
                browser,
                sender,
                run: async (page) => {
                    receiver = page;
                    await page.goto('http://receiver-lifetime.test/');
                    vi.spyOn(page, 'evaluate').mockRejectedValueOnce(original);
                    if (stage === 'body') {
                        await page.evaluate(() => document.title);
                    }
                },
                captureEvidence: async (page) => {
                    if (stage === 'evidence' && page !== undefined) {
                        await page.evaluate(() => document.title);
                    }
                }
            }).then(() => undefined, (error: unknown) => error);
            expect(contextCloseCalls).toBe(1);
            expect(senderEvaluation).toHaveBeenCalledTimes(1);
            expect(receiver?.isClosed() ?? stage === 'page creation').toBe(true);
            expect(reported).toBeInstanceOf(AggregateError);
            if (!(reported instanceof AggregateError)) {
                throw new Error('Originating and cleanup failures were not both retained.', { cause: reported });
            }
            expect(reported.cause).toBe(original);
            expect(reported.errors).toEqual(expect.arrayContaining([original, cleanup]));
        }
        finally {
            vi.restoreAllMocks();
            try {
                await acquired?.close();
            }
            finally {
                await senderContext.close();
            }
        }
    });

    it('retains the single body failure identity while completing evidence and cleanup', async () => {
        const original = new Error('single body failure');
        const senderContext = await browser.newContext();
        let receiver: Playwright.Page | undefined;
        let evidenceCalls = 0;
        try {
            await senderContext.route(
                'http://receiver-lifetime.test/',
                (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Owned page</title>' })
            );
            const sender = await senderContext.newPage();
            await sender.goto('http://receiver-lifetime.test/');
            const reported = await runWithRallarReceiverPage({
                browser,
                sender,
                run: async (page) => {
                    receiver = page;
                    await page.route(
                        'http://receiver-lifetime.test/',
                        (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Owned page</title>' })
                    );
                    await page.goto('http://receiver-lifetime.test/');
                    vi.spyOn(page, 'evaluate').mockRejectedValueOnce(original);
                    await page.evaluate(() => document.title);
                },
                captureEvidence: async () => {
                    evidenceCalls += 1;
                }
            }).then(() => undefined, (error: unknown) => error);
            expect(reported).toBe(original);
            expect(evidenceCalls).toBe(1);
            expect(receiver?.isClosed()).toBe(true);
            expect(sender.isClosed()).toBe(false);
        }
        finally {
            vi.restoreAllMocks();
            await senderContext.close();
        }
    });

    it('completes receiver body, evidence, sender cleanup, receiver cleanup and context close in order', async () => {
        const senderContext = await browser.newContext();
        const sequence: string[] = [];
        let receiver: Playwright.Page | undefined;
        try {
            await senderContext.route(
                'http://receiver-lifetime.test/',
                (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Owned page</title>' })
            );
            const sender = await senderContext.newPage();
            await sender.goto('http://receiver-lifetime.test/');
            const evaluateSender = sender.evaluate.bind(sender);
            vi.spyOn(sender, 'evaluate').mockImplementation((...args) => {
                sequence.push('sender cleanup');
                return evaluateSender(...args);
            });
            await runWithRallarReceiverPage({
                browser,
                sender,
                run: async (page) => {
                    receiver = page;
                    await page.route(
                        'http://receiver-lifetime.test/',
                        (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Owned page</title>' })
                    );
                    await page.goto('http://receiver-lifetime.test/');
                    const evaluateReceiver = page.evaluate.bind(page);
                    vi.spyOn(page, 'evaluate').mockImplementation((...args) => {
                        sequence.push('receiver cleanup');
                        return evaluateReceiver(...args);
                    });
                    const closeContext = page.context().close.bind(page.context());
                    vi.spyOn(page.context(), 'close').mockImplementation(async () => {
                        sequence.push('context close');
                        await closeContext();
                    });
                    sequence.push('body');
                },
                captureEvidence: async () => {
                    sequence.push('evidence');
                }
            });
            expect(sequence).toEqual(['body', 'evidence', 'sender cleanup', 'receiver cleanup', 'context close']);
            expect(receiver?.isClosed()).toBe(true);
            expect(sender.isClosed()).toBe(false);
        }
        finally {
            vi.restoreAllMocks();
            await senderContext.close();
        }
    });

    it('retains the body failure and every later evidence and cleanup failure', async () => {
        const bodyFailure = new Error('original body failure');
        const evidenceFailure = new Error('evidence failure');
        const senderFailure = new Error('sender cleanup failure');
        const receiverFailure = new Error('receiver cleanup failure');
        const closeFailure = new Error('context close failure');
        const senderContext = await browser.newContext();
        let acquired: Playwright.BrowserContext | undefined;
        let receiver: Playwright.Page | undefined;
        let closeCalls = 0;
        try {
            await senderContext.route(
                'http://receiver-lifetime.test/',
                (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Owned page</title>' })
            );
            const sender = await senderContext.newPage();
            await sender.goto('http://receiver-lifetime.test/');
            vi.spyOn(sender, 'screenshot').mockRejectedValueOnce(evidenceFailure);
            vi.spyOn(sender, 'evaluate').mockRejectedValueOnce(senderFailure);
            const createContext = browser.newContext.bind(browser);
            vi.spyOn(browser, 'newContext').mockImplementationOnce(async (options) => {
                const context = await createContext(options);
                acquired = context;
                const closeContext = context.close.bind(context);
                vi.spyOn(context, 'close').mockImplementationOnce(async () => {
                    closeCalls += 1;
                    await closeContext();
                    throw closeFailure;
                });
                return context;
            });
            const reported = await runWithRallarReceiverPage({
                browser,
                sender,
                run: async (page) => {
                    receiver = page;
                    await page.route(
                        'http://receiver-lifetime.test/',
                        (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Owned page</title>' })
                    );
                    await page.goto('http://receiver-lifetime.test/');
                    vi.spyOn(page, 'evaluate')
                        .mockRejectedValueOnce(bodyFailure)
                        .mockRejectedValueOnce(receiverFailure);
                    await page.evaluate(() => document.title);
                },
                captureEvidence: async () => {
                    await sender.screenshot();
                }
            }).then(() => undefined, (error: unknown) => error);
            expect(closeCalls).toBe(1);
            expect(receiver?.isClosed()).toBe(true);
            expect(reported).toBeInstanceOf(AggregateError);
            if (!(reported instanceof AggregateError)) {
                throw new Error('All owned failures were not retained.', { cause: reported });
            }
            expect(reported.cause).toBe(bodyFailure);
            expect(reported.errors).toHaveLength(5);
            for (const failure of [bodyFailure, evidenceFailure, senderFailure, receiverFailure, closeFailure]) {
                expect(reported.errors).toContain(failure);
            }
        }
        finally {
            vi.restoreAllMocks();
            try {
                await acquired?.close();
            }
            finally {
                await senderContext.close();
            }
        }
    });
});
