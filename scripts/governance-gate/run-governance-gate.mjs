import { spawn } from 'node:child_process';

import { governanceGatePhases, validateGovernanceGateCommands } from './governance-gate-phases.mjs';

const maximumFailureOutputCharacters = 8_000;

export async function runGovernanceGate(repoRoot) {
  validateGovernanceGateCommands(repoRoot);
  return Promise.all(
    governanceGatePhases.map(({ phase, command }) => runPackageCommand(repoRoot, phase, command)),
  );
}

function runPackageCommand(repoRoot, phase, command) {
  return new Promise((resolve) => {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCommand, ['run', '--silent', command], {
      cwd: repoRoot,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output = appendFailureOutput(output, chunk);
    });
    child.stderr.on('data', (chunk) => {
      output = appendFailureOutput(output, chunk);
    });
    child.on('error', (error) => {
      resolve({ phase, command, status: 1, output: toError(error).message });
    });
    child.on('close', (status, signal) => {
      resolve({
        phase,
        command,
        status: status ?? 1,
        output: status === 0 ? '' : toFailureSummary(output, signal),
      });
    });
  });
}

function appendFailureOutput(current, chunk) {
  return `${current}${String(chunk)}`.slice(-maximumFailureOutputCharacters);
}

function toFailureSummary(output, signal) {
  const lines = output
    .replaceAll(/\u001b\[[0-9;]*m/gu, '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-20);
  if (signal !== null) {
    lines.push(`terminated by ${signal}`);
  }
  return lines.join('\n');
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
