#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));

export function validateEvaluationResult(input) {
  const issues = [];
  if (!isRecord(input.result)) {
    return ['result must be a JSON object'];
  }
  validateRunFields(issues, input);
  const expectedScenarios = selectedScenarios(input.suite, input.result.primarySkill);
  const scenarioResults = Array.isArray(input.result.scenarioResults)
    ? input.result.scenarioResults
    : [];
  if (!Array.isArray(input.result.scenarioResults)) {
    issues.push('result.scenarioResults must be an array');
  }
  const scenarioOutcomes = validateScenarioResults(issues, {
    ...input,
    expectedScenarios,
    scenarioResults,
  });
  validateSummary(issues, input.result.summary, expectedScenarios, scenarioOutcomes);
  return issues;
}

function validateRunFields(issues, input) {
  const { result, rubric, suite } = input;
  const contract = isRecord(rubric.resultContract) ? rubric.resultContract : {};
  if (result.schemaVersion !== contract.schemaVersion) {
    issues.push(`result.schemaVersion must be ${contract.schemaVersion}`);
  }
  validateNonEmptyText(issues, result.runId, 'result.runId');
  if (result.suiteId !== suite.suiteId || result.suiteId !== rubric.suiteId) {
    issues.push(`result.suiteId must be ${suite.suiteId}`);
  }
  validateNonEmptyText(issues, result.primarySkill, 'result.primarySkill');
  if (selectedScenarios(suite, result.primarySkill).length === 0) {
    issues.push('result.primarySkill does not select any evaluation scenarios');
  }
  const variants = Array.isArray(contract.skillVariants) ? contract.skillVariants : [];
  if (!variants.includes(result.skillVariant)) {
    issues.push(`result.skillVariant must be ${variants.join(' or ')}`);
  }
  validateNonEmptyText(issues, result.model, 'result.model');
  const startedAt = validateTimestamp(issues, result.startedAt, 'result.startedAt');
  const completedAt = validateTimestamp(issues, result.completedAt, 'result.completedAt');
  if (startedAt !== null && completedAt !== null && completedAt < startedAt) {
    issues.push('result.completedAt must not precede result.startedAt');
  }
}

function validateScenarioResults(issues, input) {
  const expectedById = new Map(input.expectedScenarios.map((scenario) => [scenario.id, scenario]));
  const resultCountById = countIds(input.scenarioResults, 'scenarioId');
  for (const [scenarioId, count] of resultCountById) {
    if (count > 1) {
      issues.push(`result.scenarioResults contains duplicate scenario ${scenarioId}`);
    }
    if (!expectedById.has(scenarioId)) {
      issues.push(`result.scenarioResults contains unknown scenario ${scenarioId}`);
    }
  }
  for (const scenario of input.expectedScenarios) {
    if (!resultCountById.has(scenario.id)) {
      issues.push(`result.scenarioResults is missing scenario ${scenario.id}`);
    }
  }

  const outcomes = new Map();
  for (const scenarioResult of input.scenarioResults) {
    if (!isRecord(scenarioResult) || !expectedById.has(scenarioResult.scenarioId)) {
      continue;
    }
    const scenario = expectedById.get(scenarioResult.scenarioId);
    const outcome = validateScenarioResult(issues, input, scenario, scenarioResult);
    if (!outcomes.has(scenario.id)) {
      outcomes.set(scenario.id, outcome);
    }
  }
  return outcomes;
}

function validateScenarioResult(issues, input, scenario, result) {
  const prefix = scenario.id;
  const verdicts = resultVerdicts(input.rubric);
  const dimensionResults = Array.isArray(result.dimensionResults) ? result.dimensionResults : [];
  if (!Array.isArray(result.dimensionResults)) {
    issues.push(`${prefix} dimensionResults must be an array`);
  }
  const failedDimensions = validateDimensionResults(issues, {
    rubric: input.rubric,
    scenario,
    dimensionResults,
  });
  const computedVerdict = failedDimensions.length === 0 ? 'pass' : 'fail';
  if (!verdicts.includes(result.verdict)) {
    issues.push(`${prefix} verdict must be ${verdicts.join(' or ')}`);
  } else if (result.verdict !== computedVerdict) {
    issues.push(`${prefix} verdict must be ${computedVerdict} when a required dimension fails`);
  }
  validateCriticalFailures(issues, scenario, result.criticalFailures, failedDimensions);
  validateRawArtifact(issues, input, prefix, result.rawOutputArtifact);
  return { computedVerdict };
}

function validateDimensionResults(issues, input) {
  const required = new Set(input.scenario.requiredDimensions);
  const known = new Set(
    Array.isArray(input.rubric.dimensions)
      ? input.rubric.dimensions.map((dimension) => dimension.id)
      : [],
  );
  const counts = countIds(input.dimensionResults, 'dimensionId');
  for (const [dimensionId, count] of counts) {
    if (count > 1) {
      issues.push(
        `${input.scenario.id} dimensionResults contains duplicate dimension ${dimensionId}`,
      );
    }
    if (!known.has(dimensionId) || !required.has(dimensionId)) {
      issues.push(
        `${input.scenario.id} dimensionResults contains unknown dimension ${dimensionId}`,
      );
    }
  }
  for (const dimensionId of required) {
    if (!counts.has(dimensionId)) {
      issues.push(`${input.scenario.id} dimensionResults is missing dimension ${dimensionId}`);
    }
  }

  const failed = [];
  const verdicts = resultVerdicts(input.rubric);
  for (const dimensionResult of input.dimensionResults) {
    if (!isRecord(dimensionResult) || !required.has(dimensionResult.dimensionId)) {
      continue;
    }
    const prefix = `${input.scenario.id} ${dimensionResult.dimensionId}`;
    if (!verdicts.includes(dimensionResult.verdict)) {
      issues.push(`${prefix} verdict must be ${verdicts.join(' or ')}`);
      failed.push(dimensionResult.dimensionId);
    } else if (dimensionResult.verdict === 'fail') {
      failed.push(dimensionResult.dimensionId);
    }
    validateNonEmptyText(issues, dimensionResult.evidence, `${prefix} evidence`);
    validateNonEmptyText(issues, dimensionResult.reason, `${prefix} reason`);
  }
  return [...new Set(failed)].sort();
}

function validateCriticalFailures(issues, scenario, value, failedDimensions) {
  const actual = Array.isArray(value) ? value : [];
  if (!Array.isArray(value) || actual.some((entry) => typeof entry !== 'string')) {
    issues.push(`${scenario.id} criticalFailures must be an array of dimension IDs`);
    return;
  }
  const expected = scenario.critical ? failedDimensions : [];
  if (!sameSortedStrings(actual, expected)) {
    issues.push(`${scenario.id} criticalFailures must exactly list failed required dimensions`);
  }
}

function validateRawArtifact(issues, input, scenarioId, repositoryPath) {
  if (!isSafeRepositoryPath(repositoryPath)) {
    issues.push(`${scenarioId} rawOutputArtifact must be a safe repository-relative path`);
    return;
  }
  try {
    const readArtifact = input.readArtifact ?? ((filePath) => readFileSync(filePath, 'utf8'));
    const text = readArtifact(path.join(input.repoRoot, repositoryPath));
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('empty artifact');
    }
  } catch {
    issues.push(`${scenarioId} rawOutputArtifact cannot be read as non-empty text`);
  }
}

function validateSummary(issues, summary, expectedScenarios, outcomes) {
  if (!isRecord(summary)) {
    issues.push('result.summary must be an object');
    return;
  }
  const passed = expectedScenarios.filter(
    (scenario) => outcomes.get(scenario.id)?.computedVerdict === 'pass',
  ).length;
  const critical = expectedScenarios.filter((scenario) => scenario.critical);
  const criticalPassed = critical.filter(
    (scenario) => outcomes.get(scenario.id)?.computedVerdict === 'pass',
  ).length;
  validateSummaryValue(issues, summary.total, expectedScenarios.length, 'total');
  validateSummaryValue(issues, summary.passed, passed, 'passed');
  validateSummaryValue(issues, summary.criticalTotal, critical.length, 'criticalTotal');
  validateSummaryValue(issues, summary.criticalPassed, criticalPassed, 'criticalPassed');
}

function validateSummaryValue(issues, actual, expected, field) {
  if (!Number.isInteger(actual) || actual !== expected) {
    issues.push(`result.summary.${field} must equal ${expected}`);
  }
}

function validateNonEmptyText(issues, value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${field} must be non-empty text`);
  }
}

function validateTimestamp(issues, value, field) {
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Date.parse(value))) {
    issues.push(`${field} must be an ISO-8601 timestamp`);
    return null;
  }
  return Date.parse(value);
}

function selectedScenarios(suite, primarySkill) {
  return Array.isArray(suite.scenarios)
    ? suite.scenarios.filter((scenario) => scenario.primarySkill === primarySkill)
    : [];
}

function resultVerdicts(rubric) {
  return Array.isArray(rubric.resultContract?.verdicts)
    ? rubric.resultContract.verdicts
    : ['pass', 'fail'];
}

function countIds(values, field) {
  const counts = new Map();
  for (const value of values) {
    const id = isRecord(value) ? value[field] : undefined;
    if (typeof id === 'string' && id !== '') {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

function sameSortedStrings(left, right) {
  if (new Set(left).size !== left.length || left.length !== right.length) {
    return false;
  }
  return [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function isSafeRepositoryPath(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !path.isAbsolute(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runCli() {
  const resultPath = process.argv[2];
  if (typeof resultPath !== 'string' || process.argv.length !== 3) {
    console.log('FAIL: expected one evaluation result JSON path');
    process.exitCode = 1;
    return;
  }
  try {
    const input = {
      repoRoot: process.cwd(),
      suite: readJson(path.join(evaluationRoot, 'scenarios.json')),
      rubric: readJson(path.join(evaluationRoot, 'rubric.json')),
      result: readJson(path.resolve(resultPath)),
    };
    const issues = validateEvaluationResult(input);
    if (issues.length > 0) {
      for (const issue of issues) {
        console.log(`FAIL: ${issue}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`PASS: adaptive agent evaluation result ${resultPath}`);
  } catch (error) {
    console.log(`FAIL: ${toError(error).message}`);
    process.exitCode = 1;
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
