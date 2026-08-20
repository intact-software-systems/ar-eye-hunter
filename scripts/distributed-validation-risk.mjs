#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import path from 'node:path';

import { classifyDistributedValidationRisk } from './distributed-validation-risk/distributed-validation-risk.mjs';
import { validateDistributedValidationResult } from './distributed-validation-risk/distributed-validation-result.mjs';
import { readChangedPathRecords } from './distributed-validation-risk/read-distributed-validation-input.mjs';

await runDistributedValidationRiskCommand(process.argv.slice(2));

export async function runDistributedValidationRiskCommand(args) {
  try {
    const command = args.shift();
    const options = readOptions(args);
    if (command === 'select') {
      runSelection(options);
      return;
    }
    if (command === 'conclude') {
      runConclusion(options);
      return;
    }
    throw new Error('usage: distributed-validation-risk <select|conclude> <options>');
  } catch (error) {
    console.error(`FAIL: distributed validation risk: ${toError(error).message}`);
    process.exitCode = 1;
  }
}

function runSelection(options) {
  const eventName = requiredOption(options, '--event-name');
  const outputPath = requiredOption(options, '--output');
  let result;
  if (eventName === 'workflow_dispatch') {
    result = classifyDistributedValidationRisk({
      eventName,
      changedPathRecords: [],
    });
  } else {
    const repoRoot = path.resolve(requiredOption(options, '--repo-root'));
    const changedPaths = readChangedPathRecords(
      repoRoot,
      requiredOption(options, '--base'),
      requiredOption(options, '--head'),
    );
    result = classifyDistributedValidationRisk({
      eventName,
      changedPathRecords: changedPaths.records,
      changedPathIssues: changedPaths.issues,
    });
  }

  appendFileSync(outputPath, `${toOutput(result)}\n`, 'utf8');
  const status = result.selected ? 'SELECTED' : 'SKIPPED';
  const reason = result.reason.replace(/^Distributed validation (?:selected|not selected): /u, '');
  console.log(`${status}: ${reason}`);
}

function runConclusion(options) {
  const issues = validateDistributedValidationResult({
    selected: requiredOption(options, '--selected'),
    selectionResult: requiredOption(options, '--selection-result'),
    preflightResult: requiredOption(options, '--preflight-result'),
    prepareResult: requiredOption(options, '--prepare-result'),
    runResult: requiredOption(options, '--run-result'),
  });
  if (issues.length > 0) {
    throw new Error(issues.join('; '));
  }
  console.log('PASS: Run Hetzner Supported Distributed Manifests result');
}

function toOutput(result) {
  return [
    `selected=${String(result.selected)}`,
    `reason_code=${result.reasonCode}`,
    `reason=${result.reason}`,
    `risk_families_json=${JSON.stringify(result.riskFamilies)}`,
    `risk_paths_json=${JSON.stringify(result.riskPaths)}`,
  ].join('\n');
}

function readOptions(args) {
  if (args.length % 2 !== 0) {
    throw new Error('every option must have one value');
  }
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name.startsWith('--') || options.has(name)) {
      throw new Error(`invalid option: ${name}`);
    }
    options.set(name, args[index + 1]);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (value === undefined) {
    throw new Error(`missing required option: ${name}`);
  }
  return value;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
