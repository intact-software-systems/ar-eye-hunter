import { readFileSync } from 'node:fs';
import path from 'node:path';

export class GovernanceGateConfigurationError extends Error {}

export const governanceGatePhases = [
    { phase: 'repo-structure', command: 'check:repo-structure' },
    { phase: 'repo-style', command: 'check:repo-style' },
    {
        phase: 'retained-legacy',
        command: 'check:retained-legacy',
        showSuccessfulOutput: true
    }
];

const forbiddenScriptPatterns = [
    { pattern: /(?:^|\/)plan-adaptation(?:[/.\s]|$)/u, reason: 'retired plan tooling' },
    { pattern: /(?:^|\/)pr-human-review(?:[/.\s]|$)/u, reason: 'retired PR evidence tooling' },
    { pattern: /(?:^|\s)governance:decide(?:\s|$)/u, reason: 'governance mutation' },
    { pattern: /(?:^|[;&|\s])(?:gh|curl|wget)(?:\s|$)/u, reason: 'network access' },
    { pattern: /https?:\/\//u, reason: 'network access' },
    { pattern: /(?:^|\s)--output(?:=|\s)/u, reason: 'mutable output path' },
    { pattern: /(?:^|\s)(?:>>?|tee)(?:\s|$)/u, reason: 'mutable output path' },
    {
        pattern: /(?:^|\s)git\s+(?:add|commit|push|merge|rebase|reset)(?:\s|$)/u,
        reason: 'Git mutation'
    }
];

export function validateGovernanceGateCommands(repoRoot, phases = governanceGatePhases) {
    const packagePath = path.join(repoRoot, 'package.json');
    let packageJson;
    try {
        packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    }
    catch (error) {
        throw new GovernanceGateConfigurationError(
            `cannot read package.json: ${toError(error).message}`
        );
    }
    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    for (const { phase, command } of phases) {
        if (command.startsWith('test:')) {
            throw new GovernanceGateConfigurationError(`${phase}: test commands are not policy checks`);
        }
        if (!command.startsWith('check:')) {
            throw new GovernanceGateConfigurationError(
                `${phase}: package command must use the check: namespace`
            );
        }
        if (typeof scripts[command] !== 'string' || scripts[command].trim() === '') {
            throw new GovernanceGateConfigurationError(`${phase}: missing package script ${command}`);
        }
        for (const forbidden of forbiddenScriptPatterns) {
            if (forbidden.pattern.test(scripts[command])) {
                throw new GovernanceGateConfigurationError(
                    `${phase}: package script ${command} contains ${forbidden.reason}`
                );
            }
        }
    }
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
