import { expect, test } from '@playwright/test';
import {
    expectFullStackApiReady,
    loginThroughUi,
    readBrowserAuthSession,
    readFullStackConfig,
    uniqueSuffix,
} from './full-stack-helpers.ts';

const config = readFullStackConfig();

test.describe('full-stack Rallar Quick Test WS delivery', () => {
    test.skip(!config.enabled, config.skipReason);

    test('two browsers join, subscribe, send, receive, and repeat real WS group data', async ({
        browser,
        request,
    }) => {
        test.setTimeout(150_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const groupName = `${config.roomId}-quick-${suffix}`;
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            await loginThroughUi(pageA, config, config.userA, {
                suffix: `quick-a-${suffix}`,
                tab: 'quick-test',
            });
            await loginThroughUi(pageB, config, config.userB, {
                suffix: `quick-b-${suffix}`,
                tab: 'quick-test',
            });

            const quickA = pageA.getByLabel('Rallar Quick Test');
            const quickB = pageB.getByLabel('Rallar Quick Test');
            await quickA.getByRole('textbox', { name: 'Group' }).fill(groupName);
            await quickA.getByRole('button', { name: 'Create and join group' }).click();
            await expect(quickA).toContainText('completed', { timeout: 30_000 });

            const createdGroupId = await quickA.getByRole('textbox', { name: 'Group' }).inputValue();
            const [sessionA, sessionB] = await Promise.all([
                readBrowserAuthSession(pageA),
                readBrowserAuthSession(pageB),
            ]);
            const inviteRequestId = `quick-invite-${suffix}`;
            const inviteResponse = await request.post(
                `${config.apiBaseUrl}/api/state/apps/${
                    encodeURIComponent(config.applicationId)
                }/workspaces/${encodeURIComponent(config.workspaceId)}/groups/${
                    encodeURIComponent(createdGroupId)
                }/invites/${encodeURIComponent(sessionB.clientId)}/requests/${encodeURIComponent(
                    inviteRequestId,
                )}`,
                {
                    headers: {
                        authorization: `Bearer ${sessionA.accessToken}`,
                        'x-client-id': sessionA.clientId,
                        'content-type': 'application/json',
                    },
                    data: {},
                },
            );
            expect(inviteResponse.ok(), await inviteResponse.text()).toBe(true);

            await quickB.getByRole('textbox', { name: 'Group' }).fill(createdGroupId);
            await quickB.getByRole('button', { name: 'Join group', exact: true }).click();
            await expect(quickB).toContainText('completed', { timeout: 30_000 });
            await quickB.getByRole('button', { name: 'Subscribe WS', exact: true }).click();
            await expect(quickB).toContainText('listening', { timeout: 30_000 });

            for (const index of [1, 2]) {
                const payloadId = `quick-ws-${suffix}-${index}`;
                await quickA.getByLabel('Payload JSON').fill(JSON.stringify({
                    payloadId,
                    direction: 'a-to-b',
                    index,
                    groupId: createdGroupId,
                }, null, 2));
                await quickA.getByRole('button', { name: 'Send WS JSON' }).click();
                await expect(quickA).toContainText('completed', { timeout: 30_000 });
                await expect(quickB.getByLabel('Quick Test received messages'))
                    .toContainText(payloadId, { timeout: 45_000 });
            }
        } finally {
            await Promise.all([
                contextA.close(),
                contextB.close(),
            ]);
        }
    });
});
