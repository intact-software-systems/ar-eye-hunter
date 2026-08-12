import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const exceptionRegistryPath = 'docs/repo-structure-exceptions.json';
const humanEvidencePattern =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+#pullrequestreview-\d+$/u;

export function readStructureExceptions(repoRoot) {
  const absolutePath = path.join(repoRoot, exceptionRegistryPath);
  if (!existsSync(absolutePath)) {
    return { exceptions: [], issues: [] };
  }
  let registry;
  try {
    registry = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    return {
      exceptions: [],
      issues: [`${exceptionRegistryPath} contains invalid JSON: ${toError(error).message}`],
    };
  }
  if (registry?.version !== 1 || !Array.isArray(registry.exceptions)) {
    return {
      exceptions: [],
      issues: [`${exceptionRegistryPath} must contain version 1 and an exceptions array`],
    };
  }
  const exceptions = [];
  const issues = [];
  for (const [index, exception] of registry.exceptions.entries()) {
    const name = `${exceptionRegistryPath} exceptions[${index}]`;
    const exceptionIssues = validateException(exception, name);
    issues.push(...exceptionIssues);
    if (exceptionIssues.length === 0) {
      exceptions.push(exception);
    }
  }
  return { exceptions, issues };
}

function validateException(exception, name) {
  const issues = [];
  if (exception?.ruleId !== 'topology.singleton-subtree') {
    issues.push(`${name}.ruleId must be topology.singleton-subtree`);
  }
  for (const field of ['target', 'owner', 'reviewOrRemovalCondition']) {
    if (typeof exception?.[field] !== 'string' || exception[field].trim() === '') {
      issues.push(`${name}.${field} must be a non-empty string`);
    }
  }
  const approval = exception?.approval;
  if (
    approval?.kind !== 'human' ||
    typeof approval.approvedBy !== 'string' ||
    approval.approvedBy.trim() === '' ||
    /(?:^|\W)(?:agent|ai|bot|codex)(?:\W|$)/iu.test(approval.approvedBy) ||
    typeof approval.approvedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(approval.approvedAt) ||
    typeof approval.evidence !== 'string' ||
    !humanEvidencePattern.test(approval.evidence)
  ) {
    issues.push(
      `${name}.approval must record a named human, date, and direct approval or PR review ` +
        'evidence; plans, agents, and issues are not approval',
    );
  }
  return issues;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
