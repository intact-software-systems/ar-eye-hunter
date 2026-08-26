#!/usr/bin/env node
import path from 'node:path';

import { formatNavigationReport, scanNavigationProject } from './repo-style-check/navigation-rules.mjs';
import {
    activeLayoutRuleIds,
    collectProductionSources,
    resolveScanRoots,
    scanProductionSources
} from './repo-style-check/repository-scan.mjs';

const maxDisplayedFindingCount = 200;
const supportedFlags = new Set([
    '--cognitive-metrics',
    '--construction-details',
    '--layout-details',
    '--layout-only',
    '--navigation-details',
    '--object-interfaces',
    '--output-contracts',
    '--strict'
]);

async function main() {
    const { args, explicitRoots } = readArguments(process.argv.slice(2));
    const defaultMode = explicitRoots.length === 0;
    const requestedRoots = defaultMode
        ? [path.resolve(process.cwd(), 'apps'), path.resolve(process.cwd(), 'packages')]
        : explicitRoots;

    if (args.has('--strict')) {
        console.error(
            'repo-style-check failed: strict mode is not available until warning debt is reviewed.'
        );
        process.exitCode = 1;
        return;
    }

    const scanRoots = await resolveScanRoots(requestedRoots);
    if (scanRoots.length === 0) {
        console.error('repo-style-check failed: no valid scan roots found.');
        process.exitCode = 1;
        return;
    }

    if (defaultMode) {
        console.warn(
            'repo-style-check: INFO - default run is intentionally narrowed to apps/ + packages/.'
        );
        console.warn(
            'repo-style-check: INFO - use --root . when reviewing production support code too.'
        );
    }

    if (args.has('--navigation-details')) {
        if (args.size > 1) {
            throw new Error('--navigation-details is a dedicated report mode.');
        }
        const sources = await collectProductionSources(scanRoots);
        const result = scanNavigationProject({
            repoRoot: path.resolve(process.cwd()),
            sources,
            scanRoots
        });
        console.log(
            formatNavigationReport(result, {
                scanRoots,
                maximumDetails: maxDisplayedFindingCount
            })
        );
        process.exitCode = 0;
        return;
    }

    const options = {
        layoutOnly: args.has('--layout-only'),
        layoutDetails: args.has('--layout-details'),
        constructionDetails: args.has('--construction-details'),
        outputContracts: args.has('--output-contracts'),
        objectInterfaces: args.has('--object-interfaces'),
        cognitiveMetrics: args.has('--cognitive-metrics')
    };
    // Tests are in scope for the standard's universal rules, so the warning-only full scan reports
    // them. Which of those rules block a branch is decided separately, in the changed-range gate.
    const sources = await collectProductionSources(scanRoots, { includeTests: true });
    const result = scanProductionSources({
        repoRoot: path.resolve(process.cwd()),
        sources,
        options
    });

    printFindings({
        ...result,
        scanRoots,
        activeLayoutRuleIds: activeLayoutRuleIds(options.layoutDetails)
    });
    process.exitCode = 0;
}

function readArguments(argv) {
    const args = new Set();
    const roots = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--root') {
            const root = argv[index + 1];
            if (root === undefined || root.startsWith('--')) {
                throw new Error('--root requires a path.');
            }
            roots.push(path.resolve(root));
            index += 1;
            continue;
        }
        if (!supportedFlags.has(argument)) {
            throw new Error(`unknown argument: ${argument}`);
        }
        args.add(argument);
    }
    return { args, explicitRoots: roots };
}

function printFindings(input) {
    if (input.findings.length === 0) {
        console.log('repo-style-check: PASS (no issues found in this run)');
    }
    else {
        console.log('repo-style-check: WARN');
        for (const finding of input.findings.slice(0, maxDisplayedFindingCount)) {
            const rulePrefix = finding.ruleId === undefined ? '' : `[${finding.ruleId}] `;
            console.log(`${finding.kind.toUpperCase()}: ${finding.file}`);
            console.log(`  - ${rulePrefix}${finding.message}`);
        }
        if (input.findings.length > maxDisplayedFindingCount) {
            console.log(
                `\n${input.findings.length - maxDisplayedFindingCount} additional findings ` +
                    'not displayed. Use --root with a narrower path for a reviewable result.'
            );
        }
        console.log(
            `\nSummary: ${input.findings.length} non-blocking issues found in ` +
                `${input.scanRoots.join(', ')}.`
        );
    }

    console.log(
        'Layout summary: ' +
            input.activeLayoutRuleIds
                .map((ruleId) => `${ruleId}=${input.layoutCounts[ruleId]}`)
                .join(', ')
    );
}

main().catch((error) => {
    console.error('repo-style-check failed:', error);
    process.exitCode = 1;
});
