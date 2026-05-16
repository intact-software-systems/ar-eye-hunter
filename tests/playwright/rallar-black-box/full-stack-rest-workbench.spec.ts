import { expect, test } from '@playwright/test';
import {
    expectFullStackApiReady,
    loginThroughUi,
    readFullStackConfig,
    sendWsTicketFromRestWorkbench,
    uniqueSuffix,
} from './full-stack-helpers.ts';

const config = readFullStackConfig();

test.describe('full-stack Rallar Server REST workbench', () => {
    test.skip(!config.enabled, config.skipReason);

    test('two isolated browsers log in and send authenticated REST requests', async ({
        browser,
        request,
    }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            await loginThroughUi(pageA, config, config.userA, {
                suffix: `a-${suffix}`,
                tab: 'rallar-server',
            });
            await loginThroughUi(pageB, config, config.userB, {
                suffix: `b-${suffix}`,
                tab: 'rallar-server',
            });

            const [headersA, headersB] = await Promise.all([
                sendWsTicketFromRestWorkbench(pageA, config),
                sendWsTicketFromRestWorkbench(pageB, config),
            ]);

            expect(headersA.authorization).toMatch(/^Bearer /);
            expect(headersA['x-client-id']).toBe(config.userA.clientId);
            expect(headersB.authorization).toMatch(/^Bearer /);
            expect(headersB['x-client-id']).toBe(config.userB.clientId);
            expect(headersA.authorization).not.toBe(headersB.authorization);

            await expect(pageA.locator('#panel-rallar-server')).toContainText('authorization');
            await expect(pageA.locator('#panel-rallar-server')).toContainText('<redacted>');
        } finally {
            await Promise.all([
                contextA.close(),
                contextB.close(),
            ]);
        }
    });
});
