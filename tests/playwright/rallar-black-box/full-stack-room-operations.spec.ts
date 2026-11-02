import { expect, test, type Page } from '@playwright/test';
import { readBrowserAuthSession, readFullStackConfig, uniqueSuffix } from './full-stack-helpers.ts';

const config = readFullStackConfig();

test.describe('operator room inspection through visible controls', () => {
    test.skip(!config.enabled, config.skipReason);

    test(
        'finds private rooms for both games and explains away membership without claiming gameplay',
        async ({ page, request }, testInfo) => {
            await signInOperator(page, 'admin', 'admin');
            const session = await readBrowserAuthSession(page);
            const workspaceId = `inspection-${uniqueSuffix()}`;
            for (const applicationId of ['ar-eye-hunter', 'rallar-server']) {
                const response = await request.post(
                    `${config.apiBaseUrl}/api/state/apps/${applicationId}/workspaces/${workspaceId}/groups/requests/${crypto.randomUUID()}`,
                    {
                        headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId },
                        data: {
                            groupId: 'private-room',
                            displayName: `Private ${applicationId}`,
                            kind: 'room',
                            joinMode: 'invite-only',
                            directoryListing: 'unlisted',
                            retention: { mode: 'temporary' },
                            createdByPrincipalId: session.clientId
                        }
                    }
                );
                expect(response.status(), await response.text()).toBe(201);
                await page.getByLabel('Room application').fill(applicationId);
                await page.getByLabel('Room workspace').fill(workspaceId);
                await page.getByRole('button', { name: 'Find rooms', exact: true }).click();
                await page.getByRole('button', { name: `Inspect Private ${applicationId}`, exact: true }).click();
                const explanation = page.getByRole('region', { name: 'Room explanation', exact: true });
                await expect(explanation).toContainText('Membership and presence');
                await expect(explanation).toContainText('admin');
                await expect(explanation).toContainText('away');
                await expect(explanation).toContainText('Gameplay participation');
                await expect(explanation).toContainText('unknown');
                await page.getByRole('button', { name: 'Refresh room evidence', exact: true }).click();
                await expect(explanation).toContainText('invite-only');
                await page.screenshot({ path: testInfo.outputPath(`inspection-${applicationId}.png`), fullPage: true });
            }
            await page.getByLabel('Room workspace').fill(`${workspaceId}-empty`);
            await expect(page.getByRole('region', { name: 'Room explanation', exact: true })).toHaveCount(0);
            await page.getByRole('button', { name: 'Find rooms', exact: true }).click();
            await expect(page.getByText('No rooms on this page.', { exact: true })).toBeVisible();
            const revoked = await request.post(`${config.apiBaseUrl}/api/auth/logout/requests/${crypto.randomUUID()}`, {
                headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId }
            });
            expect(revoked.status()).toBe(200);
            await page.getByRole('button', { name: 'Refresh room evidence', exact: true }).click();
            await expect(page.getByRole('alert')).toContainText('401');
            await expect(page.getByText('No rooms on this page.', { exact: true })).toHaveCount(0);
            await expect(page.getByRole('button', { name: /^Inspect / })).toHaveCount(0);
        }
    );

    test('shows an ordinary account the actual refusal without disclosing directory contents', async ({ page }) => {
        await signInOperator(page, 'test', 'test');
        await page.getByLabel('Room application').fill('ar-eye-hunter');
        await page.getByLabel('Room workspace').fill('default');
        const refusal = page.waitForResponse((response) => response.url().includes('/api/admin/operations/rooms/'));
        await page.getByRole('button', { name: 'Find rooms', exact: true }).click();
        expect((await refusal).status()).toBe(403);
        await expect(page.getByRole('alert')).toContainText('403');
        await expect(page.getByRole('button', { name: /^Inspect / })).toHaveCount(0);
        await expect(page.getByText('No rooms on this page.', { exact: true })).toHaveCount(0);
    });
});

async function signInOperator(page: Page, username: string, password: string): Promise<void> {
    await page.goto('/?provider=browser-rallar&experience=recipe-console&view=advanced');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Room operations and recovery', { exact: true }).click({ timeout: 15_000 });
}
