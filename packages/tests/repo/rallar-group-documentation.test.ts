import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const ARCHITECTURE_DOC = 'docs/rallar-group-formation-architecture.md';
const PRODUCT_PLAN = 'playground/rtc-design/2026-08-22-group-activation-product-plan.md';

/**
 * The tracked paths, which are the comparison basis rather than `existsSync`
 * for two reasons: a case-only mistake passes on a case-insensitive macOS
 * filesystem and fails on Linux CI, and a bare filename citation has no path
 * to stat at all.
 */
const trackedPaths = readTrackedPaths();
const trackedBasenames = new Set(trackedPaths.map((tracked) => path.basename(tracked)));

describe('Rallar group documentation', () => {
    it.each(GROUP_DOCS)('cites only files and directories that exist: %s', (relativePath) => {
        const unresolved = toCitations(readRepositoryFile(relativePath))
            .filter((citation) => !isResolvedCitation(citation));

        expect(unresolved).toEqual([]);
    });

    it('publishes exactly the policy reason codes the const declares', () => {
        const apiReference = readRepositoryFile('docs/rallar-api-reference.md');
        const start = apiReference.indexOf('`GROUP_POLICY_REASON_CODES`');
        const end = apiReference.indexOf('REST errors keep', start);

        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect([...toBacktickedKebabTokens(apiReference.slice(start, end))].sort())
            .toEqual([...GROUP_POLICY_REASON_CODES].sort());
    });

    it('names every lifecycle stage in the architecture document', () => {
        const architecture = readRepositoryFile(ARCHITECTURE_DOC);

        expect(GROUP_LIFECYCLE_STATES.filter((state) => !architecture.includes(state))).toEqual([]);
    });

    it('names every activation condition in the architecture document', () => {
        const architecture = readRepositoryFile(ARCHITECTURE_DOC);
        const unnamed = GROUP_ACTIVATION_CONDITIONS.filter(
            (condition) => !architecture.includes(`\`${condition}\``)
        );

        expect(unnamed).toEqual([]);
    });

    it('accounts for every acceptance scenario the product plan names', () => {
        const planned = toScenarioIds(readRepositoryFile(PRODUCT_PLAN), 'Named acceptance scenarios:');
        const documented = toScenarioIds(readRepositoryFile(ARCHITECTURE_DOC), '### Acceptance scenarios');

        expect(planned).toHaveLength(26);
        expect([...documented].sort()).toEqual([...planned].sort());
    });

    /**
     * The prose beside the table states how many scenarios are unpinned. It is
     * the sentence a reader trusts instead of counting rows, so it is the one
     * that goes stale first.
     */
    it('states an unpinned count the table agrees with', () => {
        const architecture = readRepositoryFile(ARCHITECTURE_DOC);
        const table = toSection(architecture, '### Acceptance scenarios');
        const unpinned = [...table.matchAll(/^\| `[a-z-]+`\s*\| unpinned/gm)].length;
        const stated = table.match(/\*\*(\d+) scenarios are unpinned\*\*/)?.[1];

        expect(stated).toBe(String(unpinned));
    });

    it('keeps the architecture document reachable from every document that cites it', () => {
        const referrers = trackedPaths
            .filter((tracked) => tracked.startsWith('docs/') && tracked !== ARCHITECTURE_DOC)
            .filter((tracked) => readRepositoryFile(tracked).includes(path.basename(ARCHITECTURE_DOC)));

        expect(referrers).toEqual(expect.arrayContaining([
            'docs/README.md',
            'docs/rallar-rtc-rtt-reporting.md',
            'docs/rallar-group-lifecycle-cutover-runbook.md'
        ]));
    });
});

function readRepositoryFile(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readTrackedPaths(): readonly string[] {
    return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n')
        .filter(Boolean);
}

const SOURCE_ROOTS = /^(packages|apps|docs|examples|scripts|playground|\.agents|\.github)\//;
const SOURCE_FILENAME = /^[A-Za-z0-9_.-]+\.(ts|mts|tsx|js|mjs|cjs|json|yaml|yml|md|sh|prisma|sql|html|css)$/;

/**
 * Backticked citations of a file or directory. Three shapes appear in these
 * documents and all three go stale on a rename: a full path, a path with a
 * trailing slash naming a directory, and a bare filename used once the
 * surrounding prose has established the directory.
 */
function toCitations(document: string): readonly string[] {
    return [
        ...new Set(
            [...document.matchAll(/`([^`\s]+)`/g)]
                .map((match) => match[1])
                .filter((token) =>
                    (SOURCE_ROOTS.test(token) && (token.endsWith('/') || SOURCE_FILENAME.test(path.basename(token)))) ||
                    (!token.includes('/') && SOURCE_FILENAME.test(token))
                )
        )
    ];
}

function isResolvedCitation(citation: string): boolean {
    if (citation.endsWith('/')) {
        return trackedPaths.some((tracked) => tracked.startsWith(citation));
    }
    return citation.includes('/')
        ? trackedPaths.includes(citation)
        : trackedBasenames.has(citation);
}

function toBacktickedKebabTokens(section: string): readonly string[] {
    return [...new Set([...section.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((match) => match[1]))];
}

function toSection(document: string, heading: string): string {
    const start = document.indexOf(heading);
    return start === -1 ? '' : document.slice(start, document.indexOf('\n## ', start));
}

/** The first-column ids of the scenario table that follows `heading`. */
function toScenarioIds(document: string, heading: string): readonly string[] {
    return [...toSection(document, heading).matchAll(/^\| `([a-z-]+)`\s*\|/gm)].map((match) => match[1]);
}
