import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');

const playwrightRoot = 'tests/playwright/rallar-black-box';

const budgetsRoot = 'packages/shared-test/rallar-bb-test/browser-test-budgets';

/**
 * Every file on the paths of the tests whose timeouts are derived: the lifecycle scenarios, the matrix proof and its
 * every-scenario and retention tests, the live distributed and simulated ACK tests, the Console Native test, the
 * director scenario, the two-agent smokes and the view push test, with the harnesses, derivations and budgets they run.
 */
const DERIVED_TEST_PATH_FILES = [
    `${playwrightRoot}/full-stack-live-rtc-lifecycle-acceptance.spec.ts`,
    `${playwrightRoot}/full-stack-live-rtc-three-browser-matrix.spec.ts`,
    `${playwrightRoot}/full-stack-distributed-recipes.spec.ts`,
    `${playwrightRoot}/full-stack-recipe-console-monitor.spec.ts`,
    `${playwrightRoot}/full-stack-director-orchestration.spec.ts`,
    `${playwrightRoot}/browser-rallar-two-agent-smoke.spec.ts`,
    `${playwrightRoot}/full-stack-view-push.spec.ts`,
    `${playwrightRoot}/live-rtc-agent-environment.ts`,
    `${playwrightRoot}/live-rtc-browser-agents.ts`,
    `${playwrightRoot}/live-rtc-browser-recording.ts`,
    `${playwrightRoot}/live-rtc-control-client.ts`,
    `${playwrightRoot}/retention-live-rtc-control-client.ts`,
    `${playwrightRoot}/live-rtc-delivery-operations.ts`,
    `${playwrightRoot}/live-rtc-formation-operations.ts`,
    `${playwrightRoot}/create-group-formation-lifecycle-driver.ts`,
    `${playwrightRoot}/live-rtc-recorder-reader.ts`,
    `${playwrightRoot}/live-rtc-recorder-rows.ts`,
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
    `${playwrightRoot}/compute-live-rtc-lifecycle-scenario-timeout-ms.ts`,
    `${playwrightRoot}/director-orchestration-test-timeouts.ts`,
    `${playwrightRoot}/recipe-console-monitor-test-timeouts.ts`,
    `${playwrightRoot}/two-agent-smoke-test-timeouts.ts`,
    `${playwrightRoot}/compute-view-push-test-deadlines.ts`,
    'apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts',
    'apps/rallar-black-box/playwright.config.ts',
    'apps/rallar-black-box/playwright.full-stack.config.ts',
    `${budgetsRoot}/browser-test-harness-margin-ms.ts`,
    `${budgetsRoot}/compute-command-result-wait-ms.ts`,
    `${budgetsRoot}/control-agent-opening-timeout-ms.ts`,
    `${budgetsRoot}/full-stack-web-server-start-timeouts.ts`,
    `${budgetsRoot}/group-membership-waits.ts`,
    `${budgetsRoot}/live-rtc-agent-opening-waits.ts`,
    `${budgetsRoot}/live-rtc-control-waits.ts`,
    `${budgetsRoot}/live-rtc-delivery-waits.ts`,
    `${budgetsRoot}/live-rtc-formation-waits.ts`,
    `${budgetsRoot}/live-rtc-matrix-test-timeouts.ts`,
    `${budgetsRoot}/live-rtc-recorder-read-waits.ts`,
    `${budgetsRoot}/playwright-expect-timeouts.ts`
] as const;

/**
 * A wait bound written as a nonzero number where it is passed: a `timeout` or `…TimeoutMs` field, its default after
 * `??`, a literal added to such a bound, or the delay of a `waitForTimeout` or a `setTimeout`. A named constant's own
 * declaration names its value and is not a pass.
 */
const LITERAL_WAIT_PATTERNS: readonly RegExp[] = [
    /\b\w*[tT]imeout(?:Ms)?\s*:\s*[1-9]/,
    /\b\w*[tT]imeout(?:Ms)?\s*:[^,\n}]*\?\?\s*[1-9]/,
    /\b\w*[tT]imeout(?:Ms)?\s*[-+]\s*[1-9][\d_]*(?![\d_]*\s*\*)/,
    /\b[1-9][\d_]*\s*\+\s*\w*[tT]imeout/,
    /\bwaitForTimeout\(\s*[1-9]/,
    /^\s*\}\s*,\s*[1-9][\d_]*\s*\);/
];

/** Each line of a source that passes a literal wait bound, as `line: text`. */
function findLiteralWaits(source: string): readonly string[] {
    return source.split('\n').flatMap((line, index) => LITERAL_WAIT_PATTERNS.some((pattern) => pattern.test(line)) ? [`${index + 1}: ${line.trim()}`] : []);
}

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
    it('finds each way a literal wait bound is passed and passes over named ones', () => {
        expect(findLiteralWaits([
            '    timeoutMs: 30_000',
            '    await expect(panel).toContainText(id, { timeout: 15_000 });',
            '    timeoutMs: input.timeoutMs + 15_000',
            '    ackTimeoutMs: input.ackTimeoutMs ?? 10_000,',
            '    await page.waitForTimeout(500);',
            '    }, 10_000);',
            '    timeoutMs: WS_OPEN_TIMEOUT_MS',
            '    { timeout: CONTROL_AGENT_OPENING_TIMEOUT_MS }',
            '    timeoutMs + 2 * VIEW_PUSH_STATE_POLL_INTERVAL_MS',
            '    ackTimeoutMs: 0,',
            'export const WS_OPEN_TIMEOUT_MS = 15_000;'
        ].join('\n'))).toEqual([
            '1: timeoutMs: 30_000',
            '2: await expect(panel).toContainText(id, { timeout: 15_000 });',
            '3: timeoutMs: input.timeoutMs + 15_000',
            '4: ackTimeoutMs: input.ackTimeoutMs ?? 10_000,',
            '5: await page.waitForTimeout(500);',
            '6: }, 10_000);'
        ]);
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

    // Two rounds each left a literal wait on these paths uncounted; a literal can no longer join a counted path.
    it('passes every wait bound on the derived tests\' paths as a named constant', () => {
        const missing = DERIVED_TEST_PATH_FILES.filter((relativePath) => !existsSync(path.join(repoRoot, relativePath)));
        const literalWaits = Object.fromEntries(
            DERIVED_TEST_PATH_FILES.filter((relativePath) => !missing.includes(relativePath)).flatMap((relativePath) => {
                const found = findLiteralWaits(readPathFile(relativePath));
                return found.length === 0 ? [] : [[relativePath, found]];
            })
        );

        expect(missing).toEqual([]);
        expect(literalWaits).toEqual({});
    });
});
