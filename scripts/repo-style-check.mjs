#!/usr/bin/env node
import path from 'node:path';

import {
  activeLayoutRuleIds,
  collectProductionSources,
  resolveScanRoots,
  scanProductionSources,
} from './repo-style-check/repository-scan.mjs';

const args = new Set(process.argv.slice(2));
const explicitRoots = readExplicitRoots(process.argv);
const defaultMode = explicitRoots.length === 0;
const requestedRoots = defaultMode
  ? [path.resolve(process.cwd(), 'apps'), path.resolve(process.cwd(), 'packages')]
  : explicitRoots;
const maxDisplayedFindingCount = 200;

async function main() {
  if (args.has('--strict')) {
    console.error(
      'repo-style-check failed: strict mode is not available until warning debt is reviewed.',
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
      'repo-style-check: INFO - default run is intentionally narrowed to apps/ + packages/.',
    );
    console.warn(
      'repo-style-check: INFO - use --root . when reviewing production support code too.',
    );
  }

  const options = {
    layoutOnly: args.has('--layout-only'),
    layoutDetails: args.has('--layout-details'),
    constructionDetails: args.has('--construction-details'),
    outputContracts: args.has('--output-contracts'),
    objectInterfaces: args.has('--object-interfaces'),
    cognitiveMetrics: args.has('--cognitive-metrics'),
  };
  const sources = await collectProductionSources(scanRoots);
  const result = scanProductionSources({
    repoRoot: path.resolve(process.cwd()),
    sources,
    options,
  });

  printFindings({
    ...result,
    scanRoots,
    activeLayoutRuleIds: activeLayoutRuleIds(options.layoutDetails),
  });
  process.exitCode = 0;
}

function readExplicitRoots(argv) {
  const roots = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === '--root') {
      roots.push(path.resolve(argv[index + 1]));
    }
  }
  return roots;
}

function printFindings(input) {
  if (input.findings.length === 0) {
    console.log('repo-style-check: PASS (no issues found in this run)');
  } else {
    console.log('repo-style-check: WARN');
    for (const finding of input.findings.slice(0, maxDisplayedFindingCount)) {
      const rulePrefix = finding.ruleId === undefined ? '' : `[${finding.ruleId}] `;
      console.log(`${finding.kind.toUpperCase()}: ${finding.file}`);
      console.log(`  - ${rulePrefix}${finding.message}`);
    }
    if (input.findings.length > maxDisplayedFindingCount) {
      console.log(
        `\n${input.findings.length - maxDisplayedFindingCount} additional findings ` +
          'not displayed. Use --root with a narrower path for a reviewable result.',
      );
    }
    console.log(
      `\nSummary: ${input.findings.length} non-blocking issues found in ` +
        `${input.scanRoots.join(', ')}.`,
    );
  }

  console.log(
    'Layout summary: ' +
      input.activeLayoutRuleIds
        .map((ruleId) => `${ruleId}=${input.layoutCounts[ruleId]}`)
        .join(', '),
  );
}

main().catch((error) => {
  console.error('repo-style-check failed:', error);
  process.exitCode = 1;
});
