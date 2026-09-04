import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Repository-governance maintainers own these publication guards. Replace phrase
// checks as consumer evaluations cover the same drift risk; they do not prove agent behavior.
const repoRoot = process.cwd();
const canonicalServiceWritingPath = '.agents/skills/rallar-code-writing/references/convergent-service-writing.md';
const codeProducingSpecialistSkills = [
    'building-rallar-apps',
    'performance-analysis',
    'rallar-ai',
    'rallar-games',
    'rallar-hetzner-ops',
    'rallar-platform',
    'rallar-realtime'
] as const;
const appInboxGuidanceVocabulary = [
    'AppInbox is mandatory for incoming database mutations',
    'service write receives the transaction',
    'ResourceInboxRepository',
    'APP_OUTBOX',
    'WS_OUTBOX',
    '20 total processing attempts',
    'mandatory fields by default'
] as const;
const currentAppInboxGuidancePaths = [
    canonicalServiceWritingPath,
    'packages/shared-server/README.md',
    'apps/api-v1/README.md',
    'docs/rallar-api-reference.md',
    'docs/rallar-convergent-state-and-rtc-topology.md',
    'docs/rallar-crdt-guide.md',
    'docs/rallar-crdt-production-hardening-runbook.md',
    'docs/README.md'
] as const;
const canonicalSnapshotOrderingGuidancePaths = [
    canonicalServiceWritingPath,
    'docs/rallar-convergent-state-and-rtc-topology.md'
] as const;
const postCommitAudienceGuidancePaths = [
    'apps/api-v1/README.md',
    'packages/shared-server/README.md',
    'docs/rallar-api-reference.md',
    'docs/rallar-convergent-state-and-rtc-topology.md'
] as const;
const repositoryReadGuidancePaths = [
    'apps/api-v1/README.md',
    'docs/README.md',
    'docs/rallar-api-reference.md',
    'docs/rallar-crdt-guide.md',
    'docs/rallar-crdt-production-hardening-runbook.md'
] as const;
const downstreamQueueGuidancePaths = [
    'packages/shared-server/docs/persistence-and-replay.md',
    'docs/rallar-convergent-state-and-rtc-topology.md'
] as const;
const mediumScaleRequirements = [
    'npm run test:api-v1:black-box:postgres:medium-scale',
    '100 independently authenticated clients',
    'five groups',
    'three Postgres-backed API processes',
    '10 client lanes plus 5 control lanes'
] as const;

interface PackageJson {
    readonly scripts?: Readonly<Record<string, string>>;
}

describe('authoritative mutation guidance integrity', () => {
    it('routes composition and validation from the specialist skills', () => {
        const agents = readRepo('AGENTS.md');
        const convergenceArchitecture = readRepo('docs/rallar-convergent-state-and-rtc-topology.md');
        const platform = readRepo('.agents/skills/rallar-platform/SKILL.md');
        const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
        const repoCodeStyle = readRepo(
            '.agents/skills/rallar-code-writing/references/repo-code-style.md'
        );
        const serviceWriting = readRepo(canonicalServiceWritingPath);
        const games = readRepo('.agents/skills/rallar-games/SKILL.md');
        const realtime = readRepo('.agents/skills/rallar-realtime/SKILL.md');
        const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const testCommands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');
        const packageJson = readPackageJson('package.json');

        expect(platform).toContain('building-rallar-apps');
        expect(games).toContain('building-rallar-apps');
        expect(games).toContain('Use the `rallar-testing` skill');
        expect(realtime).toContain('building-rallar-apps');
        expectAll(games, ['message.raw.targets', 'realtime payload', 'roomRef']);
        expectAll(realtime, ['message.raw.targets', 'realtime payload', 'roomRef']);
        expectAll(realtime, [
            'docs/rallar-group-formation-architecture.md',
            'are observation, never',
            'is the `optimistic` preset'
        ]);
        expect(realtime).toMatch(/observation, never\s+authority/);
        expect(platform).toContain('Required fields are the default');
        expect(platform).toMatch(/absence is a meaningful domain\s+state/);
        expect(platform).toMatch(/explicitly ask\s+the human/);
        expectAllNormalized(platform, [
            canonicalServiceWritingPath,
            'Platform-specific decisions remain here',
            'authoritative persisted, replicated, queued, event, snapshot, and response'
        ]);
        expect(platform).not.toContain('optimistic compare-and-set writes with bounded retries');
        expect(platform).not.toContain('Queue locks are coordination-only');
        expect(platform).not.toContain('Strong contracts enable permissive convergence');
        expectAll(codeWriting, [
            'Always read `references/repo-code-style.md`',
            'references/convergent-service-writing.md',
            'Prefer required contracts and explicit value flow',
            'compatibility fallback requires explicit human approval'
        ]);
        expectAllNormalized(serviceWriting, [
            'expected-revision compare-and-set',
            'authorization, policy, capacity, lifecycle, invariants',
            'canonical key, decoded identity, complete mandatory shape',
            'Corrupt authoritative reads fail closed'
        ]);
        const performance = readRepo('.agents/skills/performance-analysis/SKILL.md');
        expectAll(performance, [
            'production receipts',
            'Synthetic post-call evidence cannot',
            'Synthetic prerequisite or non-invocation evidence must link to an earlier same-subject predecessor with real production exhaustion',
            'must not weaken candidate validation'
        ]);
        expectAll(repoCodeStyle, ['discriminated union']);
        expectAllNormalized(serviceWriting, [
            'create with conditional insert or `insertIfAbsent`',
            'update with expected-revision compare-and-set or `upsertIfRevision`',
            'delete or expire with expected-revision conditional delete or `deleteIfRevision`',
            'a stale expiry observation must not delete or overwrite a refreshed value',
            'A conflict exits that attempt; queue redelivery starts again from `read`'
        ]);
        expectAllNormalized(realtime, [
            canonicalServiceWritingPath,
            'Presence summaries are optimistic materialized views, not authority'
        ]);
        expect(realtime).not.toContain('compare-and-set writes with bounded retries');
        expect(realtime).not.toContain('Queue locks are coordination-only');
        expect(realtime).not.toContain('Prefer optimistic reconciliation for replicated state');
        expect(realtime).not.toContain('prove overlapping conflicts, rebasing, retry exhaustion');
        expectAll(agents, [canonicalServiceWritingPath, 'functional core', 'stateful shell']);
        expectAll(convergenceArchitecture, [
            'Implemented Convergent Database Writes',
            'conditional insert',
            'expected-revision compare-and-set',
            'expected-revision conditional delete'
        ]);
        expect(testing).toContain('npm run test:repo-governance');
        expect(testCommands).toContain('npm run test:repo-governance');
        expectAll(packageJson.scripts?.['test:repo-governance'] ?? '', [
            'packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts',
            'packages/tests/repo/rallar-skill-app-examples-integrity.test.ts',
            'packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts',
            'packages/tests/repo/repo-code-style-authority-integrity.test.ts',
            'packages/tests/repo/repo-code-style-checker-integrity.test.ts',
            'packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts',
            'packages/tests/repo/repo-style-check.test.ts',
            'packages/tests/repo/repo-style-layout-rules.test.ts',
            'packages/tests/repo/repo-style-changed-check.test.ts',
            'packages/tests/rallar-black-box/rallar-testing-skill.test.ts'
        ]);
    });

    it('routes TypeScript work through one code-writing skill and one service doctrine', () => {
        const agents = readRepo('AGENTS.md');
        const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
        const serviceWriting = readRepo(canonicalServiceWritingPath);
        const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const testCommands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');

        expect(existsSync(path.join(repoRoot, canonicalServiceWritingPath))).toBe(true);
        expectAllNormalized(agents, [
            canonicalServiceWritingPath,
            'functional core',
            'stateful shell',
            'one coherent business capability'
        ]);
        expectAllNormalized(codeWriting, [
            'Always read `references/repo-code-style.md`',
            'For authoritative database or realtime service mutations, also read',
            '`references/convergent-service-writing.md` completely'
        ]);
        for (const skillName of codeProducingSpecialistSkills) {
            expect(
                readRepo(`.agents/skills/${skillName}/SKILL.md`),
                `${skillName} must route TypeScript work through rallar-code-writing`
            ).toContain('**REQUIRED SUB-SKILL:** Use `rallar-code-writing`');
        }
        for (const source of [testing, testCommands]) {
            expect(source).toContain(canonicalServiceWritingPath);
        }
        expectAllNormalized(serviceWriting, [
            'functional core',
            'explicitly owned stateful shell',
            'one coherent business capability, one ownership boundary, and one reason to change',
            'records timing around each direct phase and around the AppInbox transaction separately',
            'apply',
            'no-op',
            'reject',
            'written',
            'conflict',
            'newer revisions',
            'stale revisions',
            'equal revisions with different canonical content'
        ]);
    });

    it('requires the IDE causal-navigation cold probe for changed mutation control flow', () => {
        const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
        const codeStyle = readRepo('.agents/skills/rallar-code-writing/references/repo-code-style.md');
        const serviceWriting = readRepo(canonicalServiceWritingPath);
        const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const testCommands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');

        expectAllNormalized(codeStyle, [
            'IDE causal navigation',
            'Go to Definition and Find Usages',
            'concrete operation entry',
            'domain or update policy',
            'first conditional write guard',
            'exact durable result',
            'after-commit effect',
            'search escapes',
            'ambiguous pivots',
            'named deferred boundaries',
            'no global call-depth limit',
            'named functions passed to `Either` or pipeline operators'
        ]);
        expectAllNormalized(serviceWriting, [
            '5/5 cold probe',
            'concrete AppInbox registration',
            'first conditional write guard',
            'exact durable result',
            'after-commit effect'
        ]);
        for (const source of [codeWriting, testing, testCommands]) {
            expectAllNormalized(source, [
                'npm run check:repo-style:navigation-details',
                'authoritative mutation control flow',
                '5/5 cold probe'
            ]);
        }
    });

    it('qualifies functional-shell guidance by callable ownership instead of syntax', () => {
        const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
        const codeStyle = readRepo('.agents/skills/rallar-code-writing/references/repo-code-style.md');

        expectAllNormalized(codeWriting, [
            'Functional core, explicit imperative shell, named functional composition where it makes failure flow clearer',
            'A callable collection is not itself an indirection violation',
            'If classification is uncertain, report it; do not mechanically refactor it',
            'new or worsened high-confidence registration-indirection and unnamed-deferred-edge findings'
        ]);
        expectAllNormalized(codeStyle, [
            'Functional core, explicit imperative shell, named functional composition where it makes failure flow clearer',
            'Do not erase a fixed, meaningful operation inventory unless the generic owner contributes semantics that justify doing so',
            'runtime-extensible',
            'declarative data',
            'ordering, scheduling, lifecycle, retry, cleanup, or failure semantics',
            'transparent wrappers',
            'Never auto-fix a callable-inventory finding',
            'Existing high-confidence debt does not block an unrelated change',
            'legitimate boundaries and unknown/manual-review classifications never block'
        ]);
        expect(codeWriting).not.toContain('Disallow erased inventory');
        expect(codeStyle).not.toContain('Disallow erased inventory');
        expect(codeWriting).not.toContain('value or failure flow clearer');
        expect(codeStyle).not.toContain('value or failure flow clearer');
    });

    it.each([
        '.agents/skills/rallar-testing/SKILL.md',
        '.agents/skills/rallar-testing/references/test-commands.md',
        '.agents/skills/performance-analysis/SKILL.md',
        'docs/rallar-convergent-state-and-rtc-topology.md'
    ])('%s preserves the governed three-server medium-scale topology', (filePath) => {
        expectAllNormalized(readRepo(filePath), mediumScaleRequirements);
    });

    it('requires code-derived authoritative mutation traces and canonical realtime owners', () => {
        const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
        const codeStyle = readRepo('.agents/skills/rallar-code-writing/references/repo-code-style.md');
        const serviceWriting = readRepo(canonicalServiceWritingPath);
        const realtime = readRepo('.agents/skills/rallar-realtime/SKILL.md');

        for (const source of [codeWriting, codeStyle, serviceWriting]) {
            expectAllNormalized(source, [
                'family-level code-derived trace',
                'registration from invocation',
                'external or protocol entry',
                'callback registration owner and registration time',
                'runtime invoker and callback invocation count or retry rule',
                'representation translation and read, compute, validate, and write owners',
                'transaction and retry owner and the first conditional guard',
                'receipt, event, exact durable result, and final outbox writes',
                'commit-return point and private after-commit data',
                'after-commit effects, early exits, failures, and cleanup',
                'final caller-visible result and canonical versus compatibility paths',
                'mutable values do not escape a transaction callback'
            ]);
        }

        expectAllNormalized(realtime, [
            'group-state/**',
            'topology/inbox/**',
            'rtc-rtt/inbox/**',
            'websocket/router/**',
            'create-api-v1-system-installers.ts'
        ]);
    });

    it('publishes large work through one semantic PR without a second evidence ledger', () => {
        const progress = readRepo('.agents/skills/publishing-plan-progress/SKILL.md');

        expectAllNormalized(progress, [
            'one semantic pull request',
            'Goal, Changes, Acceptance, Validation, Risk and rollback, and Follow-up',
            'do not add identifiers, computed path lists, progress records, or machine metadata fences',
            'coherent reviewed slices without empty commits or shared governance-file updates',
            'The GitHub pull request is the remote delivery entity',
            'Do not copy workflow run identities or content digests into the branch or PR body as governance inputs'
        ]);
    });

    it('keeps detailed ingress retry policy in the canonical service reference', () => {
        const serviceWriting = readRepo(canonicalServiceWritingPath);
        const routedSkillPaths = [
            'AGENTS.md',
            '.agents/skills/rallar-code-writing/SKILL.md',
            '.agents/skills/rallar-code-writing/references/repo-code-style.md',
            '.agents/skills/rallar-platform/SKILL.md',
            '.agents/skills/rallar-realtime/SKILL.md',
            '.agents/skills/rallar-testing/SKILL.md',
            '.agents/skills/rallar-testing/references/test-commands.md'
        ] as const;

        expect(serviceWriting).toContain('1, 2, 4, 8, and 16 ms');
        for (const filePath of routedSkillPaths) {
            expect(readRepo(filePath), `${filePath} duplicates the retry schedule`).not.toContain(
                '1, 2, 4, 8, and 16 ms'
            );
            expect(readRepo(filePath), `${filePath} must route to the canonical doctrine`).toContain(
                canonicalServiceWritingPath
            );
        }
    });

    it.each(currentAppInboxGuidancePaths)(
        '%s states the current AppInbox transaction doctrine without stale precedent',
        (filePath) => {
            const guidance = normalizeWhitespace(readRepo(filePath));
            expectAllNormalized(guidance, appInboxGuidanceVocabulary);
            for (
                const rejected of [
                    'write opens the transaction',
                    '[0, 2, 8]',
                    'StateMutationOutboxWork',
                    'StateMutationOutboxRepository',
                    'commitTopologyWithRetry'
                ]
            ) {
                expect(guidance, `${filePath}: ${rejected}`).not.toContain(rejected);
            }
            expect(guidance, filePath).not.toMatch(
                /(?:the )?(?:`read`|read),\s*(?:`compute`|compute),\s*and\s*(?:`validate`|validate)\s+phases are pure|pure\s+(?:`read`|read)[,/]\s*(?:`compute`|compute)[,/]\s*(?:and\s*)?(?:`validate`|validate)\s+(?:phases|stages)/i
            );
        }
    );

    it.each(postCommitAudienceGuidancePaths)(
        '%s keeps logical WebSocket audience resolution after commit',
        (filePath) => {
            expect(normalizeWhitespace(readRepo(filePath))).toMatch(
                /logical WebSocket audience resolution .{0,30}(?:only )?after commit/i
            );
        }
    );

    it.each(repositoryReadGuidancePaths)(
        '%s keeps repository reads outside the write transaction',
        (filePath) => {
            expectAllNormalized(readRepo(filePath), [
                'read',
                'loads the repository decision surface outside the write transaction',
                'Only `compute` and `validate` are pure'
            ]);
        }
    );

    it.each(downstreamQueueGuidancePaths)(
        '%s distinguishes downstream QueueBox retries from AppInbox ingress retries',
        (filePath) => {
            expectAllNormalized(readRepo(filePath), [
                'RtcTopologyOutboxWork',
                'ResourceInbox/QueueBox attempt boundary',
                'neither service owns the transaction or retry boundary'
            ]);
        }
    );

    it(
        'the canonical service reference independently states the convergent-write doctrine',
        () => {
            const guidance = normalizeWhitespace(readRepo(canonicalServiceWritingPath));
            expect(guidance).toMatch(
                /`compute` and `validate` .{0,30}(?:phases|functions) are .{0,10}pure/i
            );
            expect(guidance).toMatch(/AppInbox .{0,50}owns .{0,40}transaction .{0,40}retry boundary/i);
            expect(guidance).toMatch(/service write receives the transaction .{0,40}never opens/i);
            expect(guidance).toContain('write(transaction, computed)');
            expect(guidance).toMatch(
                /(?:ResourceInboxRepository.{0,160}same transaction|same transaction.{0,160}ResourceInboxRepository)/i
            );
            expect(guidance).toMatch(/queue locks.{0,80}coordination-only/i);
            expect(guidance).toMatch(/computed persistence data.{0,40}not.{0,20}(?:called )?a plan/i);
            expect(guidance).not.toContain('Migrate ambiguous legacy data');
            expect(guidance).not.toContain('migration shapes use separate types');
        }
    );

    it('keeps the complete transaction-write doctrine in the authoritative code standard', () => {
        const codeStyle = readRepo('.agents/skills/rallar-code-writing/references/repo-code-style.md');
        expectAllNormalized(codeStyle, [
            'same explicit input produces the same result',
            'no repository reads, clocks, randomness, mutable dependency lookups, or hidden side effects',
            'Do not add `prepare`, `prepareWrite`, or another deterministic transformation after `compute`',
            'Adding another service mutation phase requires explicit human approval',
            'One queue delivery performs one mutation attempt',
            'A conflict exits that attempt; queue redelivery starts again from `read`'
        ]);
    });

    it('keeps specialist transaction-write guidance concise and role-specific', () => {
        expectAllNormalized(readRepo(canonicalServiceWritingPath), [
            'authoritative repository code standard',
            'QueueBox redelivery',
            'service write receives the transaction',
            'Specialized ResourceInbox transaction ownership',
            'explicit one-row result or caller-supplied batch limit'
        ]);
        const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
        expectAllNormalized(codeWriting, [
            'persistence-ready',
            'Do not add a post-compute preparation phase.',
            'Do not add another mutation phase without explicit human approval.',
            'Never add an inner retry loop',
            'resolved transaction owner'
        ]);
        expect(codeWriting).not.toContain('checker\'s explicit file inventory');
        expect(readRepo(canonicalServiceWritingPath)).not.toContain(
            'The checker keeps specialized ResourceInbox files'
        );
        expectAllNormalized(readRepo('.agents/skills/rallar-testing/SKILL.md'), [
            'For `strict-domain-write` package or API transaction writes',
            'one mutation attempt',
            'actual database-returned facts',
            'incompatible existing schemas fail closed without a schema rewrite'
        ]);
        expectAllNormalized(readRepo('.agents/skills/performance-analysis/SKILL.md'), [
            'Transaction timing is not value provenance',
            'actual database-returned facts'
        ]);
    });

    it.each(canonicalSnapshotOrderingGuidancePaths)(
        '%s requires canonical ordering for authoritative snapshot collections',
        (filePath) => {
            expectAllNormalized(readRepo(filePath), [
                'Authoritative snapshot collections that represent unordered sets',
                'canonical storage-key order',
                'computed mutation result',
                'durable repository assembly',
                'arrival, insertion, or database/provider iteration order',
                'equal-revision content checks'
            ]);
        }
    );
});

function readRepo(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function readPackageJson(filePath: string): PackageJson {
    return decodePackageJson(JSON.parse(readRepo(filePath)));
}

function decodePackageJson(value: unknown): PackageJson {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Package JSON must be an object');
    }
    if (!('scripts' in value) || value.scripts === undefined) {
        return {};
    }
    const scripts = value.scripts;
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
        throw new TypeError('Package JSON scripts must be an object');
    }
    const decodedScripts: Record<string, string> = {};
    for (const [name, script] of Object.entries(scripts)) {
        if (typeof script !== 'string') {
            throw new TypeError('Package JSON scripts must contain only strings');
        }
        decodedScripts[name] = script;
    }
    return { scripts: decodedScripts };
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
    const normalized = normalizeWhitespace(haystack);
    for (const needle of needles) {
        expect(normalized, needle).toContain(normalizeWhitespace(needle));
    }
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}
