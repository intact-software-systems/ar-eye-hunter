import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GROUP_ACTIVATION_CONDITIONS } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { GROUP_POLICY_REASON_CODES } from '@shared/api/group-policy-types.ts';

const repoRoot = process.cwd();

const GROUP_DOCS = [
    'docs/rallar-group-formation-architecture.md',
    'docs/rallar-group-lifecycle-cutover-runbook.md',
    'docs/rallar-api-reference.md',
    'docs/rallar-quickstart-and-recipes.md'
] as const;

describe('Rallar group documentation compatibility', () => {
    it.each(GROUP_DOCS)('cites only repository paths that exist: %s', (relativePath) => {
        const missing = toCitedRepositoryPaths(readRepo(relativePath))
            .filter((cited) => !existsSync(path.join(repoRoot, cited)));

        expect(missing).toEqual([]);
    });

    it('publishes exactly the policy reason codes the const declares', () => {
        const section = toReasonCodeSection(readRepo('docs/rallar-api-reference.md'));

        expect(toBacktickedKebabTokens(section).sort())
            .toEqual([...GROUP_POLICY_REASON_CODES].sort());
    });

    it('names every lifecycle stage in the architecture document', () => {
        const architecture = readRepo('docs/rallar-group-formation-architecture.md');
        const unnamed = GROUP_LIFECYCLE_STATES.filter((state) => !architecture.includes(state));

        expect(unnamed).toEqual([]);
    });

    it('names every activation condition in the architecture document', () => {
        const architecture = readRepo('docs/rallar-group-formation-architecture.md');
        const unnamed = GROUP_ACTIVATION_CONDITIONS.filter(
            (condition) => !architecture.includes(`\`${condition}\``)
        );

        expect(unnamed).toEqual([]);
    });

    it('keeps the architecture document reachable from its two referrers', () => {
        expect(readRepo('docs/README.md')).toContain('rallar-group-formation-architecture.md');
        expect(readRepo('docs/rallar-rtc-rtt-reporting.md'))
            .toContain('rallar-group-formation-architecture.md');
    });
});

function readRepo(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * Backticked paths under a source root. A rename that leaves a document behind
 * is otherwise invisible: nothing compiles a document, so the stale path stays
 * until a reader follows it.
 */
function toCitedRepositoryPaths(document: string): readonly string[] {
    const sourceRoots = /^(packages|apps|docs|examples|scripts|playground|\.agents)\//;
    return [
        ...new Set(
            [...document.matchAll(/`([^`\s]+)`/g)]
                .map((match) => match[1])
                .filter((token) => sourceRoots.test(token) && /\.[a-z]+$/.test(token))
        )
    ];
}

/**
 * The reason-code paragraphs of the API reference, bounded so unrelated
 * hyphenated vocabulary elsewhere in the document cannot join the comparison.
 */
function toReasonCodeSection(apiReference: string): string {
    const start = apiReference.indexOf('`GROUP_POLICY_REASON_CODES`');
    const end = apiReference.indexOf('REST errors keep', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return apiReference.slice(start, end);
}

function toBacktickedKebabTokens(section: string): readonly string[] {
    return [
        ...new Set(
            [...section.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((match) => match[1])
        )
    ];
}
