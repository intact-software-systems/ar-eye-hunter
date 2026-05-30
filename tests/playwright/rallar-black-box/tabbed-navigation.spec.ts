import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ARTIFACT_FIXTURE_DIR = path.join(
    REPO_ROOT,
    'packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle',
);

test('opens a tab from the URL and updates tab state in the address bar', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=rtc-diagnostics');

    await expect(page.getByRole('tab', { name: 'RTC Diagnostics' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.locator('#panel-rtc-diagnostics')).toBeVisible();
    const modeSwitch = page.getByLabel('Rallar workspace mode');
    await expect(modeSwitch.getByRole('button', { name: /Rallar Direct live/ })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(page.getByRole('tab', { name: 'Local Workbench' })).toHaveCount(0);
    const trace = page.locator('[aria-label="Rallar browser trace"]');
    await expect(trace).toContainText('Rallar mode');
    await expect(trace).toContainText('Source: Live Rallar events');
    await expect(trace).toContainText('No Rallar browser events');
    await expect(trace).toContainText('Signal WS: not observed');
    await expect(trace).toContainText('RTC: not observed');
    const directPanel = page.getByLabel('Direct Rallar operation boundary');
    await expect(directPanel).toContainText('Direct Rallar Operations');
    await expect(directPanel).toContainText('real backend required');
    await expect(directPanel).toContainText('provider=browser-rallar');
    await expect(page.getByRole('button', { name: 'Replay Sample' })).toHaveCount(0);

    await trace.getByRole('button', { name: 'Event Stream' }).click();
    await expect(page).toHaveURL(/tab=event-stream/);
    await expect(page.locator('#panel-event-stream')).toBeVisible();

    await page.getByRole('tab', { name: 'Rallar Server' }).click();

    await expect(page).toHaveURL(/tab=rallar-server/);
    await expect(page.locator('#panel-rallar-server')).toBeVisible();

    await modeSwitch.getByRole('button', { name: /Rallar black-box-runner/ }).click();
    await expect(page).toHaveURL(/workspace=black-box-runner/);
    await expect(page.getByRole('tab', { name: 'Shared Test' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(directPanel).toHaveCount(0);
    await expect(trace).toContainText('black-box-runner mode');
    await expect(trace).toContainText('Source: Runner/control events');
    await expect(page.getByRole('button', { name: 'Replay Sample' })).toBeVisible();
});

test('opens Quick Test as the default Rallar workspace screen', async ({ page }) => {
    await page.goto('/?provider=simulated&roomId=bb-group');

    await expect(page.getByRole('tab', { name: 'Quick Test' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    const panel = page.getByLabel('Rallar Quick Test');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Provider');
    await expect(panel).toContainText('simulated');
    await expect(panel).toContainText('Group');
    await expect(panel).toContainText('bb-group');
    await expect(panel.getByLabel('Quick Test route')).toContainText('Group bb-group');
    await expect(panel.getByLabel('Quick Test route')).toContainText('room.manual.message / room.manual.message');
    await expect(panel.getByLabel('Payload JSON')).toHaveValue(/hello from quick Rallar test/);
    await expect(panel.getByRole('button', { name: 'Create and join group' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Subscribe WS', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Send WS JSON' })).toBeDisabled();
    await expect(panel).toContainText('Quick Test requires provider=browser-rallar.');

    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await expect(page.getByRole('tab', { name: 'Quick Test' })).toHaveCount(0);
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar Direct live/ })
        .click();
    await expect(page.getByRole('tab', { name: 'Quick Test' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await panel.getByRole('button', { name: 'Open runner mode' }).click();
    await expect(page.getByLabel('Runner mode boundary')).toContainText('Runner Workspace');
    await expect(page.getByRole('tab', { name: 'Shared Test' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
});

test('does not poll control runs while direct Rallar tabs are active', async ({ page }) => {
    const controlRunRequests: string[] = [];
    await page.route('http://localhost:5180/runs**', async route => {
        controlRunRequests.push(route.request().url());
        await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'unexpected control run request' }),
        });
    });

    await page.goto('/?provider=simulated&tab=quick-test');
    await expect(page.getByRole('tab', { name: 'Quick Test' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.locator('#panel-quick-test')).toBeVisible();
    await page.waitForTimeout(300);

    expect(controlRunRequests).toEqual([]);
});

test('keeps Quick Test group stable after create subscribe and send', async ({ page }) => {
    await page.addInitScript(() => {
        const session = {
            clientId: 'alice-client',
            accessToken: 'secret-token-value',
            username: 'alice',
            sessionId: 'alice-session',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        localStorage.setItem('auth.session', JSON.stringify(session));
        (window as any).__quickCreateInputs = [];
        (window as any).__quickJoinInputs = [];
        (window as any).__quickSendInputs = [];
        (window as any).__rallarDirectFacade = {
            configure: () => undefined,
            setDefaults: () => undefined,
            defaults: () => ({}),
            status: () => 'connected',
            isConnected: () => true,
            session: () => session,
            auth: {
                restore: () => session,
            },
            start: async () => ({ session, connected: true }),
            connect: async () => ({ status: 'connected' }),
            disconnect: async () => undefined,
            rooms: {
                current: () => undefined,
                list: () => [],
                create: async (input: Record<string, unknown>) => {
                    (window as any).__quickCreateInputs.push(input);
                    const groupId = typeof input.groupId === 'string'
                        ? input.groupId
                        : 'generated-server-group-id';
                    return {
                        group: {
                            groupId,
                            displayName: input.displayName,
                        },
                    };
                },
                join: async (groupId: string) => {
                    (window as any).__quickJoinInputs.push(groupId);
                    return {
                        group: {
                            groupId,
                            displayName: groupId,
                        },
                    };
                },
            },
            people: {
                list: () => [],
            },
            messages: {
                ws: {
                    send: async (input: Record<string, unknown>) => {
                        (window as any).__quickSendInputs.push(input);
                        return {
                            status: 'sent',
                            transport: 'ws',
                            input,
                        };
                    },
                    onMessage: () => () => undefined,
                },
            },
            ws: {
                status: () => ({ readyState: 'open', isOpen: true }),
                waitForOpen: async () => ({ status: 'open' }),
            },
            rtc: {
                status: () => ({}),
            },
            realtime: {
                health: () => ({ connected: true }),
            },
        };
    });

    await page.goto('/?provider=browser-rallar&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080&roomId=rallar');

    const panel = page.getByLabel('Rallar Quick Test');
    const groupInput = panel.getByRole('textbox', { name: 'Group', exact: true });
    await expect(panel).toBeVisible();
    await expect(page.getByLabel('Global Room')).toHaveValue('rallar');
    await expect(groupInput).toHaveValue('rallar');

    await panel.getByRole('button', { name: 'Create and join group' }).click();
    await expect(page.getByLabel('Global Room')).toHaveValue('rallar');
    await expect(groupInput).toHaveValue('rallar');
    await expect.poll(async () => page.evaluate(() => (window as any).__quickCreateInputs.at(-1)))
        .toMatchObject({
            groupId: 'rallar',
            displayName: 'rallar',
        });

    await panel.getByRole('button', { name: 'Subscribe WS', exact: true }).click();
    await expect(page.getByLabel('Global Room')).toHaveValue('rallar');
    await expect.poll(async () => page.evaluate(() => (window as any).__quickJoinInputs.at(-1)))
        .toBe('rallar');

    await panel.getByRole('button', { name: 'Send WS JSON' }).click();
    await expect(page.getByLabel('Global Room')).toHaveValue('rallar');
    await expect.poll(async () => page.evaluate(() => (window as any).__quickSendInputs.at(-1)))
        .toMatchObject({
            roomId: 'rallar',
            groupId: 'rallar',
            contextId: 'rallar',
        });
});

test('surfaces direct RTC, Rallar Data, and Media tabs with real-backend guardrails', async ({ page }) => {
    await page.goto('/?provider=simulated&roomId=bb-group&tab=rtc-realtime');

    const rtcPanel = page.locator('#panel-rtc-realtime');
    await expect(page.getByRole('tab', { name: 'RTC/Realtimes' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(rtcPanel).toContainText('realtime.sendJson');
    await expect(rtcPanel.getByRole('button', { name: 'Send realtime JSON' })).toBeDisabled();
    await expect(rtcPanel).toContainText('RTC/Realtimes requires provider=browser-rallar.');

    await page.getByRole('tab', { name: 'Rallar Data' }).click();
    const dataPanel = page.locator('#panel-rallar-data');
    await expect(dataPanel).toContainText('Rallar Data requires provider=browser-rallar.');
    await expect(dataPanel.getByLabel('Operation')).toHaveValue('open');
    await expect(dataPanel.getByRole('button', { name: 'Run data operation' })).toBeDisabled();

    await page.getByRole('tab', { name: 'Media' }).click();
    const mediaPanel = page.locator('#panel-media');
    await expect(mediaPanel).toContainText('Media console requires provider=browser-rallar.');
    await expect(mediaPanel.getByRole('button', { name: 'Attach local stream' })).toBeDisabled();
});

test('inspects control-server runs and enqueues a bulk command', async ({ page }) => {
    let run: any = {
        runId: 'demo-run',
        createdAtEpochMs: Date.now() - 5_000,
        updatedAtEpochMs: Date.now() - 1_000,
        agents: [
            {
                runId: 'demo-run',
                agentId: 'agent-a',
                connected: true,
                lastSeenAtEpochMs: Date.now() - 500,
                lastHeartbeatAtEpochMs: Date.now() - 500,
                status: 'running',
                connectionSequence: 1,
                reconnectCount: 0,
                receivedResultCount: 1,
                receivedEventCount: 2,
                completedCommandIds: ['stats-a'],
                resumeCompletedCommandIds: [],
            },
            {
                runId: 'demo-run',
                agentId: 'agent-b',
                connected: true,
                lastSeenAtEpochMs: Date.now() - 700,
                lastHeartbeatAtEpochMs: Date.now() - 700,
                status: 'running',
                connectionSequence: 1,
                reconnectCount: 0,
                receivedResultCount: 0,
                receivedEventCount: 1,
                completedCommandIds: [],
                resumeCompletedCommandIds: [],
            },
        ],
        commands: [],
        results: [{
            kind: 'result',
            protocolVersion: 1,
            runId: 'demo-run',
            agentId: 'agent-a',
            commandId: 'stats-a',
            ok: true,
        }],
        events: [{
            kind: 'diagnostic',
            protocolVersion: 1,
            runId: 'demo-run',
            agentId: 'agent-a',
            atEpochMs: Date.now() - 800,
            eventId: 'event-a',
            payload: { topic: 'rallar.bb.control.command_received' },
        }],
        stats: [],
        reports: [],
        heartbeats: [],
    };
    let bulkBody: unknown;
    let resetCalled = false;

    await page.route('http://localhost:5180/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/runs') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ runs: [run] }),
            });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs/demo-run') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(run),
            });
            return;
        }
        if (request.method() === 'POST' && url.pathname === '/runs/demo-run/commands') {
            bulkBody = await request.postDataJSON();
            const body = bulkBody as {
                agentIds: string[];
                commandIdPrefix: string;
                command: { kind: string };
            };
            run = {
                ...run,
                updatedAtEpochMs: Date.now(),
                commands: body.agentIds.map(agentId => ({
                    envelope: {
                        kind: 'command',
                        protocolVersion: 1,
                        runId: 'demo-run',
                        agentId,
                        commandId: `${body.commandIdPrefix}-${agentId}`,
                        command: body.command,
                    },
                    queuedAtEpochMs: Date.now(),
                    dispatchCount: 0,
                })),
            };
            await route.fulfill({
                status: 202,
                contentType: 'application/json',
                body: JSON.stringify({
                    accepted: true,
                    commands: run.commands.map(command => command.envelope),
                }),
            });
            return;
        }
        if (request.method() === 'POST' && url.pathname === '/runs/demo-run/reset') {
            resetCalled = true;
            run = {
                ...run,
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
            };
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ reset: true, run }),
            });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs/demo-run/artifacts') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    artifactSchemaVersion: 1,
                    runId: 'demo-run',
                    generatedAtEpochMs: Date.now(),
                    files: {
                        'report.json': JSON.stringify({
                            schemaVersion: 1,
                            artifactSchemaVersion: 1,
                            summary: {
                                total: 1,
                                success: 1,
                                failure: 0,
                            },
                            results: {},
                            resultsList: [{
                                resultKey: 'stats-a',
                                name: 'stats-a',
                                status: 'SUCCESS',
                                transport: 'control',
                            }],
                            outputs: {},
                        }),
                        'events.jsonl': '{"kind":"step-result","name":"stats-a","status":"SUCCESS","transport":"control"}\n',
                        'failures.json': JSON.stringify({
                            summary: {
                                total: 1,
                                success: 1,
                                failure: 0,
                            },
                            failures: [],
                            outputs: {},
                        }),
                        'metadata.json': JSON.stringify({
                            schemaVersion: 1,
                            artifactSchemaVersion: 1,
                            generatedAtEpochMs: Date.now(),
                            summary: {
                                total: 1,
                                success: 1,
                                failure: 0,
                            },
                        }),
                    },
                }),
            });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs/demo-run/events.jsonl') {
            await route.fulfill({
                status: 200,
                contentType: 'application/x-ndjson',
                body: '{"kind":"step-result","name":"stats-a","status":"SUCCESS"}\n',
            });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs/demo-run/results.jsonl') {
            await route.fulfill({
                status: 200,
                contentType: 'application/x-ndjson',
                body: '{"name":"stats-a","status":"SUCCESS"}\n',
            });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs/demo-run/failure-bundle') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ failures: [] }),
            });
            return;
        }
        await route.continue();
    });

    await page.goto('/?provider=simulated&tab=run-manager');

    const panel = page.locator('#panel-run-manager');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('demo-run');
    await expect(panel).toContainText('agent-a');
    await expect(panel).toContainText('agent-b');

    await panel.getByRole('button', { name: 'Enqueue Selected' }).click();
    await expect.poll(() => (bulkBody as { agentIds?: string[] } | undefined)?.agentIds?.length).toBe(2);
    await expect(panel).toContainText('agent-a - health');
    await expect(panel).toContainText('agent-b - health');

    await panel.getByRole('button', { name: 'Reset Run' }).click();
    await expect.poll(() => resetCalled).toBe(true);
    await expect(panel).toContainText('No commands');

    await panel.getByRole('button', { name: 'Load Artifact' }).click();
    await expect(panel).toContainText('valid');
    await expect(panel).toContainText('stats-a');
});

test('run manager does not fetch default run when the control server has no runs', async ({ page }) => {
    const runDetailRequests: string[] = [];
    await page.route('http://localhost:5180/runs**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/runs') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ runs: [] }),
            });
            return;
        }

        runDetailRequests.push(request.url());
        await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Run not found.' }),
        });
    });

    await page.goto('/?provider=simulated&tab=run-manager');

    const panel = page.locator('#panel-run-manager');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.metric').filter({ hasText: 'Runs' })).toContainText('0');
    await expect(panel.locator('.run-manager-toolbar select')).toHaveValue('');
    await expect.poll(() => runDetailRequests).toEqual([]);
});

test('keeps manual form and event filters mounted across tab changes', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=manual-rallar');

    const manualPanel = page.locator('#panel-manual-rallar');
    const groupInput = manualPanel.getByLabel('Group');
    await groupInput.fill('tab-persist-room');
    await manualPanel.getByRole('button', { name: 'Health' }).click();
    await expect(manualPanel.getByText('manual-health-1')).toBeVisible();

    await page.getByRole('tab', { name: 'Event Stream' }).click();
    const eventPanel = page.locator('#panel-event-stream');
    await expect(eventPanel.getByLabel('Group')).toBeVisible();
    await expect(eventPanel.getByLabel('Peer')).toBeVisible();
    await expect(eventPanel.getByLabel('Selector')).toBeVisible();
    const messageFilter = eventPanel.getByRole('button', { name: 'message' });
    await messageFilter.click();
    await eventPanel.getByLabel('Window').selectOption('100');
    await expect(messageFilter).toHaveClass(/selected/);
    await expect(eventPanel.getByLabel('Window')).toHaveValue('100');
    await expect(eventPanel.locator('.focus-panel')).toContainText('manual-health-1');

    await page.getByRole('tab', { name: 'Local Workbench' }).click();
    const localWorkbenchPanel = page.locator('#panel-local-workbench');
    const fixtureSelect = localWorkbenchPanel.getByLabel('Fixture');
    await fixtureSelect.selectOption('provider-parity');

    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar Direct live/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByRole('tab', { name: 'Manual Rallar' }).click();

    await expect(groupInput).toHaveValue('tab-persist-room');

    await page.getByRole('tab', { name: 'Event Stream' }).click();
    await expect(messageFilter).toHaveClass(/selected/);
    await expect(eventPanel.getByLabel('Window')).toHaveValue('100');
    await expect(eventPanel.locator('.focus-panel')).toContainText('manual-health-1');

    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByRole('tab', { name: 'Local Workbench' }).click();
    await expect(fixtureSelect).toHaveValue('provider-parity');
});

test('sends a Rallar Server REST request from the server tab', async ({ page }) => {
    await page.route('http://localhost:8080/api/config', async route => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                apiBaseUrl: 'http://localhost:8080',
                wsBaseUrl: 'ws://localhost:8080',
                endpoints: {
                    createWs: '/api/auth/ws-ticket',
                },
                groupId: 'server-group',
                clientId: 'server-client',
                sessionId: 'server-session',
            }),
        });
    });

    await page.goto(
        '/?provider=simulated&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080&tab=rallar-server',
    );

    const serverPanel = page.locator('#panel-rallar-server');
    await serverPanel.getByRole('button', { name: 'Send' }).click();

    await expect(serverPanel).toContainText('200 OK');
    await expect(serverPanel).toContainText('"apiBaseUrl": "http://localhost:8080"');
    await expect(serverPanel).toContainText('"kind": "http.request"');
    await serverPanel.getByRole('button', { name: 'Use group in Quick Test' }).click();
    await expect(page.getByLabel('Global Room')).toHaveValue('server-group');
    await serverPanel.getByRole('button', { name: 'Use client globally' }).click();
    await expect(page.getByLabel('Global Client')).toHaveValue('server-client');
    await serverPanel.getByRole('button', { name: 'Use session globally' }).click();
    await expect(page.getByLabel('Global Session')).toHaveValue('server-session');
});

test('runs a Rallar Server REST collection with assertions and extraction', async ({ page }) => {
    await page.route('http://localhost:8080/api/config', async route => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'x-config-version': '7' },
            body: JSON.stringify({
                apiBaseUrl: 'http://localhost:8080',
                wsBaseUrl: 'ws://localhost:8080',
            }),
        });
    });

    await page.goto(
        '/?provider=simulated&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080&tab=rallar-server',
    );

    const serverPanel = page.locator('#panel-rallar-server');
    await serverPanel.getByLabel('Variables JSON').fill(JSON.stringify({
        configPath: '/api/config',
        expectedBase: 'http://localhost:8080',
    }, null, 2));
    await serverPanel.getByLabel('Collection JSON').fill(JSON.stringify({
        collectionId: 'config-collection',
        name: 'Config collection',
        steps: [{
            stepId: 'read-config',
            label: 'Read config',
            request: {
                method: 'GET',
                path: '{{configPath}}',
                responseBodyMode: 'json',
                attachAuth: false,
            },
            expect: {
                status: 200,
                body: [{
                    path: '$.apiBaseUrl',
                    equals: '{{expectedBase}}',
                }],
                headers: [{
                    name: 'x-config-version',
                    equals: '7',
                }],
            },
            extract: [{
                name: 'observedWsBaseUrl',
                path: '$.wsBaseUrl',
            }],
        }],
    }, null, 2));

    await serverPanel.getByRole('button', { name: 'Run Collection' }).click();

    await expect(serverPanel).toContainText('Read config');
    await expect(serverPanel).toContainText('body $.apiBaseUrl equals');
    await expect(serverPanel).toContainText('header x-config-version equals');
    await expect(serverPanel.getByLabel('Variables JSON')).toHaveValue(/observedWsBaseUrl/);
    await expect(serverPanel.getByLabel('Variables JSON')).toHaveValue(/ws:\/\/localhost:8080/);
});

test('runs auth command-center actions with redacted session output', async ({ page }) => {
    await page.route('http://localhost:8080/api/auth/register', async route => {
        await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({
                clientId: 'alice-client',
                username: 'alice',
                displayName: 'alice',
                registeredAtEpochMs: Date.now(),
            }),
        });
    });
    await page.route('http://localhost:8080/api/auth/login', async route => {
        const body = route.request().postDataJSON() as { username?: string; password?: string };
        if (body.password?.includes('invalid')) {
            await route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'invalid credentials' }),
            });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                clientId: 'alice-client',
                accessToken: 'secret-token-value',
                username: body.username ?? 'alice',
                sessionId: 'alice-session',
                expiresAtEpochMs: Date.now() + 60_000,
            }),
        });
    });
    await page.route('http://localhost:8080/api/auth/ws-ticket', async route => {
        if (!route.request().headers().authorization) {
            await route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'missing token' }),
            });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ticket: 'secret-ticket-value',
                sessionId: 'alice-session',
                expiresAtEpochMs: Date.now() + 30_000,
            }),
        });
    });

    await page.goto(
        '/?provider=simulated&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080&tab=auth',
    );

    const panel = page.locator('#panel-auth');
    await expect(page.getByRole('tab', { name: 'Auth' })).toHaveAttribute('aria-selected', 'true');
    await panel.getByLabel('Username').fill('alice');
    await panel.getByLabel('Password').fill('local-secret');
    await panel.getByRole('button', { name: 'Login', exact: true }).click();

    await expect(panel).toContainText('session active');
    await expect(panel).toContainText('alice-client');
    await expect(panel).toContainText('Token');
    await expect(panel).toContainText('redacted');
    await expect(panel).toContainText('Session TTL');
    await expect(panel).toContainText('Ticket TTL');
    await expect(panel).toContainText('Use separate browser contexts for Alice, Bob, and Charlie');

    await panel.getByRole('button', { name: 'Create WS ticket' }).click();
    await expect(panel).toContainText('Create WS ticket');
    await expect(panel).toContainText('200');
    await panel.getByRole('button', { name: 'Expired auth ticket' }).click();
    await expect(panel).toContainText('Expired auth WS ticket');

    await panel.getByRole('button', { name: 'Bad credentials' }).click();
    await expect(panel).toContainText('Bad credentials');
    await expect(panel).toContainText('401');

    await panel.getByRole('button', { name: 'Missing auth ticket' }).click();
    await expect(panel).toContainText('Missing auth WS ticket');

    const panelText = await panel.textContent();
    expect(panelText).not.toContain('secret-token-value');
    expect(panelText).not.toContain('secret-ticket-value');
    expect(panelText).not.toContain('local-secret');
});

test('refreshes rooms and clients state with authenticated REST evidence', async ({ page }) => {
    await page.addInitScript(session => {
        localStorage.setItem('auth.session', JSON.stringify(session));
    }, {
        clientId: 'alice-client',
        accessToken: 'secret-token-value',
        username: 'alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: Date.now() + 60_000,
    });

    const groupSnapshot = {
        group: {
            groupId: 'bb-group',
            displayName: 'bb-group',
            status: 'active',
            snapshotVersion: 3,
            created: { atEpochMs: 1_000 },
            updated: { atEpochMs: 2_000 },
        },
        memberCount: 1,
        onlineMemberCount: 1,
        activeSessions: [{
            sessionId: 'alice-session',
            connectedAtEpochMs: 3_000,
            lastHeartbeatAtEpochMs: 4_000,
        }],
    };
    const clientSnapshot = {
        principal: {
            principalId: 'alice-client',
            username: 'alice',
            status: 'active',
            snapshotVersion: 2,
            created: { atEpochMs: 1_000 },
            updated: { atEpochMs: 2_000 },
        },
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: 4_000,
        activeSessions: [{
            sessionId: 'alice-session',
            connectedAtEpochMs: 3_000,
            authenticatedAtEpochMs: 2_500,
            lastHeartbeatAtEpochMs: 4_000,
        }],
    };
    const emptyGroupSnapshot = {
        group: {
            groupId: 'empty-group',
            displayName: 'empty-group',
            status: 'active',
            snapshotVersion: 1,
            created: { atEpochMs: 9_000 },
            updated: { atEpochMs: 9_500 },
        },
        memberCount: 0,
        onlineMemberCount: 0,
        activeSessions: [],
    };
    const offlineClientSnapshot = {
        principal: {
            principalId: 'offline-client',
            username: 'offline-user',
            status: 'active',
            snapshotVersion: 1,
            created: { atEpochMs: 9_000 },
            updated: { atEpochMs: 9_500 },
        },
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: 500,
        activeSessions: [],
    };
    const groupEvents = {
        events: [{
            eventId: 'group-event-1',
            eventType: 'member-joined',
            groupId: 'bb-group',
            snapshotVersion: 2,
            occurredAtEpochMs: Date.now(),
        }],
    };
    const clientEvents = {
        events: [{
            eventId: 'client-event-1',
            eventType: 'session-connected',
            principalId: 'alice-client',
            snapshotVersion: 1,
            occurredAtEpochMs: Date.now(),
        }],
    };

    await page.route('http://localhost:8080/api/state/apps/**', async route => {
        if (!route.request().headers().authorization) {
            await route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'missing token' }),
            });
            return;
        }

        const url = new URL(route.request().url());
        const pathname = url.pathname;
        const body = pathname.includes('/clients/') && pathname.includes('/events')
            ? clientEvents
                : pathname.includes('/groups/') && pathname.includes('/events')
                    ? groupEvents
                    : pathname.includes('/clients')
                        ? [clientSnapshot, offlineClientSnapshot]
                        : pathname.endsWith('/groups')
                            ? [groupSnapshot, emptyGroupSnapshot]
                            : groupSnapshot;

        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(body),
        });
    });

    await page.goto(
        '/?provider=simulated&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080&tab=rooms-clients',
    );

    const panel = page.locator('#panel-rooms-clients');
    await expect(page.getByRole('tab', { name: 'Rooms/Clients' }))
        .toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('auth attached');
    await expect(page.getByLabel('Global Client')).toHaveValue('alice-client');
    await expect(page.getByLabel('Global Session')).toHaveValue('alice-session');
    await page.getByLabel('Global Room').fill('bb-group');
    const runState = page.getByLabel('Run state');
    await expect(runState.locator('.metric').filter({ hasText: 'Room' })).toContainText('bb-group');
    await expect(runState.locator('.metric').filter({ hasText: 'User' })).toContainText('alice');
    await expect(runState.locator('.metric').filter({ hasText: 'Session' })).toContainText('alice-session');
    await expect(panel.getByRole('textbox', { name: 'Group' })).toHaveValue('bb-group');
    await panel.getByRole('button', { name: 'Refresh state' }).click();
    await panel.getByRole('button', { name: 'List groups' }).click();
    await panel.getByRole('button', { name: 'List clients' }).click();

    await expect(panel).toContainText('bb-group');
    await expect(panel).toContainText('empty-group');
    await expect(panel).toContainText('alice-client');
    await expect(panel).toContainText('offline-client');
    await expect(panel).toContainText('member-joined');
    await expect(panel).toContainText('session-connected');
    await expect(panel.locator('.metric').filter({ hasText: 'Current client member' })).toContainText('yes');
    await expect(panel.locator('.metric').filter({ hasText: 'Other browser visible' })).toContainText('no');
    await expect(panel.getByRole('button', { name: 'Direct refresh' })).toBeDisabled();
    await panel.getByLabel('Expected other client').fill('alice');
    await expect(panel.locator('.metric').filter({ hasText: 'Other browser visible' })).toContainText('yes');

    const groupsTable = panel.locator('.rooms-subpanel').nth(0).locator('.state-table-row');
    const clientsTable = panel.locator('.rooms-subpanel').nth(1).locator('.state-table-row');
    await expect(groupsTable.first()).toContainText('bb-group');
    await expect(clientsTable.first()).toContainText('alice-client');

    await panel.getByLabel('Group sort').selectOption('created-desc');
    await expect(groupsTable.first()).toContainText('empty-group');
    await panel.getByLabel('Client sort').selectOption('created-desc');
    await expect(clientsTable.first()).toContainText('offline-client');

    await panel.getByLabel('Groups with members').check();
    await expect(panel).not.toContainText('empty-group');
    await expect(panel).toContainText('1/2 groups');

    await panel.getByLabel('Online clients').check();
    await expect(panel).not.toContainText('offline-client');
    await expect(panel).toContainText('1/2 clients');

    await panel.getByRole('button', { name: 'Join group' }).click();
    await expect(panel).toContainText('Join group');
    await expect(panel).toContainText('200');
    await expect(page.getByLabel('Global Room')).toHaveValue('bb-group');

    await page.getByRole('tab', { name: 'WebSocket' }).click();
    const websocketPanel = page.locator('#panel-websocket');
    await expect(websocketPanel.getByLabel('Payload Preset')).toHaveValue('group-message');
    await expect(websocketPanel.getByLabel('WebSocket route preview')).toContainText('Group bb-group');
    await expect(websocketPanel.getByRole('button', { name: 'Send JSON to group bb-group' })).toBeEnabled();
});

test('surfaces browser-rallar signaling and RTC connection status', async ({ page }) => {
    await page.addInitScript(session => {
        localStorage.setItem('auth.session', JSON.stringify(session));
    }, {
        clientId: 'alice-client',
        accessToken: 'secret-token-value',
        username: 'alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: Date.now() + 60_000,
    });

    await page.goto(
        '/?provider=browser-rallar&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080&roomId=awesome&tab=manual-rallar',
    );
    await page.waitForFunction(() => typeof (window as any).__blackBoxRallarEmit === 'function');
    await expect(page.getByLabel('Run state').locator('.metric').filter({ hasText: 'Runtime' }))
        .toContainText('configured');
    await page.evaluate(async () => {
        const emit = (window as any).__blackBoxRallarEmit as (event: any) => void | Promise<void>;
        const wsStatus = {
            sessionId: 'alice-session',
            url: 'ws://localhost:8080/api/ws/alice-session',
            connectState: 'connected',
            readyState: 'open',
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 3,
            reconnectExhausted: false,
        };
        const rtcStatus = {
            sessionId: 'alice-session',
            laneId: 'realtime',
            knownPeerIds: ['bob-session'],
            activePeerIds: ['bob-session'],
            readyPeerIds: ['bob-session'],
            peerIdsWithNoReconnectableLanes: [],
            peers: [],
        };

        await emit({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.lifecycle',
            connection: 'manualRtc',
            actor: 'alice',
            transport: 'realtime',
            roomId: 'awesome',
            data: {
                kind: 'open',
                status: wsStatus,
            },
        });
        await emit({
            kind: 'diagnostic',
            topic: 'rallar.browser.connect_completed',
            connection: 'manualRtc',
            actor: 'alice',
            transport: 'realtime',
            roomId: 'awesome',
            laneId: 'realtime',
            data: {
                status: 'connected',
                connection: 'manualRtc',
                roomId: 'awesome',
                wsStatus,
                rtcStatus,
            },
        });
    });

    const trace = page.locator('[aria-label="Rallar browser trace"]');
    await expect(trace).toContainText('Signal WS: open');
    await expect(trace).toContainText('RTC: ready');
    await expect(trace).toContainText('Group: awesome');
    await expect(trace).toContainText('Peers: ready 1 / active 1 / known 1');

    const runState = page.getByLabel('Run state');
    await expect(runState.locator('.metric').filter({ hasText: 'Signal WS' })).toContainText('open');
    await expect(runState.locator('.metric').filter({ hasText: 'RTC' })).toContainText('ready');
    await expect(runState.locator('.metric').filter({ hasText: 'Room' })).toContainText('awesome');

    await page.evaluate(() => {
        (window as any).__lastRallarWsSend = undefined;
        (window as any).__rallarCallLog = [];
        (window as any).__rallarWsMessageHandler = undefined;
        let connected = false;
        const session = {
            clientId: 'alice-client',
            accessToken: 'secret-token-value',
            username: 'alice',
            sessionId: 'alice-session',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        (window as any).__rallarDirectFacade = {
            configure: (config: unknown) => {
                (window as any).__rallarCallLog.push({
                    kind: 'configure',
                    config,
                });
            },
            setDefaults: (defaults: unknown) => {
                (window as any).__rallarCallLog.push({
                    kind: 'setDefaults',
                    defaults,
                });
            },
            defaults: () => ({}),
            status: () => connected ? 'connected' : 'idle',
            isConnected: () => connected,
            session: () => session,
            auth: {
                restore: () => session,
            },
            start: async (config: unknown) => {
                connected = true;
                (window as any).__rallarCallLog.push({
                    kind: 'start',
                    config,
                });
                return { session, connected: true };
            },
            connect: async () => {
                connected = true;
                return { status: 'connected' };
            },
            disconnect: async () => {
                connected = false;
            },
            rooms: {
                current: () => undefined,
                list: () => [],
                create: async (input: unknown) => input,
                join: async (groupId: string) => ({ groupId }),
            },
            people: {
                list: () => [],
            },
            messages: {
                ws: {
                    send: async (input: unknown) => {
                        if (!connected) {
                            throw new Error('Rallar direct facade is not connected.');
                        }
                        (window as any).__rallarCallLog.push({
                            kind: 'messages.ws.send',
                            input,
                        });
                        (window as any).__lastRallarWsSend = input;
                        return {
                            status: 'sent',
                            transport: 'ws',
                            input,
                        };
                    },
                    onMessage: (_selector: unknown, handler: (message: unknown) => void) => {
                        (window as any).__rallarWsMessageHandler = handler;
                        return () => {
                            (window as any).__rallarWsMessageHandler = undefined;
                        };
                    },
                },
            },
            ws: {
                status: () => ({ readyState: 'open', isOpen: connected }),
                waitForOpen: async () => ({ status: 'open' }),
            },
            rtc: {
                status: () => ({ readyPeerIds: ['bob-session'] }),
            },
            realtime: {
                health: () => ({ connected }),
            },
        };
    });
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar Direct live/ })
        .click();
    await page.getByRole('tab', { name: 'WebSocket' }).click();
    const websocketPanel = page.locator('#panel-websocket');
    await expect(websocketPanel).toContainText('Signal WS');
    await expect(websocketPanel).toContainText('open');
    await expect(websocketPanel.getByLabel('WebSocket route preview')).toContainText('Group awesome');
    await websocketPanel.getByLabel('Payload Preset').selectOption('group-message');
    await expect(websocketPanel.getByLabel('WebSocket route preview')).toContainText('Group awesome');
    await websocketPanel.getByRole('textbox', { name: 'Type ID', exact: true }).fill('room.black-box.ws.probe');
    await websocketPanel.getByRole('textbox', { name: 'Topic ID', exact: true }).fill('room.black-box.ws.probe');
    await websocketPanel.getByLabel('Payload JSON').fill(JSON.stringify({
        text: 'hello over rallar ws',
    }, null, 2));
    await websocketPanel.getByRole('button', { name: 'Subscribe WS', exact: true }).click();
    await expect(websocketPanel).toContainText('rallar.direct.ws.subscribe.completed');
    await websocketPanel.getByRole('button', { name: 'Send JSON' }).click();
    await expect(websocketPanel).toContainText('rallar.direct.ws.send.completed');
    await expect.poll(async () => page.evaluate(() => (window as any).__lastRallarWsSend))
        .not.toBeUndefined();
    const callLog = await page.evaluate(() => (window as any).__rallarCallLog);
    expect(callLog).toEqual(expect.arrayContaining([
        expect.objectContaining({
            kind: 'start',
            config: expect.objectContaining({
                connect: true,
            }),
        }),
        expect.objectContaining({
            kind: 'messages.ws.send',
        }),
    ]));
    const lastRallarWsSend = await page.evaluate(() => (window as any).__lastRallarWsSend);
    expect(lastRallarWsSend).toMatchObject({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        roomId: 'awesome',
        groupId: 'awesome',
        scope: 'room',
        contextId: 'awesome',
        topicId: 'room.black-box.ws.probe',
        typeId: 'room.black-box.ws.probe',
        payload: {
            text: 'hello over rallar ws',
        },
    });
    await page.evaluate(() => {
        (window as any).__rallarWsMessageHandler?.({
            roomId: 'awesome',
            typeId: 'room.black-box.ws.probe',
            topicId: 'room.black-box.ws.probe',
            contextId: 'awesome',
            senderId: 'bob',
            payload: {
                text: 'received over rallar ws',
            },
        });
    });
    await expect(websocketPanel).toContainText('rallar.direct.ws.message');
    await expect(websocketPanel).toContainText('received over rallar ws');
    const receivedPanel = websocketPanel.getByLabel('Received WebSocket messages');
    await expect(receivedPanel).toContainText('Received WS Messages');
    await expect(receivedPanel).toContainText('received over rallar ws');
    await expect(receivedPanel).toContainText('room.black-box.ws.probe / room.black-box.ws.probe');
    await expect(receivedPanel).toContainText('group awesome');
});

test('keeps WebSocket Rallar actions direct-only in simulated mode', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=websocket');

    const panel = page.locator('#panel-websocket');
    await expect(page.getByRole('tab', { name: 'WebSocket' }))
        .toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('Rallar WS Messages');
    await expect(panel).toContainText('Raw WebSocket Diagnostics');
    await expect(panel.getByRole('button', { name: 'Wait Rallar WS open' })).toBeDisabled();
    await panel.getByLabel('Connection').fill('playwrightWs');
    await panel.getByLabel('Timeout').fill('300');
    await panel.getByLabel('Payload JSON').fill(JSON.stringify({
        kind: 'playwright-ws',
        message: 'hello websocket command center',
    }, null, 2));

    await panel.getByRole('button', { name: 'Configure WS' }).click();
    await expect(panel).toContainText('rallar.direct.raw_ws.configure.completed');

    await panel.getByRole('button', { name: 'Send JSON' }).click();
    await expect(panel).toContainText('Direct Rallar operations require provider=browser-rallar');
    await expect(panel).not.toContainText('rallar.bb.fake.ws.message');
    await expect(panel).toContainText('Inbound');
    await expect(panel).toContainText('Outbound');
});

test('wraps room-scoped WebSocket group messages and validates group configuration', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=websocket&roomId=bb-group');

    const panel = page.locator('#panel-websocket');
    const routePreview = panel.getByLabel('WebSocket route preview');
    const receivedPanel = panel.getByLabel('Received WebSocket messages');
    await expect(page.getByRole('tab', { name: 'WebSocket' }))
        .toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByLabel('Payload Preset')).toHaveValue('group-message');
    await expect(routePreview).toContainText('Group bb-group');
    await expect(routePreview).toContainText('Context bb-group');
    await expect(receivedPanel).toContainText('not listening');
    await expect(receivedPanel).toContainText('No received WebSocket messages');
    await expect(panel.getByRole('button', { name: 'Send JSON to group bb-group' })).toBeEnabled();

    await panel.getByLabel('Payload Preset').selectOption('group-message');
    await expect(routePreview).toContainText('Group bb-group');
    await expect(routePreview).toContainText('Context bb-group');
    await expect(panel.getByRole('button', { name: 'Send JSON to group bb-group' })).toBeEnabled();

    await panel.getByRole('textbox', { name: 'Group', exact: true }).fill('');
    await expect(panel.getByRole('textbox', { name: 'Context ID', exact: true })).toHaveValue('room');
    await expect(routePreview).toContainText('No group selected');

    await panel.getByRole('button', { name: 'Send JSON to group' }).click();
    await expect(panel).toContainText('Room-scoped WS sends require a Group.');

    await panel.getByRole('textbox', { name: 'Group', exact: true }).fill('bb-group');
    await expect(panel.getByRole('textbox', { name: 'Context ID', exact: true })).toHaveValue('bb-group');
    await expect(panel.getByRole('textbox', { name: 'Type ID', exact: true })).toHaveValue('room.manual.message');
    await expect(panel.getByRole('textbox', { name: 'Topic ID', exact: true })).toHaveValue('room.manual.message');
    await expect(panel.getByRole('textbox', { name: 'Context ID', exact: true })).toHaveValue('bb-group');

    await panel.getByRole('button', { name: 'Send JSON to group bb-group' }).click();
    await expect(panel).toContainText('Direct Rallar operations require provider=browser-rallar');
    await expect(panel).toContainText('room.manual.message');
    await expect(panel).toContainText('bb-group');
    await expect(receivedPanel).toContainText('No received WebSocket messages');
    await expect(panel.locator('.websocket-status-grid .metric').filter({ hasText: 'Group' })).toContainText('bb-group');
    await expect(panel.locator('.websocket-status-grid .metric').filter({ hasText: 'Selector' })).toContainText('room.manual.message / room.manual.message');
});

test('runs the RTC delivery matrix with scoped addressing and NACK diagnostics', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=manual-rallar');

    const panel = page.locator('#panel-manual-rallar');
    await panel.getByLabel('Application').fill('playwright-app');
    await panel.getByLabel('Workspace').fill('playwright-workspace');
    await panel.getByLabel('Group').fill('playwright-rtc-matrix');
    await panel.getByLabel('Target Client').fill('bob-peer');
    await panel.getByRole('button', { name: 'multicast' }).click();
    await panel.getByLabel('Multicast Clients').fill('bob-peer, charlie-peer');
    await panel.getByLabel('Scope JSON').fill(JSON.stringify({ tenant: 'playwright' }));
    await panel.getByLabel('Room Ref JSON').fill(JSON.stringify({
        type: 'group',
        id: 'playwright-rtc-matrix',
    }));
    await panel.getByLabel('Min Snapshot').fill('7');
    await panel.getByLabel('Payload JSON').fill(JSON.stringify({
        topic: 'playwright.rtc.matrix',
        message: 'hello rtc matrix',
    }, null, 2));

    await panel.getByRole('button', { name: 'Run Realtime Matrix' }).click();
    await expect(panel).toContainText('RTC realtime delivery matrix');
    await expect(panel).toContainText('manual-rtc-send-direct-3');
    await expect(panel).toContainText('manual-rtc-send-multicast-4');
    await expect(panel).toContainText('manual-rtc-send-broadcast-5');

    await panel.getByRole('button', { name: 'Run Messages Matrix' }).click();
    await expect(panel).toContainText('RTC messages.rtc delivery matrix');
    await expect(panel).toContainText('manual-rtc-send-multicast-10');
    await expect(panel).toContainText('manual-rtc-send-broadcast-11');

    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar Direct live/ })
        .click();
    await page.getByRole('tab', { name: 'Topology' }).click();
    const topologyPanel = page.locator('#panel-topology');
    await expect(topologyPanel).toBeVisible();
    await topologyPanel.getByLabel('Node Limit').selectOption('50');
    await topologyPanel.getByLabel('Search').fill('bob-peer');
    await expect(topologyPanel.getByLabel('Node Limit')).toHaveValue('50');
    await expect(topologyPanel.locator('.topology-node-list').first()).toContainText('bob-peer');
    await expect(topologyPanel.locator('.metric').filter({ hasText: 'Route cmds' }))
        .toContainText(/Route cmds(?:[6-9]|\d{2,})/);
    await expect(topologyPanel.locator('.metric').filter({ hasText: 'RTC routes' }))
        .toContainText(/RTC routes(?:[6-9]|\d{2,})/);

    await page.getByRole('tab', { name: 'RTC Diagnostics' }).click();
    const diagnosticsPanel = page.locator('#panel-rtc-diagnostics');
    await expect(diagnosticsPanel).toContainText('Ready Peers');
    await expect(diagnosticsPanel).toContainText('Active Peers');
    await expect(diagnosticsPanel).toContainText('bob-peer');
    await expect(diagnosticsPanel).toContainText('charlie-peer');
    await expect(diagnosticsPanel).toContainText('Lane Health');

    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByRole('tab', { name: 'Manual Rallar' }).click();
    await panel.getByRole('button', { name: 'NACK Probe' }).click();
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar Direct live/ })
        .click();
    await page.getByRole('tab', { name: 'RTC Diagnostics' }).click();
    await expect(diagnosticsPanel).toContainText('NACK');
    await expect(diagnosticsPanel).toContainText('not-yet-in-sync');
});

test('builds and runs a command-center flow', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=flow-builder');

    const panel = page.locator('#panel-flow-builder');
    await expect(page.getByRole('tab', { name: 'Flow Builder' }))
        .toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('Auth, REST, WS, RTC smoke');
    await panel.getByLabel('Variables JSON').fill(JSON.stringify({
        providerMode: 'simulated',
        environment: 'playwright',
        apiBaseUrl: 'http://localhost:8080',
        wsUrl: 'ws://localhost:8080/api/ws/{auth.sessionId}?ticket={auth.wsTicket}',
        applicationId: 'playwright-app',
        workspaceId: 'playwright-workspace',
        groupId: 'playwright-flow-group',
        actor: 'alice',
        sessionId: 'alice-session',
        username: 'alice',
        password: 'local-password',
        rtcConnection: 'flowRtc',
        wsConnection: 'flowWs',
        targetClient: 'bob-peer',
        multicastClients: 'bob-peer,charlie-peer',
        typeId: 'flow.type',
        topicId: 'flow.topic',
        topic: 'flow.message',
        timeoutMs: 5000,
        payload: {
            topic: 'flow.message',
            text: 'hello flow builder',
        },
    }, null, 2));

    await panel.getByRole('button', { name: 'Add wait' }).click();
    await expect(panel.getByLabel('Flow JSON')).toHaveValue(/wait-10/);
    await panel.getByRole('button', { name: 'Run Flow' }).click();

    await expect(panel).toContainText('flow-auth-login');
    await expect(panel).toContainText('flow-ws-send');
    await expect(panel).toContainText('flow-rtc-send');
    await expect(panel).toContainText('completed');
    await expect(panel).toContainText('Runner Scenario Preview');
});

test('shows shared-test recipes and imports a runner artifact bundle', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=shared-test');

    await expect(page.getByRole('tab', { name: 'Shared Test' })).toHaveAttribute(
        'aria-selected',
        'true',
    );

    const panel = page.locator('#panel-shared-test');
    await expect(panel.getByRole('heading', { name: 'Recipe Catalog' })).toBeVisible();
    await expect(panel).toContainText('Group And WebSocket Setup');
    await expect(panel).toContainText('Memory Delivery');

    await panel.getByLabel('Search').fill('seeded');
    await expect(panel).toContainText('Memory Seeded Traffic');
    await panel.getByRole('button', { name: /Memory Seeded Traffic/ }).click();
    await expect(panel).toContainText('expanded-plan replay artifacts');

    await panel.getByLabel('Artifact Files').setInputFiles([
        path.join(ARTIFACT_FIXTURE_DIR, 'report.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'events.jsonl'),
        path.join(ARTIFACT_FIXTURE_DIR, 'failures.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'metadata.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'expanded-plan.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'matrix-summary.json'),
    ]);

    await expect(panel.getByRole('heading', { name: 'Imported Summary' })).toBeVisible();
    await expect(panel).toContainText('valid');
    await expect(panel).toContainText('Imported Event Stream');
    await expect(panel).toContainText('aliceWaits');
    await expect(panel).toContainText('Replay Recipe');
});

test('restores selected tab and redacted UI drafts after a fresh load', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=rallar-server');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?provider=simulated&tab=rallar-server');

    const serverPanel = page.locator('#panel-rallar-server');
    const requestGrid = serverPanel.locator('.rest-workbench-grid');
    const requestEditors = serverPanel.locator('.rest-editors');
    await requestGrid.getByLabel('Method').selectOption('POST');
    await requestGrid.getByLabel('Path').fill('/api/private');
    await requestEditors.getByLabel('Headers JSON').fill(JSON.stringify({
        authorization: 'Bearer header-secret',
    }));
    await requestEditors.getByLabel('Body JSON').fill(JSON.stringify({
        password: 'body-secret',
    }));

    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
    await page.getByRole('tab', { name: 'Manual Rallar' }).click();
    const manualPanel = page.locator('#panel-manual-rallar');
    await manualPanel.getByLabel('Group').fill('persisted-ui-room');
    await manualPanel.getByLabel('Payload JSON').fill(JSON.stringify({
        token: 'payload-secret',
        kind: 'probe',
    }));

    await page.getByRole('tab', { name: 'Event Stream' }).click();
    await page.locator('#panel-event-stream').getByRole('button', { name: 'message' }).click();

    await page.goto('/?provider=simulated');

    await expect(page.getByRole('tab', { name: 'Event Stream' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.locator('#panel-event-stream').getByRole('button', { name: 'message' }))
        .toHaveClass(/selected/);

    await page.getByRole('tab', { name: 'Manual Rallar' }).click();
    await expect(manualPanel.getByLabel('Group')).toHaveValue('persisted-ui-room');
    await expect(manualPanel.getByLabel('Payload JSON')).toHaveValue(/<redacted>/);

    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar Direct live/ })
        .click();
    await page.getByRole('tab', { name: 'Rallar Server' }).click();
    await expect(requestGrid.getByLabel('Path')).toHaveValue('/api/private');
    await expect(requestEditors.getByLabel('Headers JSON')).toHaveValue(/<redacted>/);
    await expect(requestEditors.getByLabel('Body JSON')).toHaveValue(/<redacted>/);

    const storedValues = await page.evaluate(() => {
        const values: Record<string, string> = {};
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key) {
                values[key] = localStorage.getItem(key) ?? '';
            }
        }
        return values;
    });
    const serializedStorage = JSON.stringify(storedValues);
    expect(serializedStorage).not.toContain('header-secret');
    expect(serializedStorage).not.toContain('body-secret');
    expect(serializedStorage).not.toContain('payload-secret');
});
