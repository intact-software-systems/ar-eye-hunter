import { readFileSync } from 'node:fs';
import path from 'node:path';

export class GovernanceGateConfigurationError extends Error {}

export const governanceGatePhases = [
  { phase: 'adaptive-plan', command: 'check:plan-adaptation' },
  { phase: 'repo-structure', command: 'check:repo-structure' },
  { phase: 'pr-review-v2', command: 'test:pr-human-review' },
  { phase: 'focused-contracts', command: 'test:adaptive-governance' },
];

export function validateGovernanceGateCommands(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new GovernanceGateConfigurationError(
      `cannot read package.json: ${toError(error).message}`,
    );
  }
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  for (const { phase, command } of governanceGatePhases) {
    if (typeof scripts[command] !== 'string' || scripts[command].trim() === '') {
      throw new GovernanceGateConfigurationError(`${phase}: missing package script ${command}`);
    }
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
