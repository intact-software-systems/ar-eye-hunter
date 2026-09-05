#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';

import {
    analyzeTransactionWrites,
    isBlockingTransactionWriteFinding
} from './analyze-transaction-writes.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const project = new Project({
    tsConfigFilePath: path.join(repositoryRoot, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true
});

project.addSourceFilesAtPaths([
    path.join(repositoryRoot, 'packages/**/*.ts'),
    path.join(repositoryRoot, 'apps/api-v1/src/**/*.ts'),
    `!${path.join(repositoryRoot, 'packages/tests/**')}`,
    `!${path.join(repositoryRoot, 'packages/shared-test/**')}`,
    `!${path.join(repositoryRoot, 'packages/shared-rtc-bench/**')}`
]);

const findings = analyzeTransactionWrites(project);
for (const finding of findings) {
    const severity = isBlockingTransactionWriteFinding(finding) ? 'ERROR' : 'WARN';
    console.error(
        `${severity} ${finding.path}:${finding.line}:${finding.column} ` +
            `${finding.rule} ${finding.operation} (boundary ${finding.boundary})`
    );
}
const blockingFindings = findings.filter(isBlockingTransactionWriteFinding);
if (blockingFindings.length > 0) {
    console.error(
        `FAIL: transaction write check (${blockingFindings.length} blocking, ${findings.length} total findings)`
    );
    process.exitCode = 1;
}
else {
    console.log(`PASS: transaction write check (${findings.length} advisory findings)`);
}
