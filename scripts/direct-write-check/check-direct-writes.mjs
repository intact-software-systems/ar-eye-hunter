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
import { computeRepositoryWriteFacts } from './repository-write-facts.mjs';
import { computeSqlWriteFacts } from './sql-write-facts.mjs';
import { computeTransactionOpenerFacts } from './transaction-opener-facts.mjs';

const REGISTRY_PATH = 'docs/app-inbox-direct-write-registry.md';
const SCHEMA_PATH = 'apps/api-v1/prisma/schema.prisma';
const ANALYSED_SOURCES = [
    'packages/**/*.ts',
    'apps/api-v1/src/**/*.ts',
    'apps/relic-hunter-server-v1/src/**/*.ts',
    'apps/ar-eye-hunter-server-v1/src/**/*.ts',
    'apps/rallar-black-box-control-server/src/**/*.ts'
];
const EXCLUDED_SOURCES = [
    'packages/tests/**',
    'packages/shared-test/**',
    'packages/shared-rtc-bench/**',
    '**/node_modules/**',
    '**/{fixtures,fixture,mocks,mock,generated,vendor}/**',
    '**/*.{d,test,spec}.ts'
];

process.exitCode = runDirectWriteCheck(readArguments(process.argv.slice(2)));

function runDirectWriteCheck({ root, base }) {
    const read = toDirectWriteRegistry(readFileSync(path.join(root, REGISTRY_PATH), 'utf8'));
    const issues = read.kind === 'invalid' ? read.issues : validateDirectWriteRegistry(read.registry);
    if (issues.length > 0) {
        return reportFailure(issues.map((issue) => ({ line: `direct-write.registry-invalid ${issue}`, advice: '' })));
    }
    const project = loadAnalysedProject(root);
    const scope = toScope(root, read.registry);
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

function computeDirectWriteFacts(project, scope) {
    return {
        ...computeAdmissionBackendFacts(project, scope),
        transactionOpeners: computeTransactionOpenerFacts(project, scope),
        ...computeSqlWriteFacts(project, scope),
        repositoryWriteCallers: computeRepositoryWriteFacts(project, scope)
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

function toScope(root, registry) {
    const schema = readFileSync(path.join(root, SCHEMA_PATH), 'utf8');
    return {
        root,
        wiringModules: registry.wiringModules,
        repositoryContractModules: registry.repositoryContractModules,
        keyModules: registry.keyModules,
        workTopicConstants: registry.workTopicConstants,
        schemaTables: [...schema.matchAll(/^model\s+(\w+)\s*\{/gmu)].map((match) => match[1])
    };
}

function validateScopeModules(project, scope) {
    const analysed = new Set(project.getSourceFiles().map((sourceFile) => toRepositoryPath(sourceFile, scope.root)));
    const named = [
        ...['wiringModules', 'repositoryContractModules', 'keyModules'].flatMap((field) =>
            scope[field].map((modulePath) => [field, modulePath])
        ),
        ...scope.workTopicConstants.map((topic) => ['workTopicConstants', topic.path])
    ];
    return named
        .filter(([, modulePath]) => !analysed.has(modulePath))
        .map(([field, modulePath]) => `${field} names ${modulePath}, which the analysed source does not hold`);
}

function readBaseRegistry(root, base) {
    const verified = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
        cwd: root,
        encoding: 'utf8'
    });
    if (verified.status !== 0) {
        return { kind: 'unavailable', label: base };
    }
    const shown = spawnSync('git', ['show', `${base}:${REGISTRY_PATH}`], { cwd: root, encoding: 'utf8' });
    const read = shown.status === 0 ? toDirectWriteRegistry(shown.stdout) : { kind: 'invalid' };
    return { kind: 'available', label: base, registry: read.kind === 'parsed' ? read.registry : {} };
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
