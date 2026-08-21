import { spawn } from 'node:child_process';

import { governanceGatePhases, validateGovernanceGateCommands } from './governance-gate-phases.mjs';

const maximumFailureOutputCharacters = 8_000;
const maximumSuccessfulOutputCharacters = 32_000;

export async function runGovernanceGate(repoRoot) {
    validateGovernanceGateCommands(repoRoot);
    return Promise.all(
        governanceGatePhases.map((descriptor) => runPackageCommand(repoRoot, descriptor))
    );
}

function runPackageCommand(repoRoot, descriptor) {
    return new Promise((resolve) => {
        const { phase, command, showSuccessfulOutput = false } = descriptor;
        const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const child = spawn(npmCommand, ['run', '--silent', command], {
            cwd: repoRoot,
            env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let failureOutput = '';
        let successfulOutput = { output: '', truncated: false };
        const captureOutput = (chunk) => {
            failureOutput = appendFailureOutput(failureOutput, chunk);
            if (showSuccessfulOutput) {
                successfulOutput = appendSuccessfulOutput(successfulOutput, chunk);
            }
        };
        child.stdout.on('data', captureOutput);
        child.stderr.on('data', captureOutput);
        child.on('error', (error) => {
            resolve({ phase, command, status: 1, output: toError(error).message });
        });
        child.on('close', (status, signal) => {
            resolve({
                phase,
                command,
                status: status ?? 1,
                output: status === 0
                    ? toSuccessfulSummary(successfulOutput, command)
                    : toFailureSummary(failureOutput, signal)
            });
        });
    });
}

function appendFailureOutput(current, chunk) {
    return `${current}${String(chunk)}`.slice(-maximumFailureOutputCharacters);
}

function appendSuccessfulOutput(current, chunk) {
    const combined = `${current.output}${String(chunk)}`;
    return {
        output: combined.slice(0, maximumSuccessfulOutputCharacters),
        truncated: current.truncated || combined.length > maximumSuccessfulOutputCharacters
    };
}

function toSuccessfulSummary(successfulOutput, command) {
    const output = successfulOutput.output.trim();
    if (!successfulOutput.truncated) {
        return output;
    }
    const message = 'TRUNCATED: successful advisory output exceeded 32,000 characters; ' +
        `run npm run ${command} for the complete report.`;
    const maximumOutputBeforeMessage = maximumSuccessfulOutputCharacters - message.length - (output === '' ? 0 : 1);
    const boundedOutput = output.slice(0, maximumOutputBeforeMessage).trimEnd();
    return boundedOutput === '' ? message : `${boundedOutput}\n${message}`;
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
