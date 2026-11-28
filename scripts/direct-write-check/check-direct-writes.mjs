#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';

import { computeAdmissionBackendFacts } from './admission-backend-facts.mjs';
import { computeDirectWriteCensusLines } from './compute-direct-write-census.mjs';
import { computeDirectWriteFindings } from './compute-direct-write-findings.mjs';
import { toDirectWriteRegistry, validateDirectWriteRegistry } from './direct-write-registry.mjs';
import { toRepositoryPath } from './direct-write-sites.mjs';
import { computeQueueWriteFacts } from './queue-write-facts.mjs';
import { computeRepositoryWriteFacts } from './repository-write-facts.mjs';
import { computeSqlWriteFacts } from './sql-write-facts.mjs';
import { computeTransactionOpenerFacts } from './transaction-opener-facts.mjs';
import { validateDirectWriteReviewPins } from './validate-direct-write-review-pins.mjs';

const REGISTRY_PATH = 'docs/app-inbox-direct-write-registry.md';
const REVIEW_PINS_PATH = 'scripts/direct-write-check/direct-write-review-pins.json';
const SCHEMA_PATH = 'apps/api-v1/prisma/schema.prisma';
const SOURCE_EXTENSIONS = '{ts,tsx,mts,cts}';
const ANALYSED_SOURCES = [`packages/**/*.${SOURCE_EXTENSIONS}`, `apps/*/src/**/*.${SOURCE_EXTENSIONS}`];
/** Browser apps are excluded by name, so a new app under `apps/` is analysed until someone names it here. */
const BROWSER_APPS = [
    'apps/ar-eye-hunter-v1',
    'apps/grumpy-town',
    'apps/rallar-black-box',
    'apps/rallar-black-box-headless',
    'apps/relic-hunters-v1'
];
const EXCLUDED_SOURCES = [
    'packages/tests/**',
    'packages/shared-test/**',
    'packages/shared-rtc-bench/**',
    ...BROWSER_APPS.map((app) => `${app}/**`),
    '**/node_modules/**',
    `**/*.{d,test,spec}.${SOURCE_EXTENSIONS}`
];

process.exitCode = runDirectWriteCheck(readArguments(process.argv.slice(2)));

function runDirectWriteCheck({ root, base }) {
    const read = readValidatedRegistry(root);
    if (read.issues.length > 0) {
        return reportFailure(
            read.issues.map((issue) => ({ line: `direct-write.registry-invalid ${issue}`, advice: '' }))
        );
    }
    const project = loadAnalysedProject(root);
    const scope = toScope(root, read);
    const scopeIssues = validateScopeModules(project, scope);
    if (scopeIssues.length > 0) {
        return reportFailure(
            scopeIssues.map((issue) => ({ line: `direct-write.registry-invalid ${issue}`, advice: '' }))
        );
    }
    const findings = computeDirectWriteFindings(computeDirectWriteFacts(project, scope), read.registry);
    if (findings.length > 0) {
        return reportFailure(findings);
    }
    for (const line of computeDirectWriteCensusLines(read.registry, readBaseRegistry(root, base))) {
        console.log(line);
    }
    console.log(`PASS: direct-write check (${project.getSourceFiles().length} files analysed)`);
    return 0;
}

/** The registry, the review pins it must match, and the schema; any issue stops the check before the analysis. */
function readValidatedRegistry(root) {
    const document = readOptionalText(root, REGISTRY_PATH);
    if (document === undefined) {
        return { issues: [`${REGISTRY_PATH} cannot be read`] };
    }
    const read = toDirectWriteRegistry(document);
    const issues = read.kind === 'invalid' ? read.issues : validateDirectWriteRegistry(read.registry);
    if (issues.length > 0) {
        return { issues };
    }
    const pins = toReviewPins(readOptionalText(root, REVIEW_PINS_PATH));
    if (pins === undefined) {
        return { issues: [`${REVIEW_PINS_PATH} cannot be read as JSON`] };
    }
    const schema = readOptionalText(root, SCHEMA_PATH);
    if (schema === undefined) {
        return { issues: [`${SCHEMA_PATH} cannot be read`] };
    }
    return { registry: read.registry, schema, issues: validateDirectWriteReviewPins(read.registry, pins) };
}

function readOptionalText(root, repositoryPath) {
    try {
        return readFileSync(path.join(root, repositoryPath), 'utf8');
    }
    catch {
        return undefined;
    }
}

function toReviewPins(text) {
    try {
        return text === undefined ? undefined : JSON.parse(text);
    }
    catch {
        return undefined;
    }
}

function computeDirectWriteFacts(project, scope) {
    return {
        ...computeAdmissionBackendFacts(project, scope),
        transactionOpeners: computeTransactionOpenerFacts(project, scope),
        ...computeSqlWriteFacts(project, scope),
        repositoryWriteCallers: computeRepositoryWriteFacts(project, scope),
        queueWriteCallers: computeQueueWriteFacts(project, scope)
    };
}

function reportFailure(findings) {
    for (const finding of findings) {
        console.error(finding.advice === '' ? finding.line : `${finding.line}\n    ${finding.advice}`);
    }
    console.error(`FAIL: direct-write check (${findings.length} finding${findings.length === 1 ? '' : 's'})`);
    return 1;
}

function loadAnalysedProject(root) {
    const project = new Project({
        tsConfigFilePath: path.join(root, 'tsconfig.json'),
        skipAddingFilesFromTsConfig: true
    });
    project.addSourceFilesAtPaths([
        ...ANALYSED_SOURCES.map((pattern) => path.join(root, pattern)),
        ...EXCLUDED_SOURCES.map((pattern) => `!${path.join(root, pattern)}`)
    ]);
    return project;
}

function toScope(root, { registry, schema }) {
    return {
        root,
        wiringModules: registry.wiringModules,
        repositoryContractModules: registry.repositoryContractModules,
        workTopicConstants: registry.workTopicConstants,
        schemaTables: [...schema.matchAll(/^model\s+(\w+)\s*\{/gmu)].map((match) => match[1])
    };
}

function validateScopeModules(project, scope) {
    const analysed = new Set(project.getSourceFiles().map((sourceFile) => toRepositoryPath(sourceFile, scope.root)));
    const named = [
        ...['wiringModules', 'repositoryContractModules'].flatMap((field) =>
            scope[field].map((modulePath) => [field, modulePath])
        ),
        ...scope.workTopicConstants.map((topic) => ['workTopicConstants', topic.path])
    ];
    return named
        .filter(([, modulePath]) => !analysed.has(modulePath))
        .map(([field, modulePath]) => `${field} names ${modulePath}, which the analysed source does not hold`);
}

/** The registry where this branch left the base, so entries the base gained since are not shown as removed. */
function readBaseRegistry(root, base) {
    const mergeBase = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (mergeBase.status !== 0) {
        return { kind: 'unavailable', label: base };
    }
    const commit = mergeBase.stdout.trim();
    const shown = spawnSync('git', ['show', `${commit}:${REGISTRY_PATH}`], { cwd: root, encoding: 'utf8' });
    const read = shown.status === 0 ? toDirectWriteRegistry(shown.stdout) : { kind: 'invalid' };
    return {
        kind: 'available',
        label: `the merge base of ${base} and HEAD (${commit.slice(0, 12)})`,
        registry: read.kind === 'parsed' ? read.registry : {}
    };
}

function readArguments(args) {
    const values = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), base: 'origin/main' };
    for (let index = 0; index < args.length; index += 2) {
        if (args[index] === '--root') {
            values.root = path.resolve(args[index + 1]);
        }
        else if (args[index] === '--base') {
            values.base = args[index + 1];
        }
        else {
            throw new Error('usage: check-direct-writes.mjs [--root <repository>] [--base <git ref>]');
        }
    }
    return values;
}
