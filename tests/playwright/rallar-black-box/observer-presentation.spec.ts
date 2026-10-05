import { expect, test, type Page } from '@playwright/test';

// The real SPA recorder remains the source of truth; presentation never replaces or caps it.
async function recordDiagnostic(page: Page, value: string): Promise<void> {
    await page.evaluate(async (publicValue) => {
        const modulePath = '/src/runtime-store.ts';
        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
        rallarBlackBoxRuntimeStore.recordRuntimeEvent({
            kind: 'diagnostic',
            topic: `rallar.browser.observer.${publicValue}`,
            severity: 'warning',
            payload: { publicValue, token: 'observer-private-token' }
        });
    }, value);
}

async function openWorkbench(page: Page): Promise<void> {
    await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ }).click();
    await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
    await page.locator('#panel-advanced').getByRole('button', { name: 'Local Workbench', exact: true }).click();
    await expect(page.locator('#panel-local-workbench')).toBeVisible();
}

test('report disclosure follows workbench visibility, preserves drafts, and reveals current private-safe recordings', async ({ page }) => {
    await page.goto('/?provider=simulated&experience=legacy&workspace=black-box-runner&tab=local-workbench');
    const workbench = page.locator('#panel-local-workbench');
    const report = workbench.locator('.report-panel');
    const output = report.locator('.report-output');
    await expect(report.getByRole('button', { name: 'Show', exact: true })).toBeVisible();
    await expect(output).toHaveCount(0);
    await recordDiagnostic(page, 'first');
    await report.getByRole('button', { name: 'Show', exact: true }).click();
    await expect.poll(() => output.inputValue()).toContain('rallar.browser.observer.first');
    expect(await output.inputValue()).not.toContain('observer-private-token');

    const draft = workbench.getByRole('textbox', { name: 'Manual Command JSON', exact: true });
    await draft.fill('{"kind":"health","commandId":"preserved-draft"}');
    await page.locator('#panel-advanced').getByRole('button', { name: 'Manual Rallar', exact: true }).click();
    await expect(output).toHaveCount(0);
    await recordDiagnostic(page, 'surface-hidden');
    await page.locator('#panel-advanced').getByRole('button', { name: 'Local Workbench', exact: true }).click();
    await expect(report.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
    await expect.poll(() => output.inputValue()).toContain('rallar.browser.observer.surface-hidden');
    await expect(draft).toHaveValue('{"kind":"health","commandId":"preserved-draft"}');

    await page.getByRole('tab', { name: 'Event Stream', exact: true }).click();
    await expect(output).toHaveCount(0);
    await recordDiagnostic(page, 'tab-hidden');
    await openWorkbench(page);
    await expect.poll(() => output.inputValue()).toContain('rallar.browser.observer.tab-hidden');
    await page.getByLabel('Rallar workspace mode').getByRole('button', { name: /Rallar Direct live Rallar operations/ })
        .click();
    await expect(output).toHaveCount(0);
    await recordDiagnostic(page, 'mode-hidden');
    await openWorkbench(page);
    await expect(report.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
    await expect.poll(() => output.inputValue()).toContain('rallar.browser.observer.mode-hidden');
    await report.getByRole('button', { name: 'Hide', exact: true }).click();
    await recordDiagnostic(page, 'closed');
    await expect(output).toHaveCount(0);
    await report.getByRole('button', { name: 'Show', exact: true }).click();
    const snapshot = JSON.parse(await output.inputValue());
    expect(snapshot.events.filter((event: { topic: string; }) => event.topic.startsWith('rallar.browser.observer.')))
        .toHaveLength(5);
    expect(await output.inputValue()).not.toContain('observer-private-token');
    const recorded = await page.evaluate(async () => {
        const modulePath = '/src/runtime-store.ts';
        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
        return rallarBlackBoxRuntimeStore.getSnapshot().state.events
            .filter((event: { topic: string; }) => event.topic.startsWith('rallar.browser.observer.'));
    });
    expect(recorded).toHaveLength(5);
    expect(recorded.every((event: { payload: { token: string; }; }) => event.payload.token === '<redacted>')).toBe(
        true
    );
});

test('evidence panels restore operator filters and window settings against current recorder history', async ({ page }) => {
    await page.goto('/?provider=simulated&experience=legacy&workspace=rallar&tab=quick-test');
    await recordDiagnostic(page, 'first');
    await page.getByRole('tab', { name: 'Rallar Trace', exact: true }).click();
    const trace = page.locator('#panel-rallar-trace');
    await trace.getByRole('combobox', { name: 'Source', exact: true }).selectOption('browser');
    await trace.getByRole('combobox', { name: 'Severity', exact: true }).selectOption('warning');
    await trace.getByRole('combobox', { name: 'Window', exact: true }).selectOption('250');
    await expect(trace.locator('.rallar-trace-list')).toContainText('rallar.browser.observer.first');
    await expect(trace.locator('.rallar-trace-payload')).not.toContainText('observer-private-token');
    await page.getByRole('tab', { name: 'Event Stream', exact: true }).click();
    const stream = page.locator('#panel-event-stream');
    await stream.getByRole('button', { name: 'diagnostic', exact: true }).click();
    await stream.getByRole('textbox', { name: 'Topic', exact: true }).fill('rallar.browser.observer.');
    await stream.getByRole('combobox', { name: 'Window', exact: true }).selectOption('100');
    await openWorkbench(page);
    await expect(trace.locator('.rallar-trace-row')).toHaveCount(0);
    await expect(stream.locator('.event-row')).toHaveCount(0);
    await recordDiagnostic(page, 'current');
    await page.getByLabel('Rallar workspace mode').getByRole('button', { name: /Rallar Direct live Rallar operations/ })
        .click();
    await page.getByRole('tab', { name: 'Rallar Trace', exact: true }).click();
    await expect(trace.getByRole('combobox', { name: 'Source', exact: true })).toHaveValue('browser');
    await expect(trace.getByRole('combobox', { name: 'Severity', exact: true })).toHaveValue('warning');
    await expect(trace.getByRole('combobox', { name: 'Window', exact: true })).toHaveValue('250');
    await expect(trace.locator('.rallar-trace-list')).toContainText('rallar.browser.observer.current');
    await page.getByRole('tab', { name: 'Event Stream', exact: true }).click();
    await expect(stream.getByRole('button', { name: 'diagnostic', exact: true })).toHaveClass(/selected/);
    await expect(stream.getByRole('textbox', { name: 'Topic', exact: true })).toHaveValue('rallar.browser.observer.');
    await expect(stream.getByRole('combobox', { name: 'Window', exact: true })).toHaveValue('100');
    await expect(stream.locator('.event-list')).toContainText('rallar.browser.observer.current');
});
