import {
    existsSync,
    readFileSync,
    realpathSync
} from 'node:fs';
import { relative, resolve } from 'node:path';

/** Compare native collection with execution; listing alone cannot observe a skip inside a test body. */
export function checkPlaywrightTestExecution(arguments_, root) {
    const paths = { listed: [], executed: [], required: [] };
    const flags = new Map([
        ['--listed', paths.listed],
        ['--executed', paths.executed],
        ['--require-file', paths.required]
    ]);
    for (let index = 0; index < arguments_.length; index += 2) {
        const target = flags.get(arguments_[index]);
        const value = arguments_[index + 1];
        if (!target || !value || value.startsWith('--')) {
            throw new Error('Expected --listed <json>, --executed <json>, or --require-file <spec>');
        }
        target.push(value);
    }
    if (paths.listed.length === 0 || paths.executed.length === 0) {
        throw new Error('Playwright execution reachability requires native listing and execution reports');
    }
    const listed = paths.listed.flatMap((path) => readPlaywrightCases(path, root));
    const executed = paths.executed.flatMap((path) => readPlaywrightCases(path, root));
    const passed = new Set(executed.filter((test) => test.passed).map((test) => test.key));
    const required = paths.required.map((file) => {
        const absolute = resolve(root, file);
        return relative(root, existsSync(absolute) ? realpathSync(absolute) : absolute).replaceAll('\\', '/');
    });
    const missingFiles = required.filter((file) => !listed.some((test) => test.file === file));
    const missing = listed.filter((test) => !passed.has(test.key));
    console.log(
        `Playwright execution reachability: ${listed.length} listed cases, ${missing.length} without a passing execution.`
    );
    if (listed.length === 0 || missing.length > 0 || missingFiles.length > 0) {
        throw new Error([
            'Playwright execution reachability is incomplete:',
            ...missingFiles.map((file) => `${file}: required file was not listed`),
            ...missing.map((test) => `${test.description}: listed but skipped, missing, or failed at runtime`),
            ...(listed.length === 0 ? ['No test cases were listed'] : [])
        ].join('\n'));
    }
}

function readPlaywrightCases(path, root) {
    const report = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    if (
        !report.config || typeof report.config.rootDir !== 'string' || !Array.isArray(report.suites) ||
        !Array.isArray(report.errors)
    ) {
        throw new Error(`${path}: not a native Playwright JSON report`);
    }
    if (report.errors.length > 0) {
        throw new Error(`${path}: Playwright reported ${report.errors.length} runner errors`);
    }
    return report.suites.flatMap((suite) =>
        toPlaywrightCases(suite, { root, testRoot: report.config.rootDir, titles: [] })
    );
}

function toPlaywrightCases(suite, context) {
    if (
        typeof suite.title !== 'string' || !Array.isArray(suite.specs) ||
        (suite.suites !== undefined && !Array.isArray(suite.suites))
    ) {
        throw new Error('Malformed Playwright suite in execution report');
    }
    const titles = [...context.titles, suite.title];
    const cases = suite.specs.flatMap((spec) => {
        if (typeof spec.file !== 'string' || typeof spec.title !== 'string' || !Array.isArray(spec.tests)) {
            throw new Error('Malformed Playwright spec in execution report');
        }
        const file = relative(context.root, resolve(context.testRoot, spec.file)).replaceAll('\\', '/');
        return spec.tests.map((test) => {
            if (typeof test.projectName !== 'string' || !Array.isArray(test.results)) {
                throw new Error('Malformed Playwright test in execution report');
            }
            // File suites can have different relative titles across configs; the canonical path owns identity.
            const title = [...titles.slice(1), spec.title];
            return {
                key: JSON.stringify([file, title, test.projectName]),
                file,
                description: `${file} > ${title.join(' > ')} [${test.projectName}]`,
                passed: test.expectedStatus === 'passed' && test.results.some((result) => result.status === 'passed')
            };
        });
    });
    return [...cases, ...(suite.suites ?? []).flatMap((child) => toPlaywrightCases(child, { ...context, titles }))];
}
