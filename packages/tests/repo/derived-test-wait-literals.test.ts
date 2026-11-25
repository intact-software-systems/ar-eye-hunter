import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { findLiteralWaitBounds } from './find-literal-wait-bounds.ts';
import { findUntimedRequests } from './find-untimed-requests.ts';

const repoRoot = path.resolve(__dirname, '../../..');

const playwrightRoot = 'tests/playwright/rallar-black-box';

const budgetsRoot = 'packages/shared-test/rallar-bb-test/browser-test-budgets';

/**
 * Every file on the paths of the tests whose timeouts are derived: the lifecycle scenarios, the matrix proof and its
 * every-scenario and retention tests, the layout-switch tests, the live distributed, simulated ACK and simulated
 * failure tests, the Console lifecycle and Native tests, the director scenario, the two-agent and real smokes, the
 * worker HOST capture tests and the view push test, with the harnesses, derivations, budgets and web servers they run.
 */
const DERIVED_TEST_PATH_FILES = [
    `${playwrightRoot}/full-stack-live-rtc-lifecycle-acceptance.spec.ts`,
    `${playwrightRoot}/full-stack-live-rtc-three-browser-matrix.spec.ts`,
    `${playwrightRoot}/full-stack-live-rtc-layout-switch-stream.spec.ts`,
    `${playwrightRoot}/full-stack-distributed-recipes.spec.ts`,
    `${playwrightRoot}/full-stack-recipe-console-monitor.spec.ts`,
    `${playwrightRoot}/full-stack-director-orchestration.spec.ts`,
    `${playwrightRoot}/full-stack-worker-host-capture.spec.ts`,
    `${playwrightRoot}/browser-rallar-two-agent-smoke.spec.ts`,
    `${playwrightRoot}/browser-rallar-real-smoke.spec.ts`,
    `${playwrightRoot}/full-stack-view-push.spec.ts`,
    `${playwrightRoot}/live-rtc-agent-environment.ts`,
    `${playwrightRoot}/live-rtc-browser-agents.ts`,
    `${playwrightRoot}/live-rtc-browser-recording.ts`,
    `${playwrightRoot}/live-rtc-control-client.ts`,
    `${playwrightRoot}/retention-live-rtc-control-client.ts`,
    `${playwrightRoot}/live-rtc-delivery-operations.ts`,
    `${playwrightRoot}/live-rtc-formation-operations.ts`,
    `${playwrightRoot}/live-rtc-layout-switch-operations.ts`,
    `${playwrightRoot}/live-rtc-wire-observation.ts`,
    `${playwrightRoot}/create-group-formation-lifecycle-driver.ts`,
    `${playwrightRoot}/live-rtc-recorder-reader.ts`,
    `${playwrightRoot}/live-rtc-recorder-rows.ts`,
    `${playwrightRoot}/expect-live-rtc-artifact-evidence.ts`,
    `${playwrightRoot}/live-rtc-performance-evidence.ts`,
    `${playwrightRoot}/full-stack-helpers.ts`,
    `${playwrightRoot}/read-control-get-response.ts`,
    `${playwrightRoot}/distributed-run-requests.ts`,
    `${playwrightRoot}/distributed-recipes/browser-agents.ts`,
    `${playwrightRoot}/distributed-recipes/distributed-control.ts`,
    `${playwrightRoot}/distributed-recipes/distributed-recipe-test-runs.ts`,
    `${playwrightRoot}/distributed-recipes/recipe-manifests.ts`,
    `${playwrightRoot}/distributed-recipes/runtime-observations.ts`,
    `${playwrightRoot}/distributed-recipes/run-evidence.ts`,
    `${playwrightRoot}/distributed-recipes/to-recommended-terminal-timeout-ms.ts`,
    `${playwrightRoot}/browser-rallar-two-agent-smoke.ts`,
    `${playwrightRoot}/director-orchestration-operations.ts`,
    `${playwrightRoot}/director-orchestration-waits.ts`,
    `${playwrightRoot}/compute-live-rtc-lifecycle-scenario-timeout-ms.ts`,
    `${playwrightRoot}/director-orchestration-test-timeouts.ts`,
    `${playwrightRoot}/live-rtc-layout-switch-test-timeouts.ts`,
    `${playwrightRoot}/recipe-console-monitor-test-timeouts.ts`,
    `${playwrightRoot}/recipe-console-operator-waits.ts`,
    `${playwrightRoot}/two-agent-smoke-test-timeouts.ts`,
    `${playwrightRoot}/worker-host-capture-test-timeouts.ts`,
    `${playwrightRoot}/compute-view-push-test-deadlines.ts`,
    'apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts',
    'apps/rallar-black-box/playwright.config.ts',
    'apps/rallar-black-box/playwright.full-stack.config.ts',
    'apps/rallar-black-box/playwright-full-stack-api-server.ts',
    'apps/rallar-black-box/playwright-full-stack-spa-server.ts',
    'apps/rallar-black-box/playwright-full-stack-control-server.ts',
    'packages/shared-test/black-box-runner/artifacts/rtc-native-acquisition.ts',
    'packages/shared-test/black-box-runner/artifacts/read-recorder-jsonl-rows.ts',
    'packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts',
    `${budgetsRoot}/browser-test-harness-margin-ms.ts`,
    `${budgetsRoot}/compute-command-result-wait-ms.ts`,
    `${budgetsRoot}/control-agent-opening-timeout-ms.ts`,
    `${budgetsRoot}/full-stack-web-server-start-timeouts.ts`,
    `${budgetsRoot}/group-membership-waits.ts`,
    `${budgetsRoot}/live-rtc-agent-opening-waits.ts`,
    `${budgetsRoot}/live-rtc-control-waits.ts`,
    `${budgetsRoot}/live-rtc-delivery-matrix-waits.ts`,
    `${budgetsRoot}/live-rtc-delivery-waits.ts`,
    `${budgetsRoot}/live-rtc-formation-waits.ts`,
    `${budgetsRoot}/live-rtc-matrix-test-timeouts.ts`,
    `${budgetsRoot}/live-rtc-recorder-read-waits.ts`,
    `${budgetsRoot}/playwright-expect-timeouts.ts`,
    `${budgetsRoot}/realtime-send-open-timeout-ms.ts`,
    `${budgetsRoot}/settled-trio-retirement-bounded-waits-ms.ts`
] as const;

function readPathFile(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** The names a source declares for its numeric constants. */
function findNumericConstantNames(source: string): readonly string[] {
    return [...source.matchAll(/^(?:export )?const ([A-Z][A-Z\d_]*_MS) =/gm)].map((match) => match[1]);
}

/** Each named wait declared straight after another declaration, so that it shares the doc above the first, as `line: text`. */
function findUndocumentedPairedConstants(source: string): readonly string[] {
    const lines = source.split('\n');
    return lines.flatMap((line, index) => {
        const previous = lines[index - 1]?.trim() ?? '';
        const shared = /^(?:export )?const [A-Z][A-Z\d_]*_MS =/.test(line) && previous.endsWith(';');
        return shared ? [`${index + 1}: ${line.trim()}`] : [];
    });
}

describe('literal waits on the derived tests\' paths', () => {
    // The 2069fbae8 health read wait in `live-rtc-control-client.ts` and the view push spec's state poll were literal
    // waits the earlier line patterns did not see; the review named the other forms.
    it('finds a literal in every position that passes it as a wait bound', () => {
        expect(findLiteralWaitBounds([
            'const healthTimeoutMs = Math.min(',
            '    15_000,',
            '    deadlineMs - this.#monotonicNow()',
            ');',
            'run({ pollMs: 250, readinessTimeoutMs: deadlines.readinessTimeoutMs });',
            'const limit = X_TIMEOUT_MS + 15_000;',
            'const { timeout = 45_000 } = input;',
            'await new Promise((resolve) => setTimeout(resolve, 2_000));',
            'const fallback = budget ?? 15_000;',
            'const deadline = Date.now() + 60_000;',
            'await within(exited, 10_000, \'did not exit\');',
            'await holdFor(agent, 5_000);',
            'await expect(panel).toContainText(id, { timeout: 15_000 });',
            'await page.waitForTimeout(500);',
            'setTimeout(() => {',
            '}, 10_000);',
            'const command = { readiness: { minReadyPeers: 1, timeoutMs: 10_000 }, intervals: [1_000] };'
        ].join('\n'))).toEqual([
            '2: 15_000,',
            '5: run({ pollMs: 250, readinessTimeoutMs: deadlines.readinessTimeoutMs });',
            '6: const limit = X_TIMEOUT_MS + 15_000;',
            '7: const { timeout = 45_000 } = input;',
            '8: await new Promise((resolve) => setTimeout(resolve, 2_000));',
            '9: const fallback = budget ?? 15_000;',
            '10: const deadline = Date.now() + 60_000;',
            '11: await within(exited, 10_000, \'did not exit\');',
            '12: await holdFor(agent, 5_000);',
            '13: await expect(panel).toContainText(id, { timeout: 15_000 });',
            '14: await page.waitForTimeout(500);',
            '16: }, 10_000);',
            '17: const command = { readiness: { minReadyPeers: 1, timeoutMs: 10_000 }, intervals: [1_000] };'
        ]);
    });

    it('passes over named constants, counts, asserted expectations and values that are not times', () => {
        expect(findLiteralWaitBounds([
            'export const WS_OPEN_TIMEOUT_MS = 15_000;',
            'const RETRIES = 3 * (CONTROL_GET_ATTEMPTS - 1) * CONTROL_GET_RETRY_PAUSE_MS;',
            'await expect(locator).toBeVisible({ timeout: CONTROL_AGENT_OPENING_TIMEOUT_MS });',
            'const total = timeoutMs + 2 * VIEW_PUSH_STATE_POLL_INTERVAL_MS;',
            'const command = { ackTimeoutMs: 0, count: 25, acceptedStatusCodes: [200, 201] };',
            'expect(connect).toMatchObject({ readiness: { minReadyPeers: 1, timeoutMs: 10_000 } });',
            'expect(response.status()).toBe(202);',
            'const text = JSON.stringify(value, null, 2).slice(0, 120);'
        ].join('\n'))).toEqual([]);
    });

    // Two modules declared the same realtime open budget apart, each with its own copy of the doc.
    it('declares each named wait once across the derived tests\' paths', () => {
        const ownersByName = Object.groupBy(
            DERIVED_TEST_PATH_FILES.filter((relativePath) => existsSync(path.join(repoRoot, relativePath))).flatMap(
                (relativePath) => findNumericConstantNames(readPathFile(relativePath)).map((name) => ({ name, relativePath }))
            ),
            ({ name }) => name
        );
        const duplicated = Object.fromEntries(
            Object.entries(ownersByName).flatMap(([name, owners]) =>
                (owners ?? []).length > 1 ? [[name, (owners ?? []).map(({ relativePath }) => relativePath)]] : []
            )
        );

        expect(duplicated).toEqual({});
    });

    // Pairs of waits shared one doc, which then described the second constant only by implication.
    it('gives each named wait its own doc', () => {
        expect(findUndocumentedPairedConstants([
            '/** The appointment\'s own budget, and each relay start\'s. */',
            'export const APPOINT_TIMEOUT_MS = 20_000;',
            'export const RELAY_START_TIMEOUT_MS = 20_000;',
            '',
            '/** Documented. */',
            'const OWN_TIMEOUT_MS = 1_000;'
        ].join('\n'))).toEqual(['3: export const RELAY_START_TIMEOUT_MS = 20_000;']);
        const paired = Object.fromEntries(
            DERIVED_TEST_PATH_FILES.filter((relativePath) => existsSync(path.join(repoRoot, relativePath))).flatMap(
                (relativePath) => {
                    const found = findUndocumentedPairedConstants(readPathFile(relativePath));
                    return found.length === 0 ? [] : [[relativePath, found]];
                }
            )
        );

        expect(paired).toEqual({});
    });

    // Every request ran under the request context's own 30 s default, which no derivation counted.
    it('finds a request through a request context that names no timeout of its own', () => {
        expect(findUntimedRequests([
            'const response = await request.get(url);',
            'await this.#request.post(url, { data: { commandId } });',
            'run.request.get(`${base}/artifacts`).then(read);',
            'await this.dependencies.request.fetch(String(url), { method: init?.method });',
            'await input.request.post(url, options);',
            'await request.get(url, { timeout: CONTROL_REQUEST_TIMEOUT_MS });',
            'await this.#request.post(url, { data, timeout: CONTROL_REQUEST_TIMEOUT_MS });',
            'const value = params.get(\'runId\') ?? headers.get(\'content-type\');',
            'const sent = route.request().headers();'
        ].join('\n'))).toEqual([
            '1: const response = await request.get(url);',
            '2: await this.#request.post(url, { data: { commandId } });',
            '3: run.request.get(`${base}/artifacts`).then(read);',
            '4: await this.dependencies.request.fetch(String(url), { method: init?.method });',
            '5: await input.request.post(url, options);'
        ]);
    });

    it('names a timeout for every request on the derived tests\' paths', () => {
        const untimed = Object.fromEntries(
            DERIVED_TEST_PATH_FILES.filter((relativePath) => existsSync(path.join(repoRoot, relativePath))).flatMap(
                (relativePath) => {
                    const found = findUntimedRequests(readPathFile(relativePath));
                    return found.length === 0 ? [] : [[relativePath, found]];
                }
            )
        );

        expect(untimed).toEqual({});
    });

    it('passes every wait bound on the derived tests\' paths as a named constant', () => {
        const missing = DERIVED_TEST_PATH_FILES.filter((relativePath) => !existsSync(path.join(repoRoot, relativePath)));
        const literalWaits = Object.fromEntries(
            DERIVED_TEST_PATH_FILES.filter((relativePath) => !missing.includes(relativePath)).flatMap((relativePath) => {
                const found = findLiteralWaitBounds(readPathFile(relativePath));
                return found.length === 0 ? [] : [[relativePath, found]];
            })
        );

        expect(missing).toEqual([]);
        expect(literalWaits).toEqual({});
    });
});
