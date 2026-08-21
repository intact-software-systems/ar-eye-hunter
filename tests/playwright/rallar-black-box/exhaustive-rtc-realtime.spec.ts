import { expect, test } from '@playwright/test';
import {
    cleanupRallarPage,
    expectFullStackApiReady,
    expectNoSecrets,
    loginUser,
    openTab,
    readExhaustivePostgresConfig,
    uniqueGroupId
} from './full-stack-helpers.ts';

const config = readExhaustivePostgresConfig();

test.describe('exhaustive RTC/Realtimes direct Rallar mode', () => {
    test.skip(!config.enabled, config.skipReason);

    test('covers realtime, messages.rtc, scoped addressing, diagnostics, and topology', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(240_000);
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            const [, receiverSession] = await Promise.all([
                loginUser(pageA, config, config.userA, {
                    groupId,
                    sessionId: `${groupId}-rtc-a`,
                    tab: 'rtc-realtime'
                }),
                loginUser(pageB, config, config.userB, {
                    groupId,
                    sessionId: `${groupId}-rtc-b`,
                    tab: 'rtc-realtime'
                })
            ]);

            await openTab(pageA, 'quick-test');
            const quickA = pageA.getByLabel('Rallar Quick Test');
            await quickA.getByLabel('Timeout', { exact: true }).fill('60000');
            await quickA.getByRole('button', { name: 'Create and join group' }).click();
            await expect(quickA).toContainText(/completed|created|joined/i, { timeout: 75_000 });

            await openTab(pageB, 'rtc-realtime');
            const receiver = pageB.locator('#panel-rtc-realtime');
            const receiverControls = receiver.locator('.rtc-realtime-context-grid');
            await receiver.getByLabel('Timeout', { exact: true }).fill('60000');
            await receiver.getByRole('button', { name: 'Subscribe realtime' }).click();
            await expect(receiver).toContainText(/subscribed|realtime sub.*yes/i, { timeout: 45_000 });
            await receiverControls.locator('select').nth(0).selectOption('messages.rtc');
            await receiver.getByRole('button', { name: 'Subscribe RTC messages' }).click();
            await expect(receiver).toContainText(/RTC message sub|messages\.rtc/i, { timeout: 45_000 });

            await openTab(pageA, 'rtc-realtime');
            const sender = pageA.locator('#panel-rtc-realtime');
            const senderControls = sender.locator('.rtc-realtime-context-grid');
            await sender.getByLabel('Timeout', { exact: true }).fill('60000');
            await sender.getByLabel('Peer IDs').fill(receiverSession.clientId);
            await sender.getByLabel('Payload JSON').fill(JSON.stringify(
                {
                    kind: 'exhaustive-rtc-realtime',
                    groupId,
                    transport: 'realtime'
                },
                null,
                2
            ));
            await sender.getByRole('button', { name: 'Wait room lane' }).click();
            await expect(sender).toContainText(/completed|lane|health/i, { timeout: 60_000 });
            const senderFeedback = sender.locator('[role="status"]').first();
            await sender.getByRole('button', { name: 'Send realtime JSON' }).click();
            await expect(senderFeedback).toContainText(/Send realtime JSON/i, { timeout: 30_000 });
            await expect(senderFeedback).toContainText(/success|completed|ok/i, { timeout: 60_000 });

            await senderControls.locator('select').nth(0).selectOption('messages.rtc');
            await sender.getByLabel('Min Snapshot').fill('0');
            await sender.getByLabel('Payload JSON').fill(JSON.stringify(
                {
                    kind: 'exhaustive-rtc-message',
                    groupId,
                    transport: 'messages.rtc'
                },
                null,
                2
            ));
            await sender.getByRole('button', { name: 'Send RTC message' }).click();
            await expect(senderFeedback).toContainText(/Send RTC message/i, { timeout: 30_000 });
            await expect(senderFeedback).toContainText(/success|completed|ok/i, { timeout: 60_000 });
            await expect(receiver.getByLabel('RTC/Realtimes received messages'))
                .toContainText(/Received Messages|rows/i);

            await sender.getByRole('button', { name: 'Refresh lane health' }).click();
            await sender.getByRole('button', { name: 'Copy RTC recipe' }).click();
            await expectNoSecrets(sender, [config.userA.password]);

            await openTab(pageA, 'rtc-diagnostics');
            await expect(pageA.locator('#panel-rtc-diagnostics')).toContainText(/Lane Health|First payload|NACK/i);
            await pageA.locator('#panel-rtc-diagnostics').getByRole('button', { name: 'Health' }).click();
            await expect(pageA.locator('#panel-rtc-diagnostics')).toContainText(/RTC health|completed|Lane Health/i, {
                timeout: 45_000
            });

            await openTab(pageA, 'topology');
            const topology = pageA.locator('#panel-topology');
            await topology.getByLabel('Search').fill(groupId);
            await expect(topology.getByLabel('Search')).toHaveValue(groupId);
            await expect(topology).toContainText(/nodes|routes|room/i, { timeout: 30_000 });
        }
        finally {
            await Promise.all([
                cleanupRallarPage(pageA),
                cleanupRallarPage(pageB)
            ]);
            await Promise.all([
                pageA.goto('about:blank', { timeout: 5_000 }).catch(() => undefined),
                pageB.goto('about:blank', { timeout: 5_000 }).catch(() => undefined)
            ]);
            await Promise.all([
                contextA.close(),
                contextB.close()
            ]);
        }
    });
});
