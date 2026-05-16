import { expect, type Page, test } from '@playwright/test';
import {
    expectFullStackApiReady,
    loginThroughUi,
    readFullStackConfig,
    uniqueSuffix,
} from './full-stack-helpers.ts';

const config = readFullStackConfig();

type ManualAgent = Readonly<{
    page: Page;
    connection: string;
    sessionId: string;
}>;

async function openManualTab(page: Page): Promise<void> {
    await page.getByRole('tab', { name: 'Manual Rallar' }).click();
    await expect(page.locator('#panel-manual-rallar')).toBeVisible();
}

async function fillManualField(page: Page, label: string, value: string): Promise<void> {
    await page.locator('#panel-manual-rallar').getByLabel(label, { exact: true }).fill(value);
}

async function expectManualCommandCompleted(page: Page, commandIdPrefix: string): Promise<void> {
    const row = page.locator('#panel-manual-rallar .history-row')
        .filter({ hasText: commandIdPrefix })
        .first();
    await expect(row).toContainText(commandIdPrefix);
    await expect(row).toContainText('ok');
}

async function connectManualAgent(
    page: Page,
    input: Readonly<{
        connection: string;
        groupId: string;
        createGroup?: boolean;
    }>,
): Promise<ManualAgent> {
    await openManualTab(page);
    await fillManualField(page, 'Group', input.groupId);
    await fillManualField(page, 'Connection', input.connection);
    await expect(page.locator('#panel-manual-rallar select').first()).toHaveValue('realtime');

    const sessionId = await page.locator('#panel-manual-rallar')
        .getByLabel('Session', { exact: true })
        .inputValue();
    expect(sessionId).not.toHaveLength(0);

    await page.locator('#panel-manual-rallar')
        .getByRole('button', {
            name: input.createGroup ? 'Create and join group' : 'Connect',
            exact: true,
        })
        .click();
    await expectManualCommandCompleted(page, 'manual-rtc-connect');

    return {
        page,
        connection: input.connection,
        sessionId,
    };
}

async function sendManualRealtimePayload(
    sender: ManualAgent,
    input: Readonly<{
        targetSessionId: string;
        payload: Record<string, unknown>;
    }>,
): Promise<void> {
    await openManualTab(sender.page);
    await fillManualField(sender.page, 'Connection', sender.connection);
    await fillManualField(sender.page, 'Target Client', input.targetSessionId);
    await sender.page.locator('#panel-manual-rallar .manual-payload-editor textarea')
        .fill(JSON.stringify(input.payload, null, 2));
    await sender.page.locator('#panel-manual-rallar')
        .getByRole('button', { name: 'Send payload' })
        .click();

    await expectManualCommandCompleted(sender.page, 'manual-rtc-send-direct');
}

async function expectReceivedPayload(
    receiver: ManualAgent,
    payloadId: string,
): Promise<void> {
    await openManualTab(receiver.page);
    const inbox = receiver.page.locator('#panel-manual-rallar .received-inbox-panel');
    await expect(inbox).toContainText(payloadId, { timeout: 45_000 });
    await expect(inbox).toContainText('manual.full-stack.realtime');
}

async function expectRealProviderEvents(page: Page): Promise<void> {
    await page.getByRole('tab', { name: 'Event Stream' }).click();
    const panel = page.locator('#panel-event-stream');
    await expect(panel).toContainText('rallar.browser.realtime.message');
    await expect(panel).not.toContainText('rallar.bb.fake.');
}

async function closeManualAgent(agent: ManualAgent): Promise<void> {
    await openManualTab(agent.page);
    await agent.page.locator('#panel-manual-rallar')
        .getByRole('button', { name: 'Close connections' })
        .click();
    await expectManualCommandCompleted(agent.page, 'manual-close');
}

test.describe('full-stack Manual Rallar realtime delivery', () => {
    test.skip(!config.enabled, config.skipReason);

    test('two browsers send real realtime JSON through Manual Rallar', async ({
        browser,
        request,
    }) => {
        test.setTimeout(150_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const roomId = `${config.roomId}-manual-${suffix}`;
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            await loginThroughUi(pageA, config, config.userA, {
                suffix: `manual-a-${suffix}`,
                tab: 'manual-rallar',
            });
            await loginThroughUi(pageB, config, config.userB, {
                suffix: `manual-b-${suffix}`,
                tab: 'manual-rallar',
            });

            const agentA = await connectManualAgent(pageA, {
                connection: `manual-a-realtime-${suffix}`,
                groupId: roomId,
                createGroup: true,
            });
            const agentB = await connectManualAgent(pageB, {
                connection: `manual-b-realtime-${suffix}`,
                groupId: roomId,
            });

            const payloadId = `manual-realtime-${suffix}`;
            await sendManualRealtimePayload(agentA, {
                targetSessionId: agentB.sessionId,
                payload: {
                    topic: 'manual.full-stack.realtime',
                    payloadId,
                    direction: 'a-to-b',
                    roomId,
                    from: config.userA.username,
                    to: config.userB.username,
                },
            });

            await expectReceivedPayload(agentB, payloadId);
            await expectRealProviderEvents(pageB);
            await Promise.all([
                closeManualAgent(agentA),
                closeManualAgent(agentB),
            ]);
        } finally {
            await Promise.all([
                contextA.close(),
                contextB.close(),
            ]);
        }
    });
});
