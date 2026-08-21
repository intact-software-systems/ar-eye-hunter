#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const projectPath = 'packages/tests/tsconfig.json';
const debtPath = 'packages/tests/typecheck-debt.json';
const updateCommand = 'npm run typecheck:tests -- --update';
// The Deno apps are not npm workspaces, so `npm ci` never creates their node_modules and CI never
// sees this cache. A machine that has run the Deno tasks resolves a second copy of shared npm
// packages from it, and the resulting duplicate-identity errors are reported against enforced test
// files rather than against a node_modules path -- they name the cache in the message instead.
const denoCacheSegment = 'node_modules/.deno/';

const shouldUpdate = process.argv.slice(2).includes('--update');
const currentErrorCounts = readCurrentErrorCounts();

if (shouldUpdate) {
    writeDebt(currentErrorCounts);
    const total = computeTotalErrors(currentErrorCounts);
    console.log(
        `PASS: rewrote ${debtPath} with ${Object.keys(currentErrorCounts).length} files ` +
            `and ${total} errors`
    );
}
else {
    reportComparison(validateAgainstDebt(currentErrorCounts, readDebt()));
}

function readCurrentErrorCounts() {
    const packageManifest = createRequire(import.meta.url).resolve('typescript/package.json');
    const compilerPath = path.join(path.dirname(packageManifest), 'bin', 'tsc');
    const result = spawnSync(
        process.execPath,
        [compilerPath, '-p', projectPath, '--noEmit', '--pretty', 'false'],
        { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    if (result.error !== undefined) {
        console.log(`FAIL: could not run tsc: ${result.error.message}`);
        process.exit(1);
    }
    return toErrorCounts(`${result.stdout}${result.stderr}`);
}

// Third-party declaration errors are excluded: their paths carry machine-specific Deno cache
// segments, and skipLibCheck is forbidden by packages/tests/repo/typescript-7-boundaries.test.ts.
function toErrorCounts(compilerOutput) {
    const diagnosticPattern = /^(.+?)\(\d+,\d+\): error TS\d+:/u;
    const counts = {};
    for (const line of compilerOutput.split('\n')) {
        const match = diagnosticPattern.exec(line);
        if (match === null) {
            continue;
        }
        const diagnostic = line.split(path.sep).join('/');
        if (diagnostic.includes(denoCacheSegment)) {
            continue;
        }
        const file = match[1].split(path.sep).join('/');
        if (file.includes('node_modules/')) {
            continue;
        }
        counts[file] = (counts[file] ?? 0) + 1;
    }
    return counts;
}

function readDebt() {
    try {
        return JSON.parse(readFileSync(path.join(repositoryRoot, debtPath), 'utf8')).files ?? {};
    }
    catch (cause) {
        console.log(`FAIL: could not read ${debtPath}: ${cause.message}. Run \`${updateCommand}\`.`);
        process.exit(1);
    }
}

function writeDebt(errorCounts) {
    const files = Object.fromEntries(
        Object.entries(errorCounts).toSorted(([left], [right]) => left.localeCompare(right))
    );
    const debt = {
        description: 'Files under the packages/tests TypeScript project that still fail to compile. ' +
            'This list may only shrink: CI fails when a file gains errors or is absent from it. ' +
            `Regenerate with \`${updateCommand}\` after fixing files.`,
        project: projectPath,
        totalErrors: computeTotalErrors(errorCounts),
        fileCount: Object.keys(files).length,
        files
    };
    writeFileSync(path.join(repositoryRoot, debtPath), `${JSON.stringify(debt, null, 2)}\n`, 'utf8');
}

function computeTotalErrors(errorCounts) {
    return Object.values(errorCounts).reduce((total, count) => total + count, 0);
}

function validateAgainstDebt(currentErrorCounts, debtErrorCounts) {
    const regressions = [];
    const improvements = [];
    for (const [file, count] of Object.entries(currentErrorCounts)) {
        const allowed = debtErrorCounts[file];
        if (allowed === undefined) {
            regressions.push(`new type errors in an enforced file: ${file} (${count})`);
        }
        else if (count > allowed) {
            regressions.push(`type errors increased in ${file}: ${allowed} allowed, ${count} found`);
        }
        else if (count < allowed) {
            improvements.push(`${file}: ${allowed} -> ${count}`);
        }
    }
    for (const file of Object.keys(debtErrorCounts)) {
        if (currentErrorCounts[file] === undefined) {
            improvements.push(`${file}: now clean`);
        }
    }
    return { regressions, improvements, currentErrorCounts, debtErrorCounts };
}

function reportComparison(comparison) {
    const enforcedCount = countEnforcedFiles(comparison.debtErrorCounts);
    console.log(
        `check-tests-typecheck: ${enforcedCount} test files enforced, ` +
            `${Object.keys(comparison.debtErrorCounts).length} files carrying known debt ` +
            `(${computeTotalErrors(comparison.debtErrorCounts)} errors).`
    );
    for (const regression of comparison.regressions.toSorted()) {
        console.log(`FAIL: ${regression}`);
    }
    for (const improvement of comparison.improvements.toSorted()) {
        console.log(`FAIL: debt shrank, lock it in with \`${updateCommand}\` -- ${improvement}`);
    }
    if (comparison.regressions.length > 0 || comparison.improvements.length > 0) {
        process.exitCode = 1;
        return;
    }
    console.log('PASS: no new type errors under packages/tests');
}

function countEnforcedFiles(debtErrorCounts) {
    return readProjectTestFiles('packages/tests').filter(
        (file) => debtErrorCounts[file] === undefined
    ).length;
}

function readProjectTestFiles(directory) {
    const entries = readdirSync(path.join(repositoryRoot, directory), { withFileTypes: true });
    return entries.flatMap((entry) => {
        const entryPath = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : readProjectTestFiles(entryPath);
        }
        return entry.name.endsWith('.test.ts') ? [entryPath] : [];
    });
}
