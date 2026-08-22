import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/check-test-structure-coupling.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('test structure-coupling review', () => {
    it('reports stable advisory candidates for structural tests of production source', () => {
        const fixture = createGitFixture({
            'packages/example/src/order.ts': 'export const second = 2;\nexport const first = 1;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'import { Project } from \'ts-morph\';',
                '',
                'const source = readFileSync(\'packages/example/src/order.ts\', \'utf8\');',
                'const project = new Project();',
                'const names = project.createSourceFile(\'order.ts\', source).getFunctions();',
                'expect(source).toContain(\'first\');',
                'expect(source.split(\'\\n\').length).toBe(2);',
                'expect(source.indexOf(\'second\')).toBeLessThan(source.indexOf(\'first\'));',
                'expect(names).toHaveLength(0);'
            ].join('\n')
        });

        const first = runChecker(fixture);
        const second = runChecker(fixture);

        expect(first.status, first.stdout).toBe(0);
        expect(first.stdout).toContain('WARN: test structure-coupling review is advisory');
        expect(first.stdout).toContain('production-source-read');
        expect(first.stdout).toContain('ast-inspection');
        expect(first.stdout).toContain('symbol-assertion');
        expect(first.stdout).toContain('line-count');
        expect(first.stdout).toContain('call-or-import-order');
        expect(candidateLines(first.stdout)).toEqual(candidateLines(second.stdout));
        expect(first.stdout).toContain('evidence=unreviewed');
    });

    it('reports exact trees, source hashes or snapshots, and migration topology', () => {
        const fixture = createGitFixture({
            'packages/example/src/current.ts': 'export const current = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { createHash } from \'node:crypto\';',
                'import { readdirSync, readFileSync } from \'node:fs\';',
                '',
                'const source = readFileSync(\'packages/example/src/current.ts\', \'utf8\');',
                'expect(readdirSync(\'packages/example/src\')).toEqual([\'current.ts\']);',
                'expect(createHash(\'sha256\').update(source).digest(\'hex\')).toBe(\'deadbeef\');',
                'expect(source).toMatchSnapshot();',
                'expect(source).toContain(\'compatibility migration bridge\');'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('exact-file-tree');
        expect(result.stdout).toContain('source-hash-or-snapshot');
        expect(result.stdout).toContain('migration-or-compatibility-topology');
    });

    it('reports high-signal mock, browser topology, platform probe, and asset identity candidates', () => {
        const fixture = createGitFixture({
            'packages/tests/example/high-signal.test.ts': [
                'import { expect, vi } from \'vitest\';',
                '',
                'const collaborator = vi.fn();',
                'expect(collaborator).toHaveBeenCalledTimes(2);',
                'expect(collaborator).toHaveBeenNthCalledWith(1, \'first\');',
                'expect(collaborator.mock.calls).toEqual([[\'first\'], [\'second\']]);',
                'expect(collaborator.mock.invocationCallOrder[0]).toBeLessThan(',
                '  collaborator.mock.invocationCallOrder[1],',
                ');',
                'await page.addInitScript(() => {',
                '  window.__rallarCallLog = [];',
                '  const replaceState = history.replaceState.bind(history);',
                '  history.replaceState = (...args) => {',
                '    window.__rallarCallLog.push(args);',
                '    return replaceState(...args);',
                '  };',
                '});',
                'await page.addInitScript(() => {',
                '  Object.defineProperty(window, \'setInterval\', { value: () => 17 });',
                '  window.Worker = class WorkerProbe extends Worker {};',
                '});',
                'expect(workerUrl).toBe(\'/assets/export-worker-a1b2c3.js\');',
                'expect(chunkUrl).toEqual(\'/assets/index-d4e5f6.js\');'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        for (
            const kind of [
                'mock-invocation-count-or-order',
                'browser-call-log',
                'platform-scheduling-or-history-probe',
                'generated-artifact-identity'
            ]
        ) {
            expect(result.stdout).toContain(kind);
        }
    });

    it('does not report ordinary owned-port payloads, boundary fakes, or browser state assertions', () => {
        const fixture = createGitFixture({
            'packages/tests/example/public-boundary.test.ts': [
                'import { expect, vi } from \'vitest\';',
                '',
                'const paymentGateway = { charge: vi.fn() };',
                'expect(paymentGateway.charge).toHaveBeenCalledWith({ amountOre: 2_500 });',
                'expect(fakePaymentGateway.charges).toEqual([{ amountOre: 2_500 }]);',
                'await page.goBack();',
                'expect(page.url()).toContain(\'receiptId=receipt-1\');',
                'await page.addInitScript(() => {',
                '  window.Worker = class OwnedBoundaryWorker {};',
                '  Object.defineProperty(window, \'setTimeout\', { value: callback => callback() });',
                '});',
                'expect(workerResponse.headers()[\'content-type\']).toContain(\'javascript\');'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
    });

    it('reports negated payload absence and mock call-array count assertions', () => {
        const fixture = createGitFixture({
            'packages/tests/example/interaction-topology.test.ts': [
                'import { expect, vi } from \'vitest\';',
                'const paymentGateway = { charge: vi.fn() };',
                'expect(paymentGateway.charge).not.toHaveBeenCalledWith({ amountOre: 2_500 });',
                'expect(paymentGateway.charge.mock.calls).toHaveLength(1);',
                'expect(paymentGateway.charge.mock.calls.length).toBe(1);'
            ].join('\n')
        });

        const result = runChecker(fixture);
        const candidates = readCandidates(result.stdout);

        expect(result.status, result.stdout).toBe(0);
        expect(candidates).toHaveLength(3);
        expect(candidates.every(({ kind }) => kind === 'mock-invocation-count-or-order')).toBe(true);
    });

    it('does not flag governance tests that read canonical guidance rather than production source', () => {
        const fixture = createGitFixture({
            'docs/repo-human-style-guide.md': '# Canonical guidance\n',
            'packages/tests/repo/governance.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                '',
                'const guidance = readFileSync(\'docs/repo-human-style-guide.md\', \'utf8\');',
                'expect(guidance).toContain(\'Canonical guidance\');'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
        expect(result.stdout).not.toContain('governance.test.ts');
    });

    it('does not treat fixture source strings as production-source reads', () => {
        const fixture = createGitFixture({
            'packages/tests/repo/fixture-builder.test.ts': [
                'const fixtureSource = "const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');";',
                'expect(fixtureSource).toContain(\'public.ts\');'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
    });

    it('does not parse declarations embedded in fixture source strings', () => {
        const fixture = createGitFixture({
            'packages/tests/repo/fixture-object.test.ts': [
                'const fixture = {',
                '  source: "const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');",',
                '};',
                'expect(fixture.source).toContain(\'public.ts\');'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
    });

    it('excludes non-code artifacts under test directories from source parsing', () => {
        const fixture = createGitFixture({
            'packages/tests/example/artifact.json': '{ deliberately invalid JSON',
            'packages/tests/example/notes.md': '# source = readFileSync(',
            'packages/tests/example/report.html': '<script>const broken = </script>',
            'packages/tests/example/screenshot.png': 'not image bytes and not source code',
            'packages/tests/example/semantic.test.ts': 'expect(true).toBe(true);\n'
        });

        const result = runChecker(fixture);
        const selectedArtifact = runChecker(fixture, [
            '--files',
            'packages/tests/example/artifact.json'
        ]);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
        expect(result.stdout).not.toContain('artifact.json');
        expect(result.stdout).not.toContain('notes.md');
        expect(result.stdout).not.toContain('report.html');
        expect(result.stdout).not.toContain('screenshot.png');
        expect(selectedArtifact.status, selectedArtifact.stdout).toBe(0);
        expect(selectedArtifact.stdout).toContain('PASS: no current structure-coupled test candidates');
        expect(selectedArtifact.stdout).not.toContain('artifact.json');
    });

    it('fails closed with path-specific evidence when supported test source cannot parse', () => {
        const fixture = createGitFixture({
            'packages/tests/example/broken.test.ts': 'it(\'valid\', () => {});\n'
        });
        const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
        writeFileSync(
            path.join(fixture.root, 'packages/tests/example/broken.test.ts'),
            'it(\'broken\', () => {\n'
        );
        const head = commitFixture(fixture.root, 'break supported test source');

        const results = [
            runChecker(fixture),
            runChecker(fixture, ['--files', 'packages/tests/example/broken.test.ts']),
            runChecker(fixture, ['--changed', base, head])
        ];

        for (const result of results) {
            expect(result.status).toBe(1);
            expect(result.stdout).toContain(
                'FAIL: supported test source could not be parsed: packages/tests/example/broken.test.ts:'
            );
            expect(result.stdout).not.toContain(' at parse (');
            expect(result.stdout).not.toContain('PASS: no current structure-coupled test candidates');
            expect(result.stdout).not.toContain('PASS: registry entries are complete and current');
        }
    });

    it('accepts individually registered durable public boundaries and temporary ratchets', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                '',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');',
                'expect(source.split(\'\\n\').length).toBe(2);'
            ].join('\n')
        });
        const initial = runChecker(fixture);
        const candidates = readCandidates(initial.stdout);

        writeRegistry(fixture.root, [
            durableEntry(candidates.find((candidate) => candidate.kind === 'symbol-assertion')!),
            temporaryEntry(candidates.find((candidate) => candidate.kind === 'line-count')!),
            ...candidates
                .filter((candidate) => candidate.kind === 'production-source-read')
                .map((candidate) => temporaryEntry(candidate))
        ]);

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('evidence=durable-public-boundary');
        expect(result.stdout).toContain('evidence=temporary-ratchet');
        expect(result.stdout).toContain(
            'PASS: all 3 current structure-coupling candidates are individually classified'
        );
        expect(result.stdout).toContain('PASS: registry entries are complete and current');
    });

    it('accepts a durable interaction boundary with an independently observable requirement', () => {
        const fixture = createGitFixture({
            'packages/tests/example/payment-idempotency.test.ts': [
                'import { expect, vi } from \'vitest\';',
                'const paymentGateway = { charge: vi.fn() };',
                'expect(paymentGateway.charge).toHaveBeenCalledTimes(1);'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            candidates.map(interactionEntry),
            [interactionContract()]
        );

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('evidence=durable-interaction-boundary');
        expect(result.stdout).toContain('PASS: registry entries are complete and current');
    });

    it('rejects an interaction boundary whose semantic contract omits the interaction requirement', () => {
        const fixture = createGitFixture({
            'packages/tests/example/payment-idempotency.test.ts': [
                'import { expect, vi } from \'vitest\';',
                'const paymentGateway = { charge: vi.fn() };',
                'expect(paymentGateway.charge).toHaveBeenCalledTimes(1);'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            candidates.map(interactionEntry),
            [exampleContract('payment-idempotency-contract')]
        );

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
            'interaction boundary contract requires an independently observable interaction requirement'
        );
    });

    it('rejects a vague interaction requirement even when it is nonempty', () => {
        const fixture = createGitFixture({
            'packages/tests/example/payment-idempotency.test.ts': [
                'import { expect, vi } from \'vitest\';',
                'const paymentGateway = { charge: vi.fn() };',
                'expect(paymentGateway.charge).toHaveBeenCalledTimes(1);'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            candidates.map(interactionEntry),
            [{
                ...interactionContract(),
                interactionRequirement: {
                    interactionKind: 'count',
                    ownedPort: 'gateway',
                    observableEffect: 'effect',
                    requiredConstraint: 'exactly once',
                    failureRationale: 'required'
                }
            }]
        );

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
            'interaction boundary contract requires an independently observable interaction requirement'
        );
    });

    it('rejects incomplete, duplicate, and stale registrations while keeping unreviewed candidates advisory', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                '',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        const candidate = candidates.find((item) => item.kind === 'symbol-assertion')!;
        const sourceRead = candidates.find((item) => item.kind === 'production-source-read')!;

        writeRegistry(fixture.root, [
            {
                ...durableEntry(candidate),
                owner: '',
                rationale: 'TODO',
                semanticCoverage: '[semantic test]'
            },
            durableEntry(candidate),
            {
                ...temporaryEntry(candidate),
                id: 'test-structure-coupling-stale'
            },
            {
                ...temporaryEntry(sourceRead),
                owner: 'later',
                removalCondition: '<removal condition>'
            }
        ]);

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('registry entry has duplicate id');
        expect(result.stdout).toContain('registry entry is stale');
        expect(result.stdout).toContain('durable boundary entry requires owner');
        expect(result.stdout).toContain('requires concrete rationale and semanticCoverage');
        expect(result.stdout).toContain('temporary ratchet entry requires owner');
        expect(result.stdout).toContain('temporary ratchet entry requires a concrete removalCondition');
    });

    it('keeps registered entries current when a reformat moves the occurrence', () => {
        // Candidate identity must survive reformatting. When line and column were part of the id, a
        // repository-wide format re-keyed every candidate at once and invalidated the whole registry.
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(fixture.root, candidates.map(durableEntry));

        expect(runChecker(fixture).status, 'registry must start current').toBe(0);

        // Same assertions, re-indented and pushed down the file: every line and column moves.
        writeFileSync(
            path.join(fixture.root, 'packages/tests/example/structure.test.ts'),
            [
                'import { readFileSync } from \'node:fs\';',
                '',
                'function readPublicApiSource() {',
                '        const source = readFileSync(',
                '                \'packages/example/src/public.ts\',',
                '                \'utf8\',',
                '        );',
                '        expect(source).toContain(\'publicApi\');',
                '}',
                '',
                'readPublicApiSource();'
            ].join('\n')
        );

        const reformatted = runChecker(fixture);

        expect(reformatted.status, reformatted.stdout).toBe(0);
        expect(reformatted.stdout).not.toContain('registry entry is stale');
        expect(reformatted.stdout).not.toContain('contract is not linked by a current candidate');
        expect(readCandidates(reformatted.stdout).map((candidate) => candidate.id).toSorted()).toEqual(
            candidates.map((candidate) => candidate.id).toSorted()
        );
    });

    it('rejects escaped, control-only, and vague contract evidence', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        const evidence = ['\\n', '\n\t', 'semantic coverage'] as const;

        writeRegistry(
            fixture.root,
            candidates.map((candidate, index) => ({
                ...temporaryEntry(candidate),
                contract: `invalid-contract-${index}`,
                rationale: evidence[index % evidence.length],
                semanticCoverage: evidence[(index + 1) % evidence.length],
                removalCondition: evidence[(index + 2) % evidence.length]
            })),
            candidates.map((_, index) => ({
                id: `invalid-contract-${index}`,
                domain: evidence[index % evidence.length],
                owner: 'example-owner',
                summary: evidence[(index + 1) % evidence.length],
                semanticCoverage: evidence[(index + 2) % evidence.length]
            }))
        );

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('contract requires a concrete domain and summary');
        expect(result.stdout).toContain('contract requires specific semanticCoverage');
        expect(result.stdout).toContain('requires concrete rationale and semanticCoverage');
        expect(result.stdout).toContain('requires a concrete removalCondition');
    });

    it('requires every candidate to link one current human contract summary', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            candidates.map((candidate) => ({
                ...durableEntry(candidate),
                contract: 'missing-contract'
            })),
            [exampleContract('orphan-contract')]
        );

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('links unknown contract: missing-contract');
        expect(result.stdout).toContain(
            'contract is not linked by a current candidate: orphan-contract'
        );
    });

    it('requires each candidate semantic assertion to match its linked contract', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            candidates.map((candidate) => ({
                ...durableEntry(candidate),
                semanticCoverage: 'packages/tests/example/different.test.ts#proves an unrelated behavior instead'
            }))
        );

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('semanticCoverage does not match linked contract');
    });

    it('rejects generated candidate rationale formulas instead of treating them as review', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            candidates.map((candidate) => ({
                ...durableEntry(candidate),
                rationale: 'Contract input read: const source = readFileSync(. Its only durable purpose is the linked Example package public API contract.'
            })),
            [
                {
                    ...exampleContract(),
                    coverageRelation: 'The executable public API assertion observes the consumer result protected by this boundary.'
                }
            ]
        );

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('uses a generated rationale formula');
    });

    it('rejects location-filled rationale templates that only restate checker metadata', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            candidates.map((candidate) => ({
                ...durableEntry(candidate),
                rationale:
                    'In “exposes publicApi”, this production-source-read occurrence uses the concrete tracked input “const source” because the test reads production source.'
            }))
        );

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('uses a generated rationale formula');
    });

    it('requires a concrete contract-to-assertion relation and unique coverage reference', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const candidates = readCandidates(runChecker(fixture).stdout);
        const [firstCandidate, secondCandidate] = candidates;
        const sharedCoverage = 'packages/tests/example/public-contract.test.ts#exposes the public behavior';
        writeRegistry(
            fixture.root,
            [
                {
                    ...durableEntry(firstCandidate),
                    contract: 'first-public-contract',
                    semanticCoverage: sharedCoverage
                },
                {
                    ...durableEntry(secondCandidate),
                    contract: 'second-public-contract',
                    semanticCoverage: sharedCoverage
                }
            ],
            [
                {
                    ...exampleContract('first-public-contract'),
                    semanticCoverage: sharedCoverage,
                    coverageRelation: ''
                },
                {
                    ...exampleContract('second-public-contract'),
                    semanticCoverage: sharedCoverage,
                    coverageRelation: 'This assertion observes the second consumer-visible public contract result.'
                }
            ]
        );

        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
            'contract requires a concrete coverageRelation: first-public-contract'
        );
        expect(result.stdout).toContain(
            'semanticCoverage is reused by multiple contracts without an explicit shared coverage group'
        );
    });

    it('blocks an unchanged high-signal finding anywhere in a touched test file', () => {
        const fixture = createGitFixture({
            'packages/tests/example/payment-idempotency.test.ts': [
                'import { expect, it, vi } from \'vitest\';',
                'const paymentGateway = { charge: vi.fn() };',
                'it(\'charges once\', () => {',
                '  expect(paymentGateway.charge).toHaveBeenCalledTimes(1);',
                '});',
                'it(\'returns the receipt\', () => expect(receipt.id).toBe(\'receipt-1\'));'
            ].join('\n')
        });
        const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
        writeFileSync(
            path.join(fixture.root, 'packages/tests/example/payment-idempotency.test.ts'),
            [
                'import { expect, it, vi } from \'vitest\';',
                'const paymentGateway = { charge: vi.fn() };',
                'it(\'charges once\', () => {',
                '  expect(paymentGateway.charge).toHaveBeenCalledTimes(1);',
                '});',
                'it(\'returns the receipt identifier\', () => expect(receipt.id).toBe(\'receipt-1\'));'
            ].join('\n')
        );
        const head = commitFixture(fixture.root, 'rename unrelated semantic test');

        expect(runGit(fixture.root, ['diff', '--name-status', base, head])).toContain(
            'M\tpackages/tests/example/payment-idempotency.test.ts'
        );
        expect(runChecker(fixture).stdout).toContain('mock-invocation-count-or-order');

        const result = runChecker(fixture, ['--changed', base, head]);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('mock-invocation-count-or-order');
        expect(result.stdout).toContain('change=touched');
        expect(result.stdout).toContain('FAIL: changed candidate lacks individual classification');
    });

    it('reports changed-range candidate deletion neutrally rather than claiming a semantic replacement', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                '',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
        writeFileSync(
            path.join(fixture.root, 'packages/tests/example/structure.test.ts'),
            [
                'import { readFileSync } from \'node:fs\';',
                '',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(publicApi()).toBe(true);'
            ].join('\n')
        );
        const head = commitFixture(fixture.root, 'replace source assertion');

        const result = runChecker(fixture, ['--changed', base, head]);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('mode=changed-range');
        expect(result.stdout).toContain('change=deleted');
        expect(result.stdout).not.toContain('deleted-or-replaced-semantic-coverage');
        expect(result.stdout).toContain('change=touched');
        expect(result.stdout).toContain('evidence=unreviewed');
        expect(result.stdout).toContain('FAIL: changed candidate lacks individual classification');
        expect(result.stdout).toContain('changed-range structure-coupling review blocks');
    });

    it('reports a newly added structural test without Git missing-path noise', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n'
        });
        const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
        const testPath = path.join(fixture.root, 'packages/tests/example/new-structure.test.ts');
        mkdirSync(path.dirname(testPath), { recursive: true });
        writeFileSync(
            testPath,
            [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        );
        const head = commitFixture(fixture.root, 'add structural test');

        const result = runChecker(fixture, ['--changed', base, head]);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('change=new');
        expect(result.stdout).toContain('FAIL: changed candidate lacks individual classification');
        expect(result.stdout).not.toContain('fatal: path');
    });

    it('counts only current candidates when changed evidence also includes a deletion', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');',
                'expect(source).toContain(\'secondaryApi\');'
            ].join('\n')
        });
        const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
        writeFileSync(
            path.join(fixture.root, 'packages/tests/example/structure.test.ts'),
            [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        );
        commitFixture(fixture.root, 'remove obsolete structural assertion');
        const currentCandidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            currentCandidates.map((candidate) => durableEntry(candidate))
        );
        const head = commitFixture(fixture.root, 'classify retained boundary');

        const result = runChecker(fixture, ['--changed', base, head]);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('change=deleted');
        expect(result.stdout).toContain(
            `PASS: all ${currentCandidates.length} current structure-coupling candidates are individually classified`
        );
    });

    it('accepts changed structural evidence only after every current occurrence is registered', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n'
        });
        const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
        const testPath = path.join(fixture.root, 'packages/tests/example/new-structure.test.ts');
        mkdirSync(path.dirname(testPath), { recursive: true });
        writeFileSync(
            testPath,
            [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        );
        commitFixture(fixture.root, 'add structural test');
        const candidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            candidates.map((candidate) => temporaryEntry(candidate))
        );
        const head = commitFixture(fixture.root, 'classify structural test');

        const result = runChecker(fixture, ['--changed', base, head]);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain(
            'PASS: changed-range structure-coupling review has complete individual classifications'
        );
        expect(result.stdout).not.toContain('lacks individual classification');
    });

    it('reports renamed non-ASCII test paths as renamed using NUL-safe Git evidence', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/å-structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });
        const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
        runGit(fixture.root, [
            'mv',
            'packages/tests/example/å-structure.test.ts',
            'packages/tests/example/å-renamed-structure.test.ts'
        ]);
        const head = commitFixture(fixture.root, 'rename structural test');

        const result = runChecker(fixture, ['--changed', base, head]);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('å-renamed-structure.test.ts');
        expect(result.stdout).toContain('change=renamed');
    });

    it('links candidates to production-source values within their source-structure test block', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/scoped-structure.test.ts': [
                'import { readFileSync as readSource } from \'node:fs\';',
                'import * as path from \'node:path\';',
                '',
                'it(\'checks the public source boundary\', () => {',
                '  const sourcePath = path.join(',
                '    repoRoot, \'packages\', \'example\', \'src\', \'public.ts\',',
                '  );',
                '  const source = readSource(sourcePath, \'utf8\');',
                '  const artifact = JSON.parse(\'{"legacy": true}\');',
                '  expect(source).toContain(\'publicApi\');',
                '  expect(artifact.legacy).toBe(true);',
                '  expect(readdirSync(\'tmp/artifacts\')).toEqual([\'legacy.json\']);',
                '  const compatibilityNote = \'legacy migration complete\';',
                '  expect(compatibilityNote).toBeDefined();',
                '});'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('production-source-read');
        expect(result.stdout).toContain('symbol-assertion');
        expect(result.stdout).not.toContain('exact-file-tree');
        expect(result.stdout).not.toContain('migration-or-compatibility-topology');
        expect(result.stdout).not.toContain('JSON.parse');
    });

    it('keeps duplicate structural assertions as independently registered occurrences', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/duplicate-structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        });

        const candidates = readCandidates(runChecker(fixture).stdout).filter(
            (candidate) => candidate.kind === 'symbol-assertion'
        );

        expect(candidates).toHaveLength(2);
        expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(2);
        expect(
            new Set(candidates.map((candidate) => `${candidate.line}:${candidate.column}`)).size
        ).toBe(2);
    });

    it('validates registrations against the complete tree rather than a filtered report', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/registered-structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n'),
            'packages/tests/example/selected.test.ts': 'expect(true).toBe(true);\n'
        });
        const registeredCandidates = readCandidates(runChecker(fixture).stdout);
        writeRegistry(
            fixture.root,
            registeredCandidates.map((candidate) => temporaryEntry(candidate))
        );
        const base = commitFixture(fixture.root, 'register reviewed candidate');
        writeFileSync(
            path.join(fixture.root, 'packages/tests/example/selected.test.ts'),
            'expect(false).toBe(false);\n'
        );
        const head = commitFixture(fixture.root, 'touch unrelated test');

        const selected = runChecker(fixture, ['--files', 'packages/tests/example/selected.test.ts']);
        const changed = runChecker(fixture, ['--changed', base, head]);

        expect(selected.status, selected.stdout).toBe(0);
        expect(selected.stdout).not.toContain('registry entry is stale');
        expect(changed.status, changed.stdout).toBe(0);
        expect(changed.stdout).not.toContain('registry entry is stale');
    });

    it('traverses mixed TypeScript test callbacks, imports, wrappers, paths, and source arrays', () => {
        const fixture = createGitFixture({
            'apps/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/example/src/other.ts': 'export const otherApi = true;\n',
            'packages/tests/example/syntax-aware.test.ts': [
                'import { readFileSync as readSync } from \'node:fs\';',
                'import readAsync from \'node:fs/promises\';',
                'import * as path from \'node:path\';',
                '',
                'const sourcePaths = [',
                '  path.join(repoRoot, \'apps\', \'example\', \'src\', \'public.ts\'),',
                '  path.resolve(repoRoot, \'packages\', \'example\', \'src\', \'other.ts\'),',
                '] as const;',
                '',
                'function readSource(filePath: string): string {',
                '  return readSync(filePath, \'utf8\');',
                '}',
                '',
                'describe(\'syntax-aware traversal\', function () {',
                '  test(\'finds wrapper reads in loops\', async function () {',
                '    for (const filePath of sourcePaths) {',
                '      const source = readSource(filePath);',
                '      expect(source).toContain(\'Api\');',
                '    }',
                '    await readAsync(sourcePaths[0], \'utf8\');',
                '  });',
                '});'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout.match(/production-source-read/g)).toHaveLength(2);
        expect(result.stdout).toContain('symbol-assertion');
    });

    it('does not label JSON parsing of source content as AST inspection', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.json': '{"publicApi":true}\n',
            'packages/tests/example/json-source.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.json\', \'utf8\');',
                'const parsed = JSON.parse(source);',
                'expect(parsed.publicApi).toBe(true);'
            ].join('\n')
        });

        const result = runChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('production-source-read');
        expect(result.stdout).not.toContain('ast-inspection');
    });

    it('links approved static boundaries to their owning executable assertions', () => {
        const registry = readRepositoryRegistry();
        const contracts = new Map(registry.contracts.map((contract) => [contract.id, contract]));
        const entriesByContract = Map.groupBy(registry.entries, (entry) => entry.contract);

        expect(contracts.get('control-protocol-server-import-direction')?.semanticCoverage).toBe(
            'packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server'
        );
        expect(contracts.get('control-protocol-browser-boundary')?.semanticCoverage).toBe(
            'packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app'
        );
        expect(entriesByContract.get('control-protocol-server-import-direction')).toHaveLength(2);
        expect(entriesByContract.get('control-protocol-browser-boundary')).toHaveLength(5);

        expect(contracts.get('repo-style-checker-interface')?.semanticCoverage).toBe(
            'packages/tests/repo/repo-code-style-checker-integrity.test.ts#keeps TypeScript formatter settings aligned with the canonical baseline'
        );
        expect(entriesByContract.get('repo-style-checker-interface')).toHaveLength(1);

        expect(contracts.get('auth-server-wrapper-mutation-boundary')?.semanticCoverage).toBe(
            'packages/tests/repo/auth-server-compatibility-governance.test.ts#rejects export kind, target, and second-hop changes'
        );
        expect(contracts.get('auth-server-canonical-test-inventory')?.semanticCoverage).toBe(
            'packages/tests/repo/auth-server-compatibility-governance.test.ts#keeps every canonical auth test free of compatibility wrappers'
        );
        expect(entriesByContract.get('auth-server-wrapper-mutation-boundary')).toHaveLength(2);
        expect(entriesByContract.get('auth-server-canonical-test-inventory')).toHaveLength(1);
    });

    it('reports renamed removals and unchanged-source copies with range-safe evidence', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/original-structure.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');',
                'expect(source).toContain(\'removedOnRename\');'
            ].join('\n')
        });
        const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
        runGit(fixture.root, [
            'mv',
            'packages/tests/example/original-structure.test.ts',
            'packages/tests/example/renamed-structure.test.ts'
        ]);
        writeFileSync(
            path.join(fixture.root, 'packages/tests/example/renamed-structure.test.ts'),
            [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n')
        );
        writeFileSync(
            path.join(fixture.root, 'packages/tests/example/copied-structure.test.ts'),
            [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');',
                'expect(source).toContain(\'removedOnRename\');'
            ].join('\n')
        );
        const head = commitFixture(fixture.root, 'rename and copy structural tests');

        const result = runChecker(fixture, ['--changed', base, head]);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('change=renamed');
        expect(result.stdout).toContain('change=deleted');
        expect(result.stdout).toContain('origin=copy');
        expect(result.stdout).not.toContain('deleted-or-replaced-semantic-coverage');
    });

    it('reports an explicit changed-file selection without scanning unrelated tests', () => {
        const fixture = createGitFixture({
            'packages/example/src/public.ts': 'export const publicApi = true;\n',
            'packages/tests/example/selected.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'publicApi\');'
            ].join('\n'),
            'packages/tests/example/unrelated.test.ts': [
                'import { readFileSync } from \'node:fs\';',
                'const source = readFileSync(\'packages/example/src/public.ts\', \'utf8\');',
                'expect(source).toContain(\'unrelated\');'
            ].join('\n')
        });

        const result = runChecker(fixture, ['--files', 'packages/tests/example/selected.test.ts']);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('mode=changed-files');
        expect(result.stdout).toContain('change=selected');
        expect(result.stdout).toContain('selected.test.ts');
        expect(result.stdout).not.toContain('unrelated.test.ts');
    });
});

function readRepositoryRegistry(): Readonly<{
    contracts: readonly Readonly<{
        id: string;
        semanticCoverage: string;
    }>[];
    entries: readonly Readonly<{
        contract: string;
    }>[];
}> {
    const source = readFileSync(
        path.join(repoRoot, 'docs/test-structure-coupling-exceptions.md'),
        'utf8'
    );
    const metadata = source.match(
        /```test-structure-coupling-registry-v1\s*\n([\s\S]*?)\n```/u
    )?.[1];
    if (!metadata) {
        throw new Error('Test structure-coupling registry metadata is missing.');
    }
    return JSON.parse(metadata) as ReturnType<typeof readRepositoryRegistry>;
}

function createGitFixture(files: Record<string, string>): { readonly root: string; } {
    const root = mkdtempSync(path.join(tmpdir(), 'rallar-test-structure-coupling-'));
    fixtureRoots.push(root);
    for (const [relativePath, source] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, source);
    }
    writeRegistry(root, []);
    runGit(root, ['init']);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    runGit(root, ['config', 'user.name', 'Test User']);
    commitFixture(root, 'initial fixture');
    return { root };
}

function writeRegistry(
    root: string,
    entries: readonly RegistryEntry[],
    contracts: readonly SemanticContract[] = entries.length > 0 ? [exampleContract()] : []
) {
    const registryPath = path.join(root, 'docs/test-structure-coupling-exceptions.md');
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(
        registryPath,
        [
            '# Test structure-coupling exception registry',
            '',
            '```test-structure-coupling-registry-v1',
            JSON.stringify({ version: 1, contracts, entries }, null, 2),
            '```',
            ''
        ].join('\n')
    );
}

function runChecker(
    fixture: { readonly root: string; },
    args: readonly string[] = []
): { readonly status: number | null; readonly stdout: string; } {
    const result = spawnSync(process.execPath, [checkerPath, ...args], {
        cwd: fixture.root,
        encoding: 'utf8'
    });
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
}

function candidateLines(output: string): readonly string[] {
    return output.split('\n').filter((line) => line.startsWith('CANDIDATE '));
}

function readCandidates(output: string): readonly TestCandidate[] {
    return candidateLines(output).map((line) => {
        const [identifier, location, kind] = line.split(' | ');
        const id = identifier.slice('CANDIDATE '.length);
        const [path, lineNumber, column] = location.split(':');
        return { id, path, line: Number(lineNumber), column: Number(column), kind };
    });
}

function durableEntry(candidate: TestCandidate): RegistryEntry {
    return {
        ...candidate,
        contract: 'example-public-contract',
        disposition: 'durable-boundary',
        boundary: 'public',
        owner: 'example-owner',
        rationale: 'The named public boundary is intentionally stable.',
        semanticCoverage: 'packages/tests/example/public-contract.test.ts#exposes the public behavior'
    };
}

function interactionEntry(candidate: TestCandidate): RegistryEntry {
    return {
        ...candidate,
        contract: 'payment-idempotency-contract',
        disposition: 'durable-boundary',
        boundary: 'interaction',
        owner: 'payments-owner',
        rationale: 'The charge count proves that an idempotent retry cannot bill the customer twice.',
        semanticCoverage: 'packages/tests/example/payment-idempotency.test.ts#does not charge twice for one idempotency key'
    };
}

function temporaryEntry(candidate: TestCandidate): RegistryEntry {
    return {
        ...candidate,
        contract: 'example-public-contract',
        disposition: 'temporary-ratchet',
        owner: 'example-owner',
        rationale: 'The ratchet protects a migration while semantic coverage is added.',
        semanticCoverage: 'packages/tests/example/public-contract.test.ts#exposes the public behavior',
        removalCondition: 'Remove after the named semantic contract test is complete.'
    };
}

function exampleContract(id = 'example-public-contract'): SemanticContract {
    return {
        id,
        domain: 'Example package public API',
        owner: 'example-owner',
        summary: 'Consumers can call the public API and observe its documented result.',
        semanticCoverage: 'packages/tests/example/public-contract.test.ts#exposes the public behavior',
        coverageRelation: 'The executable public API assertion observes the consumer result protected by this boundary.'
    };
}

function interactionContract(): SemanticContract {
    return {
        id: 'payment-idempotency-contract',
        domain: 'Payment idempotency',
        owner: 'payments-owner',
        summary: 'One idempotency key creates at most one external payment charge.',
        semanticCoverage: 'packages/tests/example/payment-idempotency.test.ts#does not charge twice for one idempotency key',
        coverageRelation: 'The executable test retries one command and observes both the stable receipt and the payment gateway effect.',
        interactionRequirement: {
            interactionKind: 'count',
            ownedPort: 'PaymentGateway.charge',
            observableEffect: 'A gateway charge appears on the customer payment account.',
            requiredConstraint: 'No more than one charge may occur for each idempotency key.',
            failureRationale: 'A duplicate gateway call bills the same customer twice.'
        }
    };
}

function commitFixture(root: string, message: string): string {
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', message]);
    return runGit(root, ['rev-parse', 'HEAD']).trim();
}

function runGit(root: string, args: readonly string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

interface TestCandidate {
    readonly id: string;
    readonly path: string;
    readonly line: number;
    readonly column: number;
    readonly kind: string;
}

interface RegistryEntry extends TestCandidate {
    readonly contract?: string;
    readonly disposition?: string;
    readonly boundary?: string;
    readonly owner?: string;
    readonly rationale?: string;
    readonly semanticCoverage?: string;
    readonly removalCondition?: string;
}

interface SemanticContract {
    readonly id: string;
    readonly domain?: string;
    readonly owner?: string;
    readonly summary?: string;
    readonly semanticCoverage?: string;
    readonly coverageRelation?: string;
    readonly sharedCoverageGroup?: string;
    readonly interactionRequirement?: {
        readonly interactionKind: 'absence' | 'count' | 'order';
        readonly ownedPort: string;
        readonly observableEffect: string;
        readonly requiredConstraint: string;
        readonly failureRationale: string;
    };
}
