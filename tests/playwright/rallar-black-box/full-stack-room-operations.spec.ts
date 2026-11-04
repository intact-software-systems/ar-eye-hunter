import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AuthSession } from '@shared/api/api-config.ts';
import { writeFile } from 'node:fs/promises';
import {
    decodeFullStackAuthSession,
    readBrowserAuthSession,
    readFullStackConfig,
    uniqueSuffix
} from './full-stack-helpers.ts';

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
                await createPrivateRoom({ request, session, applicationId, workspaceId });
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
                await page.getByRole('button', { name: 'Recompute room topology', exact: true }).click();
                await expect(page.getByRole('region', { name: 'Room recovery outcome' })).toContainText(
                    'Work completed',
                    { timeout: 30_000 }
                );
                await expect(explanation).toContainText('away');
                await expect(explanation).toContainText('Gameplay participation');
                await expect(page.getByRole('region', { name: 'Room recovery outcome' })).toContainText(
                    'not confirmed'
                );
                await page.screenshot({ path: testInfo.outputPath(`inspection-${applicationId}.png`), fullPage: true });
            }
            await page.getByText('Global expired-record maintenance', { exact: true }).click();
            await page.getByRole('button', { name: 'Preview global cleanup', exact: true }).click();
            const maintenance = page.getByRole('region', { name: 'Global maintenance result' });
            await expect(maintenance).toContainText('Preview complete');
            await expect(page.getByRole('button', { name: 'Execute global cleanup', exact: true })).toBeDisabled();
            await page.getByLabel('I understand cleanup affects all applications and workspaces.').check();
            await page.getByRole('button', { name: 'Execute global cleanup', exact: true }).click();
            await expect(maintenance).toContainText('Cleanup completed', { timeout: 30_000 });
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

    test(
        'repairs topology coverage after commanded replanning holds a newly present participant',
        async ({ page, request }, testInfo) => {
            await signInOperator(page, 'admin', 'admin');
            const session = await readBrowserAuthSession(page);
            const login = await request.post(`${config.apiBaseUrl}/api/auth/login/requests/${crypto.randomUUID()}`, {
                data: { username: 'test', password: 'test' }
            });
            expect(login.status()).toBe(200);
            const participant = decodeFullStackAuthSession(await login.json());
            for (const applicationId of ['ar-eye-hunter', 'rallar-server']) {
                const workspaceId = `stale-topology-${uniqueSuffix()}`;
                await createPrivateRoom({ request, session, applicationId, workspaceId, commanded: true });
                const groupPath = `/api/state/apps/${applicationId}/workspaces/${workspaceId}/groups/private-room`;
                await connectParticipant({ request, session, groupPath });
                const headers = { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId };
                await expect.poll(async () => {
                    const response = await request.get(`${config.apiBaseUrl}${groupPath}/topology`, { headers });
                    expect(response.status()).toBe(200);
                    return (await response.json()).snapshot?.activeSessionIds;
                }).toEqual([session.sessionId]);
                const invitation = await request.post(
                    `${config.apiBaseUrl}${groupPath}/invites/${participant.clientId}/requests/${crypto.randomUUID()}`,
                    { headers, data: {} }
                );
                expect(invitation.status(), await invitation.text()).toBe(200);
                const membership = await request.post(
                    `${config.apiBaseUrl}${groupPath}/invites/accept/requests/${crypto.randomUUID()}`,
                    {
                        headers: {
                            authorization: `Bearer ${participant.accessToken}`,
                            'x-client-id': participant.clientId
                        },
                        data: {}
                    }
                );
                expect(membership.status(), await membership.text()).toBe(200);
                await connectParticipant({ request, session: participant, groupPath });
                await page.getByLabel('Room application').fill(applicationId);
                await page.getByLabel('Room workspace').fill(workspaceId);
                const findStarted = performance.now();
                await page.getByRole('button', { name: 'Find rooms', exact: true }).click();
                const inspect = page.getByRole('button', { name: `Inspect Private ${applicationId}`, exact: true });
                await expect(inspect).toBeVisible();
                const findMs = performance.now() - findStarted;
                const explanationStarted = performance.now();
                await inspect.click();
                const explanation = page.getByRole('region', { name: 'Room explanation', exact: true });
                await explanation.getByText('Formation and connectivity evidence', { exact: true }).click();
                await expect(explanation.getByText('Active session count', { exact: true }).locator('..').locator('dd'))
                    .toContainText('2');
                const topologyCount = explanation.getByText('Participant count', { exact: true }).locator('..').locator(
                    'dd'
                );
                await expect(topologyCount).toHaveText('1');
                const explanationMs = performance.now() - explanationStarted;
                await page.screenshot({
                    path: testInfo.outputPath(`stale-topology-${applicationId}.png`),
                    fullPage: true
                });
                const recoveryStarted = performance.now();
                await page.getByRole('button', { name: 'Recompute room topology', exact: true }).click();
                await expect(page.getByRole('region', { name: 'Room recovery outcome' })).toContainText(
                    'Work completed',
                    {
                        timeout: 30_000
                    }
                );
                await expect(topologyCount).toHaveText('2');
                const recoveryMs = performance.now() - recoveryStarted;
                const timingPath = testInfo.outputPath(`room-recovery-timing-${applicationId}.json`);
                await writeFile(timingPath, JSON.stringify({ applicationId, findMs, explanationMs, recoveryMs }));
                await testInfo.attach(`room-recovery-timing-${applicationId}`, {
                    contentType: 'application/json',
                    path: timingPath
                });
                await page.screenshot({
                    path: testInfo.outputPath(`recomputed-topology-${applicationId}.png`),
                    fullPage: true
                });
                await expect(explanation).toContainText('Gameplay participation');
                await expect(explanation).toContainText('unknown');
            }
        }
    );

    test('recovers a lost committed response through the visible same-request retry', async ({ page, request }) => {
        await signInOperator(page, 'admin', 'admin');
        const session = await readBrowserAuthSession(page);
        const workspaceId = `lost-response-${uniqueSuffix()}`;
        await createPrivateRoom({ request, session, applicationId: 'ar-eye-hunter', workspaceId });
        await selectPrivateRoom(page, 'ar-eye-hunter', workspaceId);
        let committedUrl: string | null = null;
        let retriedUrl: string | null = null;
        await page.route('**/api/admin/operations/topology/recompute/requests/*', async (route) => {
            if (committedUrl === null) {
                committedUrl = route.request().url();
                const committed = await route.fetch();
                expect(committed.status(), await committed.text()).toBe(200);
                await route.abort('failed');
            }
            else {
                retriedUrl = route.request().url();
                await route.continue();
            }
        });
        await page.getByRole('button', { name: 'Recompute room topology', exact: true }).click();
        await expect(page.getByText('Outcome uncertain.', { exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Recompute room topology', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Retry same request', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Room recovery outcome' })).toContainText('Work completed', {
            timeout: 30_000
        });
        expect(retriedUrl).toBe(committedUrl);
        await expect(page.getByRole('button', { name: 'Retry same request', exact: true })).toHaveCount(0);
        await expect(page.getByRole('region', { name: 'Room explanation', exact: true })).toContainText('away');
    });

    test('clears private room evidence when authority is revoked before clicking recovery', async ({ page, request }) => {
        await signInOperator(page, 'admin', 'admin');
        const session = await readBrowserAuthSession(page);
        const workspaceId = `revoked-recovery-${uniqueSuffix()}`;
        await createPrivateRoom({ request, session, applicationId: 'rallar-server', workspaceId });
        await selectPrivateRoom(page, 'rallar-server', workspaceId);
        const revoked = await request.post(`${config.apiBaseUrl}/api/auth/logout/requests/${crypto.randomUUID()}`, {
            headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId }
        });
        expect(revoked.status()).toBe(200);
        await page.getByRole('button', { name: 'Recompute room topology', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('401');
        await expect(page.getByRole('region', { name: 'Room explanation', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^Inspect / })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Retry same request', exact: true })).toHaveCount(0);
    });

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

interface CreatePrivateRoomInput {
    readonly request: APIRequestContext;
    readonly session: AuthSession;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly commanded?: boolean;
}

async function createPrivateRoom(
    { request, session, applicationId, workspaceId, commanded }: CreatePrivateRoomInput
): Promise<void> {
    const response = await request.post(
        `${config.apiBaseUrl}/api/state/apps/${applicationId}/workspaces/${workspaceId}/groups/requests/${crypto.randomUUID()}`,
        {
            headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId },
            data: {
                lifecyclePolicy: { preset: 'optimistic', topology: { replanning: commanded ? 'commanded' : 'auto' } },
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
}

async function selectPrivateRoom(page: Page, applicationId: string, workspaceId: string): Promise<void> {
    await page.getByLabel('Room application').fill(applicationId);
    await page.getByLabel('Room workspace').fill(workspaceId);
    await page.getByRole('button', { name: 'Find rooms', exact: true }).click();
    await page.getByRole('button', { name: `Inspect Private ${applicationId}`, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Room explanation', exact: true })).toContainText(
        'Membership and presence'
    );
}

interface ConnectParticipantInput {
    readonly request: APIRequestContext;
    readonly session: AuthSession;
    readonly groupPath: string;
}

async function connectParticipant({ request, session, groupPath }: ConnectParticipantInput): Promise<void> {
    const response = await request.put(
        `${config.apiBaseUrl}${groupPath}/sessions/${session.sessionId}/requests/${crypto.randomUUID()}`,
        {
            headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId },
            data: {
                generationId: crypto.randomUUID(),
                connectionGenerationId: crypto.randomUUID(),
                publicationKey: null,
                principalId: session.clientId
            }
        }
    );
    expect(response.status(), await response.text()).toBe(200);
}
