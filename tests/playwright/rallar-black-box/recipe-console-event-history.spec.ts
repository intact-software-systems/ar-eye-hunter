import { expect, test } from '@playwright/test';

import { installExecuteControlFixture } from './recipe-console-execute-control-fixture.ts';

for (
    const selection of [
        { mode: '', policy: undefined },
        { mode: 'full', policy: { mode: 'full' } },
        { mode: 'recent', policy: { mode: 'recent', maxEvents: 64 } }
    ] as const
) {
    test(`selects and locks event history ${selection.mode || 'inherit'} through visible Console controls`, async ({ context, page }) => {
        const control = await installExecuteControlFixture(context, { operatorSession: true });
        await page.goto(
            '/?provider=simulated&v=1&experience=recipe-console&view=execute&applicationId=rallar-server&workspaceId=default&roomId=execute-live-group&controlRunId=execute-control-a'
        );
        await page.getByRole('option', { name: /Composite Evidence/ }).click();
        const history = page.getByRole('combobox', { name: 'Run event history', exact: true });
        await expect(history).toHaveValue('');
        await history.selectOption(selection.mode);
        if (selection.mode === 'recent') {
            await page.getByRole('spinbutton', { name: 'Retained event limit' }).fill('64');
        }
        await page.locator('[data-execute-manifest] summary').click();
        const disclosure = page.getByLabel('Generated distributed run manifest');
        await expect(disclosure).toBeVisible();
        const manifest = JSON.parse(await disclosure.textContent() ?? '{}');
        expect(manifest.eventHistory).toEqual(selection.policy);
        const actions = page.locator('[data-execute-action-runway]');
        await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
        await actions.getByRole('button', { name: 'Create draft', exact: true }).click();
        await expect(page.locator('[data-execute-run-status]')).toHaveAttribute('data-run-state', 'draft');
        const created = control.successfulWrites.find((request) => request.path === '/distributed-runs');
        expect(created?.manifest?.eventHistory).toEqual(selection.policy);
        expect(Object.hasOwn(created?.manifest ?? {}, 'eventHistory')).toBe(selection.policy !== undefined);
        await expect(history).toBeDisabled();
        await expect(history).toHaveValue(selection.mode);
        if (selection.mode === 'recent') {
            await expect(page.getByRole('spinbutton', { name: 'Retained event limit' })).toBeDisabled();
        }
    });
}
