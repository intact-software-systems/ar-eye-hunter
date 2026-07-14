import {
    expect,
    test,
    type Locator,
    type Page,
} from '@playwright/test';
import {
    deriveDistributedRunFailureEvidenceDestinations,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-evidence.ts';
import {
    deriveDistributedRunMonitor,
    type DistributedRunMonitor,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    installRecipeConsoleLargeMonitorFixture,
    LARGE_MONITOR_COUNTS,
    LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID,
    LARGE_MONITOR_LAST_FAILURE_COMMAND_ID,
    LARGE_MONITOR_LONG_AGENT_ID,
    LARGE_MONITOR_ROUTE,
    type RecipeConsoleLargeMonitorFixture,
} from './recipe-console-monitor-large-fixture.ts';

type RowIdentity =
    | Readonly<{ attribute: string; selector?: string }>
    | Readonly<{ selectors: readonly string[] }>;

type WindowContract = Readonly<{
    budget: number;
    expectedIdentities: readonly string[];
    identity: RowIdentity;
    itemLabel: string;
    label: string;
    rows: string;
    scope: Locator;
    total: number;
}>;

async function rowIdentities(
    rows: Locator,
    identity: RowIdentity,
): Promise<readonly string[]> {
    return rows.evaluateAll((nodes, descriptor) => nodes.map(node => {
        if ('attribute' in descriptor) {
            const target = descriptor.selector
                ? node.querySelector(descriptor.selector)
                : node;
            return target?.getAttribute(descriptor.attribute) ?? '';
        }
        return descriptor.selectors.map(selector =>
            node.querySelector(selector)?.textContent?.trim() ?? ''
        ).join('|');
    }), identity);
}

function number(value: number): string {
    return value.toLocaleString('en-US');
}

function exactRange(
    start: number,
    end: number,
    total: number,
    itemLabel: string,
): string {
    return `Showing ${number(start + 1)}–${number(end)} of ${number(total)} ${itemLabel}.`;
}

function monitorForFixture(
    fixture: RecipeConsoleLargeMonitorFixture,
): DistributedRunMonitor {
    return deriveDistributedRunMonitor({
        artifactBundle: fixture.artifact,
        controlRun: fixture.snapshot.runs[0]!,
        distributedRun: fixture.snapshot.distributedRuns?.[0]!,
    });
}

async function waitForLargeMonitor(page: Page): Promise<void> {
    await expect(page.locator('[data-monitor-section="verdict"]'))
        .toHaveAttribute('data-run-state', 'failed');
    await expect(page.getByRole('heading', {
        name: `Failures (${LARGE_MONITOR_COUNTS.failures})`,
    })).toBeVisible();
}

async function traverseOrdinalWindow(
    page: Page,
    contract: WindowContract,
): Promise<readonly number[]> {
    expect(contract.expectedIdentities).toHaveLength(contract.total);
    expect(new Set(contract.expectedIdentities).size).toBe(contract.total);
    const group = contract.scope.getByRole('group', {
        name: `${contract.label} window`,
    });
    const anchor = contract.scope.locator(
        `[data-monitor-window-focus-anchor="${contract.label}"]`,
    );
    const outside = contract.scope.locator(
        `[data-monitor-window-focus-anchor="${contract.label}"] + ` +
        '[data-monitor-window-outside]',
    );
    const visited: number[] = [];
    const visitedIdentities: string[] = [];
    let start = 0;
    while (true) {
        const end = Math.min(start + contract.budget, contract.total);
        const rows = contract.scope.locator(contract.rows);
        await expect(group.getByRole('status')).toHaveText(exactRange(
            start,
            end,
            contract.total,
            contract.itemLabel,
        ));
        await expect(anchor).toHaveText(exactRange(
            start,
            end,
            contract.total,
            contract.itemLabel,
        ));
        await expect(rows).toHaveCount(end - start);
        const ordinals = await rows.evaluateAll(nodes => nodes.map(node =>
            Number((node as HTMLElement).dataset.monitorSourceOrdinal)
        ));
        expect(ordinals).toEqual(
            Array.from({ length: end - start }, (_, offset) => start + offset),
        );
        const identities = await rowIdentities(rows, contract.identity);
        expect(identities).toEqual(contract.expectedIdentities.slice(start, end));
        visited.push(...ordinals);
        visitedIdentities.push(...identities);
        await expect(outside).toHaveText(
            `${number(contract.total - (end - start))} ${contract.itemLabel} ` +
            'outside this render window and browseable.',
        );

        const next = group.getByRole('button', { name: 'Next' });
        if (await next.isDisabled()) break;
        const url = page.url();
        await next.click();
        await expect(page).toHaveURL(url);
        start = end;
    }
    expect(visited).toEqual(
        Array.from({ length: contract.total }, (_, index) => index),
    );
    expect(new Set(visited).size).toBe(contract.total);
    expect(visitedIdentities).toEqual(contract.expectedIdentities);
    expect(new Set(visitedIdentities).size).toBe(contract.total);
    return visited;
}

async function traverseInspectorWindow(input: Readonly<{
    budget: number;
    itemLabel: string;
    expectedIdentities: readonly string[];
    identity: RowIdentity;
    label: string;
    rows: Locator;
    scope: Locator;
    total: number;
}>): Promise<void> {
    expect(input.expectedIdentities).toHaveLength(input.total);
    expect(new Set(input.expectedIdentities).size).toBe(input.total);
    const group = input.scope.getByRole('group', {
        name: `${input.label} window`,
    });
    const anchor = input.scope.locator(
        `[data-monitor-window-focus-anchor="${input.label}"]`,
    );
    const outside = input.scope.locator(
        `[data-monitor-window-focus-anchor="${input.label}"] + ` +
        '[data-monitor-window-outside]',
    );
    const visitedIdentities: string[] = [];
    let start = 0;
    while (true) {
        const end = Math.min(start + input.budget, input.total);
        await expect(group.getByRole('status')).toHaveText(exactRange(
            start,
            end,
            input.total,
            input.itemLabel,
        ));
        await expect(anchor).toHaveText(exactRange(
            start,
            end,
            input.total,
            input.itemLabel,
        ));
        await expect(input.rows).toHaveCount(end - start);
        const identities = await rowIdentities(input.rows, input.identity);
        expect(identities).toEqual(input.expectedIdentities.slice(start, end));
        visitedIdentities.push(...identities);
        await expect(outside).toHaveText(
            `${number(input.total - (end - start))} ${input.itemLabel} ` +
            'outside this render window and browseable.',
        );
        const next = group.getByRole('button', { name: 'Next' });
        if (await next.isDisabled()) break;
        const url = input.scope.page().url();
        await next.click();
        await expect(input.scope.page()).toHaveURL(url);
        start = end;
    }
    expect(visitedIdentities).toEqual(input.expectedIdentities);
    expect(new Set(visitedIdentities).size).toBe(input.total);
}

async function rewindWindow(scope: Locator, label: string): Promise<void> {
    const previous = scope.getByRole('group', { name: `${label} window` })
        .getByRole('button', { name: 'Previous' });
    while (!(await previous.isDisabled())) {
        const url = scope.page().url();
        await previous.click();
        await expect(scope.page()).toHaveURL(url);
    }
}

function disclosure(page: Page, summary: 'Timeline' | 'Events' | 'Composite results') {
    return page.locator('[data-monitor-section="timeline"] details').filter({
        has: page.locator('summary', { hasText: `${summary} (` }),
    });
}

async function refreshMonitor(page: Page, reads: () => number): Promise<void> {
    const before = reads();
    await page.getByRole('region', { name: 'Monitor actions' })
        .getByRole('button', { name: 'Refresh', exact: true })
        .click();
    await expect.poll(reads).toBeGreaterThan(before);
}

async function expectContainedLandscapeCommandBar(page: Page): Promise<void> {
    const items = page.locator(
        '[data-command-bar] > div:not([role]) > span',
    );
    await expect(items).toHaveCount(8);
    const metrics = await items.evaluateAll(nodes => nodes.map(node => {
        const item = node as HTMLElement;
        const label = item.firstElementChild as HTMLElement;
        const value = item.lastElementChild as HTMLElement;
        const itemBounds = item.getBoundingClientRect();
        const labelBounds = label.getBoundingClientRect();
        const valueBounds = value.getBoundingClientRect();
        const itemStyle = getComputedStyle(item);
        const labelStyle = getComputedStyle(label);
        const valueStyle = getComputedStyle(value);
        return {
            label: label.textContent?.trim() ?? '',
            value: value.textContent?.trim() ?? '',
            item: {
                left: itemBounds.left,
                right: itemBounds.right,
                width: itemBounds.width,
                overflowX: itemStyle.overflowX,
            },
            labelBounds: {
                left: labelBounds.left,
                right: labelBounds.right,
            },
            labelStyle: {
                overflowX: labelStyle.overflowX,
                textOverflow: labelStyle.textOverflow,
                whiteSpace: labelStyle.whiteSpace,
            },
            valueBounds: {
                left: valueBounds.left,
                right: valueBounds.right,
            },
            valueClientWidth: value.clientWidth,
            valueScrollWidth: value.scrollWidth,
            valueStyle: {
                overflowX: valueStyle.overflowX,
                textOverflow: valueStyle.textOverflow,
                whiteSpace: valueStyle.whiteSpace,
            },
        };
    }));

    for (const [index, metric] of metrics.entries()) {
        expect(metric.item.width, `${metric.label} item width`).toBeGreaterThan(0);
        expect(metric.item.overflowX, `${metric.label} item overflow`).toBe('hidden');
        expect(metric.labelStyle, `${metric.label} label containment`).toEqual({
            overflowX: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
        });
        expect(metric.valueStyle, `${metric.label} value containment`).toEqual({
            overflowX: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
        });
        expect(metric.labelBounds.left).toBeGreaterThanOrEqual(metric.item.left - 0.5);
        expect(metric.labelBounds.right).toBeLessThanOrEqual(metric.item.right + 0.5);
        expect(metric.valueBounds.left).toBeGreaterThanOrEqual(metric.item.left - 0.5);
        expect(metric.valueBounds.right).toBeLessThanOrEqual(metric.item.right + 0.5);
        const next = metrics[index + 1];
        if (next) expect(metric.item.right).toBeLessThanOrEqual(next.item.left + 0.5);
        if (/^\d{3}(?:\/\d{3})?$/.test(metric.value)) {
            expect(
                metric.valueScrollWidth,
                `${metric.label} three-digit value must remain fully legible`,
            ).toBeLessThanOrEqual(metric.valueClientWidth + 1);
        }
    }
}

test('browses every pressured Monitor collection without gaps, duplicates, or hidden authority changes', async ({
    context,
    page,
}) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installRecipeConsoleLargeMonitorFixture(context);
    const monitor = monitorForFixture(fixture);
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);

    const originalUrl = page.url();
    const failures = page.locator('[data-monitor-section="failures"]');
    const matrix = page.locator('[data-monitor-section="matrix"]');
    const progress = page.locator('[data-monitor-progress]');
    const diagnostics = page.locator('[data-monitor-diagnostics]');
    const evidence = page.locator('[data-monitor-section="timeline"]');

    await expect(failures.locator('[data-failure-key]').first())
        .toHaveAttribute('data-failure-key', LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID);
    await expect(failures.locator('[data-failure-key]')).toHaveCount(60);
    await expect(matrix.locator('[data-monitor-agent-row]')).toHaveCount(80);
    await expect(progress.locator('[data-monitor-recipe-row]')).toHaveCount(60);
    await expect(progress.locator('[data-monitor-readiness-row]')).toHaveCount(60);
    await expect(diagnostics.locator('[data-monitor-diagnostic-row]')).toHaveCount(50);
    await expect(evidence.locator('[data-monitor-disclosure-row]')).toHaveCount(0);
    await expect(disclosure(page, 'Timeline').locator('summary'))
        .toHaveText(`Timeline (${LARGE_MONITOR_COUNTS.timeline})`);
    await expect(disclosure(page, 'Events').locator('summary'))
        .toHaveText(`Events (${LARGE_MONITOR_COUNTS.events})`);
    await expect(disclosure(page, 'Composite results').locator('summary'))
        .toHaveText(`Composite results (${LARGE_MONITOR_COUNTS.composites})`);

    await traverseOrdinalWindow(page, {
        budget: 60, itemLabel: 'failures', label: 'Failures',
        expectedIdentities: monitor.failures.map(row => row.key),
        identity: { attribute: 'data-failure-key', selector: '[data-failure-key]' },
        rows: '[data-monitor-source-ordinal]', scope: failures,
        total: LARGE_MONITOR_COUNTS.failures,
    });
    await traverseOrdinalWindow(page, {
        budget: 80, itemLabel: 'agents', label: 'Agents',
        expectedIdentities: monitor.agentProgress.map(row => row.agentId),
        identity: { selectors: ['bdi[data-exact-identifier]'] },
        rows: '[data-monitor-agent-row]', scope: matrix,
        total: LARGE_MONITOR_COUNTS.agents,
    });
    await traverseOrdinalWindow(page, {
        budget: 60, itemLabel: 'recipes', label: 'Recipes',
        expectedIdentities: monitor.recipeProgress.map(row =>
            `${row.recipeId}|${row.role ?? row.profile ?? 'All assigned roles'}`
        ),
        identity: { selectors: ['bdi[data-exact-identifier]', 'small'] },
        rows: '[data-monitor-recipe-row]', scope: progress,
        total: LARGE_MONITOR_COUNTS.recipes,
    });
    await traverseOrdinalWindow(page, {
        budget: 60, itemLabel: 'readiness rows', label: 'Readiness',
        expectedIdentities: monitor.readiness.map(row => row.agentId),
        identity: { selectors: ['bdi[data-exact-identifier]'] },
        rows: '[data-monitor-readiness-row]', scope: progress,
        total: LARGE_MONITOR_COUNTS.readiness,
    });
    await traverseOrdinalWindow(page, {
        budget: 50, itemLabel: 'diagnostics', label: 'Diagnostics',
        expectedIdentities: monitor.runtimeDiagnostics.map(
            row => row.diagnosticTypeId,
        ),
        identity: { selectors: ['strong'] },
        rows: '[data-monitor-diagnostic-row]', scope: diagnostics,
        total: LARGE_MONITOR_COUNTS.diagnostics,
    });

    for (const contract of [
        {
            budget: 40,
            itemLabel: 'timeline rows',
            expectedIdentities: monitor.timeline.map(row => row.id),
            identity: { attribute: 'data-monitor-source-key' },
            label: 'Timeline',
            rows: '[data-monitor-disclosure-row]',
            summary: 'Timeline' as const,
            total: LARGE_MONITOR_COUNTS.timeline,
        },
        {
            budget: 40,
            itemLabel: 'events',
            expectedIdentities: monitor.events.map(row => row.summary),
            identity: { selectors: ['strong'] },
            label: 'Events',
            rows: '[data-monitor-disclosure-row]',
            summary: 'Events' as const,
            total: LARGE_MONITOR_COUNTS.events,
        },
        {
            budget: 40,
            itemLabel: 'composites',
            expectedIdentities: monitor.compositeDrilldowns.map(
                row => row.commandId,
            ),
            identity: { selectors: ['bdi[data-exact-identifier]'] },
            label: 'Composite results',
            rows: '[data-monitor-disclosure-row]',
            summary: 'Composite results' as const,
            total: LARGE_MONITOR_COUNTS.composites,
        },
    ]) {
        const details = disclosure(page, contract.summary);
        await details.locator('summary').click();
        await traverseOrdinalWindow(page, {
            ...contract,
            scope: details,
        });
    }

    expect(page.url()).toBe(originalUrl);
    expect(fixture.mutationRequestCount()).toBe(0);

    await rewindWindow(failures, 'Failures');
    const selected = failures.locator(
        `[data-failure-key="${LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID}"]`,
    );
    await selected.click();
    const inspector = page.locator('[data-monitor-inspector]');
    await expect(inspector).toHaveAttribute('data-selection-kind', 'failure');
    const selectedUrl = page.url();
    await failures.getByRole('group', { name: 'Failures window' })
        .getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(selectedUrl);
    await expect(selected).toHaveCount(0);
    await expect(inspector).toContainText(LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('windows every inspector pressure path while retaining exact selected evidence', async ({
    context,
    page,
}) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installRecipeConsoleLargeMonitorFixture(context);
    const monitor = monitorForFixture(fixture);
    const failure = monitor.failures.find(
        row => row.key === LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID,
    )!;
    const destinations = deriveDistributedRunFailureEvidenceDestinations({
        failure,
        monitor,
    });
    const destinationIdentities = destinations.map(destination =>
        `${destination.kind[0]!.toUpperCase()}${destination.kind.slice(1)}|` +
        destination.id
    );
    const commandEvidence = [
        ...monitor.failures
            .filter(row => row.commandId === LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID)
            .map(row => `Failure|${row.key}`),
        ...monitor.runtimeDiagnostics
            .filter(row => row.commandId === LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID)
            .map(row => `Diagnostic|${row.eventId}`),
        ...monitor.timeline
            .filter(row => row.commandId === LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID)
            .map(row => `Timeline|${row.id}`),
        ...monitor.events
            .filter(row => row.commandId === LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID)
            .map(row => `Event|${row.eventId}`),
    ];
    const selectedDiagnostic = monitor.runtimeDiagnostics.find(
        row => row.commandId === LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID,
    )!;
    const diagnosticFailureLinks = selectedDiagnostic.correlatedFailureKeys.map(
        id => `Failure|${id}`,
    );
    const recipeId = destinations.find(destination => destination.kind === 'recipe')!.id;
    const roleChoices = monitor.recipeProgress
        .filter(row => row.recipeId === recipeId)
        .map(row =>
            `${row.profile ?? 'Default profile'}|${row.role ?? 'All assigned roles'}`
        );
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);

    await page.locator(
        `[data-failure-key="${LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID}"]`,
    ).click();
    const inspector = page.locator('[data-monitor-inspector]');
    await expect(inspector.getByRole('heading', {
        name: `Correlated destinations ${LARGE_MONITOR_COUNTS.failureDestinations}`,
    })).toBeVisible();
    await traverseInspectorWindow({
        budget: 40,
        expectedIdentities: destinationIdentities,
        identity: { selectors: ['span', 'bdi[data-exact-identifier]'] },
        itemLabel: 'destinations',
        label: 'Failure destinations',
        rows: inspector.locator('#monitor-inspector-failure-destinations > button'),
        scope: inspector,
        total: LARGE_MONITOR_COUNTS.failureDestinations,
    });
    await rewindWindow(inspector, 'Failure destinations');
    await inspector.locator('[data-evidence-destination="command"]')
        .filter({ hasText: LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID }).click();
    await expect(inspector).toHaveAttribute('data-selection-kind', 'command');
    await traverseInspectorWindow({
        budget: 16,
        expectedIdentities: commandEvidence,
        identity: { selectors: ['span', 'strong'] },
        itemLabel: 'linked items',
        label: 'Command evidence',
        rows: inspector.locator('#monitor-inspector-command-evidence > button'),
        scope: inspector,
        total: LARGE_MONITOR_COUNTS.commandEvidence,
    });
    await rewindWindow(inspector, 'Command evidence');
    await inspector.locator('#monitor-inspector-command-evidence > button').nth(1).click();
    await expect(inspector).toHaveAttribute('data-selection-kind', 'diagnostic');
    await expect(inspector).toContainText(selectedDiagnostic.eventId);
    await traverseInspectorWindow({
        budget: 40,
        expectedIdentities: diagnosticFailureLinks,
        identity: { selectors: ['span', 'strong'] },
        itemLabel: 'failure links',
        label: 'Diagnostic failure links',
        rows: inspector.locator(
            '#monitor-inspector-diagnostic-failure-links > button',
        ),
        scope: inspector,
        total: LARGE_MONITOR_COUNTS.diagnosticFailureLinks,
    });
    await rewindWindow(inspector, 'Diagnostic failure links');
    await inspector.locator(
        '#monitor-inspector-diagnostic-failure-links > button',
    ).first().click();
    await expect(inspector).toHaveAttribute('data-selection-kind', 'failure');
    await inspector.locator('[data-evidence-destination="recipe"]').first().click();
    await expect(inspector).toHaveAttribute('data-selection-kind', 'recipe');
    await traverseInspectorWindow({
        budget: 60,
        expectedIdentities: roleChoices,
        identity: {
            selectors: [
                'span bdi[data-exact-identifier]',
                'strong bdi[data-exact-identifier]',
            ],
        },
        itemLabel: 'role choices',
        label: 'Role recipe choices',
        rows: inspector.locator('#monitor-inspector-role-recipe-choices > button'),
        scope: inspector,
        total: LARGE_MONITOR_COUNTS.roleChoices,
    });

    expect(fixture.mutationRequestCount()).toBe(0);
});

test('retains disclosure cursors and live truth, resets diagnostic filters, and recovers focus after a threshold shrink', async ({
    context,
    page,
}) => {
    test.slow();
    await page.setViewportSize({ width: 900, height: 900 });
    const fixture = await installRecipeConsoleLargeMonitorFixture(context);
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);

    const events = disclosure(page, 'Events');
    await expect(events.locator('[data-monitor-event-row]')).toHaveCount(0);
    await events.locator('summary').click();
    const eventsGroup = events.getByRole('group', { name: 'Events window' });
    await eventsGroup.getByRole('button', { name: 'Next' }).click();
    await eventsGroup.getByRole('button', { name: 'Next' }).click();
    await expect(eventsGroup.getByRole('status'))
        .toHaveText('Showing 81–110 of 110 events.');
    await events.locator('summary').click();
    await expect(events.locator('[data-monitor-event-row]')).toHaveCount(0);
    await expect(events.getByRole('group', { name: 'Events window' })).toHaveCount(0);
    await events.locator('summary').click();
    await expect(events.getByRole('group', { name: 'Events window' }).getByRole('status'))
        .toHaveText('Showing 81–110 of 110 events.');

    fixture.failDistributedRunReads();
    await refreshMonitor(page, fixture.runRequestCount);
    await expect(page.locator('[data-monitor-section="verdict"]'))
        .toHaveAttribute('data-evidence-freshness', 'last-known');
    await expect(events.getByRole('group', { name: 'Events window' }).getByRole('status'))
        .toHaveText('Showing 81–110 of 110 events.');
    fixture.recoverDistributedRunReads();
    await refreshMonitor(page, fixture.runRequestCount);
    await expect(page.locator('[data-monitor-section="verdict"]'))
        .toHaveAttribute('data-evidence-freshness', 'current');

    const diagnostics = page.locator('[data-monitor-diagnostics]');
    const diagnosticsGroup = diagnostics.getByRole('group', {
        name: 'Diagnostics window',
    });
    await diagnosticsGroup.getByRole('button', { name: 'Next' }).click();
    await expect(diagnosticsGroup.getByRole('status'))
        .toHaveText('Showing 51–55 of 55 diagnostics.');
    await diagnostics.getByLabel('Severity').selectOption('error');
    await expect(diagnosticsGroup.getByRole('status'))
        .toHaveText('Showing 1–50 of 55 diagnostics.');

    const matrix = page.locator('[data-monitor-section="matrix"]');
    const agentGroup = matrix.getByRole('group', { name: 'Agents window' });
    await agentGroup.getByRole('button', { name: 'Next' }).click();
    const focused = matrix.locator('[data-monitor-agent-row] button').last();
    await focused.focus();
    await expect(focused).toBeFocused();
    fixture.setAgentCount(30);
    const readsBeforePoll = fixture.runRequestCount();
    await expect.poll(fixture.runRequestCount, { timeout: 10_000 })
        .toBeGreaterThan(readsBeforePoll);
    const focusAnchor = matrix.locator(
        '[data-monitor-window-focus-anchor="Agents"]',
    );
    await expect(focusAnchor).toBeFocused();
    await expect(focusAnchor).toHaveText('Showing 1–30 of 30 agents.');
    await expect(matrix.getByRole('group', { name: 'Agents window' })).toHaveCount(0);
    await expect(matrix.locator('[data-monitor-agent-row]')).toHaveCount(30);
    await expect(page.locator('[data-monitor-section="verdict"]'))
        .toHaveAttribute('data-evidence-freshness', 'current');
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('restores a detached windowed inspector trigger to its owning range anchor', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 900, height: 900 });
    const fixture = await installRecipeConsoleLargeMonitorFixture(context);
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);

    const matrix = page.locator('[data-monitor-section="matrix"]');
    const agentWindow = matrix.getByRole('group', { name: 'Agents window' });
    await agentWindow.getByRole('button', { name: 'Next' }).click();
    await expect(agentWindow.getByRole('status'))
        .toHaveText('Showing 81–126 of 126 agents.');
    const sourceRow = matrix.locator(
        '[data-monitor-agent-row][data-monitor-source-ordinal="125"]',
    );
    const sourceTrigger = sourceRow.getByRole('button');
    await sourceTrigger.click();

    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    await expect(inspector).toHaveAttribute('data-mode', 'overlay');
    const close = inspector.getByRole('button', { name: 'Close inspector' });
    await expect(close).toBeFocused();

    fixture.setAgentCount(30);
    const readsBeforePoll = fixture.runRequestCount();
    await expect.poll(fixture.runRequestCount, { timeout: 10_000 })
        .toBeGreaterThan(readsBeforePoll);
    await expect(sourceTrigger).toHaveCount(0);
    const rangeAnchor = matrix.locator(
        '[data-monitor-window-focus-anchor="Agents"]',
    );
    await expect(rangeAnchor).toHaveText('Showing 1–30 of 30 agents.');

    await close.focus();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(rangeAnchor).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName))
        .not.toBe('BODY');
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('restores a detached multi-window disclosure trigger to its exact range anchor', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleLargeMonitorFixture(context);
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);

    const timeline = disclosure(page, 'Timeline');
    const events = disclosure(page, 'Events');
    await timeline.locator('summary').click();
    await events.locator('summary').click();
    const eventsWindow = events.getByRole('group', { name: 'Events window' });
    await eventsWindow.getByRole('button', { name: 'Next' }).click();
    await expect(eventsWindow.getByRole('status'))
        .toHaveText('Showing 41–80 of 110 events.');
    const sourceTrigger = events.locator(
        '[data-monitor-source-ordinal="79"] button',
    );
    await sourceTrigger.click();

    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    const close = inspector.getByRole('button', { name: 'Close inspector' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(sourceTrigger).toBeFocused();
    await eventsWindow.getByRole('button', { name: 'Previous' }).click();
    await expect(sourceTrigger).toHaveCount(0);
    const timelineAnchor = timeline.locator(
        '[data-monitor-window-focus-anchor="Timeline"]',
    );
    const eventsAnchor = events.locator(
        '[data-monitor-window-focus-anchor="Events"]',
    );
    await expect(timelineAnchor).toHaveText('Showing 1–40 of 825 timeline rows.');
    await expect(eventsAnchor).toHaveText('Showing 1–40 of 110 events.');

    await expect(eventsAnchor).toBeFocused();
    await expect(timelineAnchor).not.toBeFocused();
});

test('restores a disconnected unowned trigger past the hidden dock to the named work surface', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleLargeMonitorFixture(context);
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);

    const artifact = page.getByRole('button', { name: /^Artifact ·/ }).first();
    expect(await artifact.evaluate(element =>
        element.closest('[data-monitor-window-owner]') === null
    )).toBe(true);
    await artifact.click();

    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    const close = inspector.getByRole('button', { name: 'Close inspector' });
    await expect(close).toBeFocused();
    const dock = page.locator('[data-selection-dock]');
    await expect(dock).toContainText('Artifact ·');
    await expect(dock.locator('button')).toBeHidden();
    await artifact.evaluate(element => element.remove());
    await expect(artifact).toHaveCount(0);

    await close.focus();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(page.getByRole('main', {
        name: 'Recipe console work surface',
    })).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName))
        .toBe('MAIN');
});

test('restores an unmounted disclosure owner past the hidden dock to the named work surface', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleLargeMonitorFixture(context);
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);

    const events = disclosure(page, 'Events');
    await events.locator('summary').click();
    const sourceTrigger = events.locator('[data-monitor-event-row]').first();
    await sourceTrigger.click();
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    const close = inspector.getByRole('button', { name: 'Close inspector' });
    await expect(close).toBeFocused();
    await events.evaluate((element: HTMLDetailsElement) => {
        element.open = false;
    });
    await expect(sourceTrigger).toHaveCount(0);
    await expect(events.locator(
        '[data-monitor-window-focus-anchor="Events"]',
    )).toHaveCount(0);
    await expect(page.locator('[data-selection-dock] button')).toBeHidden();

    await close.focus();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(page.getByRole('main', {
        name: 'Recipe console work surface',
    })).toBeFocused();
});

test('restores a disconnected portrait trigger to the visible live selection dock', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await installRecipeConsoleLargeMonitorFixture(context);
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);

    const artifact = page.getByRole('button', { name: /^Artifact ·/ }).first();
    await artifact.click();
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    const close = inspector.getByRole('button', { name: 'Close inspector' });
    await expect(close).toBeFocused();
    const dockButton = page.locator('[data-selection-dock]')
        .getByRole('button', { name: 'Inspect' });
    await expect(dockButton).toBeVisible();
    await artifact.evaluate(element => element.remove());
    await expect(artifact).toHaveCount(0);

    await close.focus();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(page.locator('[data-selection-dock]')
        .getByRole('button', { name: 'Inspect' })).toBeFocused();
});

test('contains exact long bidi evidence and touch window controls across desktop and mobile contracts', async ({
    browser,
}) => {
    test.slow();
    const consoleProblems: string[] = [];

    for (const contract of [
        { hasTouch: false, name: 'desktop', width: 1440, height: 900 },
        { hasTouch: true, name: 'portrait', width: 430, height: 932 },
        { hasTouch: true, name: 'landscape', width: 932, height: 430 },
    ] as const) {
        const context = await browser.newContext({
            hasTouch: contract.hasTouch,
            isMobile: contract.hasTouch,
            reducedMotion: 'reduce',
            viewport: { width: contract.width, height: contract.height },
        });
        const fixture = await installRecipeConsoleLargeMonitorFixture(context);
        const page = await context.newPage();
        page.on('console', message => {
            if (message.type() === 'error' || message.type() === 'warning') {
                consoleProblems.push(`${contract.name} ${message.type()}: ${message.text()}`);
            }
        });
        await page.goto(LARGE_MONITOR_ROUTE);
        await waitForLargeMonitor(page);
        expect(await page.evaluate(() => navigator.maxTouchPoints > 0))
            .toBe(contract.hasTouch);
        const matrix = page.locator('[data-monitor-section="matrix"]');
        const group = matrix.getByRole('group', { name: 'Agents window' });
        const next = group.getByRole('button', { name: 'Next' });
        if (contract.hasTouch) await next.tap();
        else await next.click();
        const longAgent = matrix.locator('[data-monitor-agent-row]').filter({
            hasText: LARGE_MONITOR_LONG_AGENT_ID,
        });
        await expect(longAgent).toHaveCount(1);
        await expect(longAgent.locator('bdi[data-exact-identifier]'))
            .toHaveAttribute('dir', 'ltr');
        await expect(longAgent).toContainText(LARGE_MONITOR_LONG_AGENT_ID);

        const horizontalOverflow = await page.evaluate(() =>
            document.documentElement.scrollWidth -
                document.documentElement.clientWidth
        );
        expect(horizontalOverflow).toBe(0);
        if (contract.name === 'landscape') {
            await expectContainedLandscapeCommandBar(page);
        }

        if (contract.name !== 'desktop') {
            const bounds = await group.locator('button').evaluateAll(buttons =>
                buttons.map(button => {
                    const box = button.getBoundingClientRect();
                    return { width: box.width, height: box.height };
                })
            );
            expect(bounds.every(box => box.width >= 44 && box.height >= 44))
                .toBe(true);
        }
        await page.screenshot({
            path: `/tmp/rallar-monitor-windowing-${contract.name}.png`,
        });
        expect(fixture.mutationRequestCount()).toBe(0);
        await context.close();
    }

    const reducedContext = await browser.newContext({
        reducedMotion: 'reduce',
        viewport: { width: 900, height: 900 },
    });
    const fixture = await installRecipeConsoleLargeMonitorFixture(reducedContext);
    const page = await reducedContext.newPage();
    await page.goto(LARGE_MONITOR_ROUTE);
    await waitForLargeMonitor(page);
    const failures = page.locator('[data-monitor-section="failures"]');
    const failureWindow = failures.getByRole('group', { name: 'Failures window' });
    await expect(failureWindow).toHaveCSS('transition-duration', '0s');
    await expect(failureWindow).toHaveCSS('animation-name', 'none');
    await expect(failureWindow.getByRole('button', { name: 'Next' }))
        .toHaveCSS('transition-duration', '0s');
    await expect(failureWindow.getByRole('button', { name: 'Next' }))
        .toHaveCSS('animation-name', 'none');
    await failureWindow.getByRole('button', { name: 'Next' }).click();
    await page.locator(
        `[data-failure-key="${LARGE_MONITOR_LAST_FAILURE_COMMAND_ID}"]`,
    ).click();
    const overlay = page.getByRole('dialog', { name: 'Inspector' });
    await expect(overlay).toHaveCSS('transition-duration', '0s');
    await expect(overlay).toHaveCSS('animation-name', 'none');
    expect(consoleProblems).toEqual([]);
    expect(fixture.mutationRequestCount()).toBe(0);
    await reducedContext.close();
});
