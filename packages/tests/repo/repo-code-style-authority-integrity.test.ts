import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const canonicalStylePath = '.agents/skills/rallar-code-writing/references/repo-code-style.md';
const canonicalServiceWritingPath =
  '.agents/skills/rallar-code-writing/references/convergent-service-writing.md';

describe('repo code style authority integrity', () => {
  it('applies universal human-readability doctrine to every human-authored code surface', () => {
    const agents = readRepo('AGENTS.md');
    const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
    const canonicalStyle = readRepo(canonicalStylePath);
    const humanGuide = readRepo('docs/repo-human-style-guide.md');
    const skillDescription = codeWriting.match(/^description:\s*(.+)$/mu)?.[1] ?? '';

    expectAll(agents, [
      'all human-authored code',
      'ownership, dataflow, decisions, side effects, failures, and call paths',
    ]);
    expectAll(codeWriting, ['all human-authored code', 'TypeScript-specific rules']);
    expectAll(canonicalStyle, [
      'Universal structural rules',
      'all human-authored code',
      'TypeScript-specific rules',
    ]);
    expectAll(humanGuide, ['all human-authored code', 'TypeScript checker']);
    expect(skillDescription).toContain('all human-authored code');
  });

  it('makes minimum cognitive indirection, production authority, and legacy closure plan gates explicit', () => {
    const agents = readRepo('AGENTS.md');
    const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
    const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
    const canonicalStyle = readRepo(canonicalStylePath);
    const humanGuide = readRepo('docs/repo-human-style-guide.md');
    const slogan = 'The goal is not minimum syntax. The goal is minimum cognitive indirection.';

    expect(agents).toContain(slogan);
    expect(canonicalStyle).toContain(slogan);
    expectAllNormalized(canonicalStyle, [
      'vocabulary, ownership, files, abstractions, dataflow, decisions, callbacks, side effects, failures, tests, compatibility layers, or legacy paths',
      'real domain, lifecycle, policy, translation, compatibility, protocol, or side-effect boundary',
    ]);

    for (const source of [codeWriting, testing, canonicalStyle, humanGuide]) {
      expectAllNormalized(source, [
        'Production code is the primary design artifact; tests are secondary evidence',
        'Tests protect independently stated observable behavior, public contracts, safety and correctness invariants, and approved architecture boundaries',
      ]);
      expect(source.replace(/\s+/g, ' ')).toMatch(
        /never restore inferior production structure merely to make a coupled test pass/iu,
      );
    }

    expectAllNormalized(codeWriting, [
      'a legacy baseline and exit criteria',
      'a legacy impact judgment for each capability slice',
      'a final complete code and legacy review',
      'The working plan owns when that review runs; this skill owns the code judgment',
      '`removed`, `minimized-boundary`, `resolved`, or `retained`',
      'Unclassified affected legacy blocks code completion',
      'explicit authorized-maintainer approval',
    ]);
    expectAllNormalized(canonicalStyle, [
      'Newly discovered in-scope legacy must be reviewed in the current pull request',
      'Independent untouched code remains outside the closure',
      'Unrelated repository legacy is outside the completion gate',
      '`removed`, `minimized-boundary`, `resolved`, or `retained`',
    ]);
  });

  it('routes every TypeScript change through one repo-wide style authority', () => {
    const agents = readRepo('AGENTS.md');
    const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
    const humanGuide = readRepo('docs/repo-human-style-guide.md');
    const docsIndex = readRepo('docs/README.md');
    const canonicalStyle = readRepo(canonicalStylePath);
    const canonicalServiceWriting = readRepo(canonicalServiceWritingPath);
    const packageJson = readJson('package.json') as {
      scripts?: Readonly<Record<string, string>>;
    };
    const primaryCodeGoal = 'Code is written first for human developers.';

    expect(existsSync(path.join(repoRoot, canonicalStylePath))).toBe(true);
    expect(existsSync(path.join(repoRoot, canonicalServiceWritingPath))).toBe(true);
    expect(
      existsSync(
        path.join(repoRoot, '.agents/skills/rallar-code-writing/references/package-code-style.md'),
      ),
    ).toBe(false);
    expect(codeWriting).toContain('Always read `references/repo-code-style.md`');
    expectAll(agents, [
      primaryCodeGoal,
      'human understandability is the governing design criterion',
      'any TypeScript change',
      canonicalStylePath,
    ]);
    expectAll(codeWriting, [
      primaryCodeGoal,
      'A mechanically compliant change is not acceptable',
      'references/repo-code-style.md',
      'references/convergent-service-writing.md',
    ]);
    expectAllNormalized(canonicalServiceWriting, [
      'functional core',
      'explicitly owned stateful shell',
      'one coherent business capability, one ownership boundary, and one reason to change',
      '`apply`, `no-op`, or `reject`',
      '`written` or `conflict`',
    ]);
    expectAll(humanGuide, [
      primaryCodeGoal,
      'Mechanical compliance does not compensate',
      canonicalStylePath,
      'authoritative coding standard',
    ]);
    expect(docsIndex).toContain('./repo-human-style-guide.md');
    expect(packageJson.scripts).not.toHaveProperty('check:repo-style:strict');
    expect(packageJson.scripts).toHaveProperty(
      'check:repo-style:changed',
      'node scripts/check-changed-repo-style.mjs',
    );
    expect(packageJson.scripts).toHaveProperty('check:repo-style:object-interfaces');
    expect(packageJson.scripts).toMatchObject({
      'check:repo-style:layout': 'node scripts/repo-style-check.mjs --layout-only',
      'check:repo-style:layout-details':
        'node scripts/repo-style-check.mjs --layout-only --layout-details',
    });
    expectAll(canonicalStyle, [
      primaryCodeGoal,
      '## First principle: code is for human developers',
      'human understandability is the governing design criterion',
      'The rules below are defaults derived from this principle',
      '`validateXxx` always returns all issues and never throws',
      'The caller or a central\n`classifyRuntimeFailure` policy decides the disposition',
      'Do not put a guessed\n`retryable` boolean on a low-level exception',
      'The plain-object `type` preference is a manual review rule',
      '`unknown` belongs only at an untrusted boundary',
    ]);
    expectAll(canonicalStyle, [
      '## Feature ownership and repository organization',
      '## File and primary symbol names',
      'Organize by owned feature or capability before technical role',
      'More than 20 direct production TypeScript files prompts an ownership review',
      'Four or more sibling files with the same meaningful feature prefix',
      '`room` is the product and browser term',
      '`group-state` is the authoritative API and server term',
      '`room-group-state-translation.ts`',
    ]);
    expectAll(humanGuide, [
      'obvious feature entry file',
      'primary exported symbol',
      'co-located with the feature that owns it',
      'room/group-state translation boundary',
      'check:repo-style:layout',
      'check:repo-style:layout-details',
      'grouped warnings',
      'affected counts',
      'not an instruction to create folders or pass-through modules mechanically',
      'layout.directory-density',
      'layout.feature-prefix-cluster',
      'layout.filename-style',
      'layout.generic-filename',
      'layout.generic-route-init',
      'layout.unapproved-mod',
    ]);
  });

  it('runs incremental style enforcement in the feature-branch release gate', () => {
    const branchReleaseGate = readRepo('.github/workflows/branch-release-gate.yml');
    const releaseGate = readRepo('.github/workflows/release-gate.yml');
    const humanGuide = readRepo('docs/repo-human-style-guide.md');
    const canonicalStyle = readRepo(canonicalStylePath);
    const refactoringProgram = readRepo(
      'plans/repo-human-traceability-refactoring-program-plan.md',
    );

    // The base is the PR base unless a reviewer labels the pull request, which passes the empty
    // base the main-push deploy path already uses. Only a repository-wide reformat earns it.
    expect(branchReleaseGate).toContain('github.event.pull_request.base.sha }}');
    expect(branchReleaseGate).toContain(
      "contains(github.event.pull_request.labels.*.name, 'skip-changed-gates')",
    );
    expect(branchReleaseGate).not.toContain('origin/main');
    expect(releaseGate).toContain('changed_repo_style_base:');
    expect(releaseGate).toContain('fetch-depth: 0');
    expect(releaseGate).toContain('node scripts/check-changed-repo-style.mjs');
    expect(releaseGate).toContain('steps.changed_review_range.outputs.base');
    expect(releaseGate).toContain('steps.changed_review_range.outputs.head');
    expect(humanGuide).toContain('new or worsened findings');
    expect(humanGuide).toContain('No global strict mode yet');
    expect(canonicalStyle).toMatch(/full-repository checker remains warning-only/iu);
    expect(canonicalStyle).toMatch(/feature-branch CI blocks only new or worsened findings/iu);
    expect(refactoringProgram).toMatch(/new or worsened branch\s+findings are blocking/iu);
    expect(refactoringProgram).toMatch(/full-repository checker remains warning-only/iu);
  });

  it('keeps canonical examples inside the vocabulary they teach', () => {
    const canonicalStyle = readRepo(canonicalStylePath);
    const factoryExample =
      canonicalStyle.match(
        /## Factory inputs and visible defaults([\s\S]*?)## Function inputs and outputs/,
      )?.[1] ?? '';

    expect(factoryExample).not.toContain('Manager');
  });

  it('applies the human file-density thresholds to every TypeScript surface', () => {
    const canonicalStyle = readRepo(canonicalStylePath);

    expectAll(canonicalStyle, [
      'A file owns one coherent responsibility',
      'cognitive load `<50`: normal target',
      'cognitive load `50-109`: cohesion warning',
      'cognitive load `110-329`: required separation review',
      'cognitive load `>=330`: refactor or record an approved persistent exception',
      '`>=12` runtime values',
      'navigation backstop (`file.length`)',
      'at or under `1,200` physical lines',
      'data-literal discount replaces registry entries for declarative files',
      '`<=40` physical lines: normal target',
      '`41-49` physical lines: warning',
      '`50-60` physical lines: required separation review',
      '`>60` physical lines: refactor or record an approved symbol-level exception',
      'Route handlers retain the stricter `<=30`-line target',
    ]);
    expect(canonicalStyle).not.toContain('production-file review threshold');
    expect(canonicalStyle).not.toContain('`401-500` physical lines');
    expect(canonicalStyle).not.toContain('`>800` physical lines');
  });

  it('defines qualitative cohesion review before any size-driven extraction', () => {
    const canonicalStyle = readRepo(canonicalStylePath).replace(/\s+/g, ' ');
    const humanGuide = readRepo('docs/repo-human-style-guide.md').replace(/\s+/g, ' ');

    expectAll(canonicalStyle, [
      'summarize its responsibility in one sentence',
      'independent reasons to change',
      'imports naturally form unrelated groups',
      'jump repeatedly between distant sections',
      'Private helpers fall into distinct conceptual clusters',
      'several unrelated setup modes',
      'multiple lifecycles or state machines',
      'merge conflicts in unrelated areas',
      'Size is a review signal',
      'pass-through files or helper chains',
    ]);
    expectAll(humanGuide, [
      'Summarize the file responsibility in one sentence',
      'Apply the cognitive-load tier, responsibility threshold, and navigation backstop',
      'Inspect the eight qualitative cohesion signals',
      'Identify real responsibility boundaries before proposing extraction',
      'Check whether an exception applies and is approved',
      'public API, state, dataflow, and change ownership',
    ]);
  });

  it('routes persistent size exceptions without duplicating thresholds in AGENTS.md', () => {
    const agents = readRepo('AGENTS.md');
    const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
    const canonicalStyle = readRepo(canonicalStylePath);
    const humanGuide = readRepo('docs/repo-human-style-guide.md');
    const docsIndex = readRepo('docs/README.md');
    const exceptionPath = 'docs/repo-code-style-exceptions.md';

    expect(existsSync(path.join(repoRoot, exceptionPath))).toBe(true);
    const exceptionRegistry = readRepo(exceptionPath);

    expectAll(canonicalStyle, [exceptionPath, 'Materially touched']);
    expect(humanGuide).toContain('./repo-code-style-exceptions.md');
    expect(docsIndex).toContain('./repo-code-style-exceptions.md');
    expectAll(exceptionRegistry, [
      'Repository-relative path',
      'Symbol',
      'Exception category',
      'Why cohesion is clearer',
      'Approval date and reviewer',
      'Review or removal condition',
    ]);
    expect(codeWriting).toContain('Always read `references/repo-code-style.md`');
    expect(agents).not.toContain('`501-800`');
    expect(agents).not.toContain('`>800`');
    expect(agents).not.toContain('`50-60`');
    expect(agents).not.toContain('`>60`');
  });

  it('requires size-tier review at child-plan entry and exit', () => {
    const refactoringPlan = readRepo('plans/repo-human-traceability-refactoring-program-plan.md');
    const entryContract =
      refactoringPlan.match(
        /Every feature child plan begins with:([\s\S]*?)Every child plan ends with:/u,
      )?.[1] ?? '';
    const exitContract =
      refactoringPlan.match(
        /Every child plan ends with:([\s\S]*?)Feature status values are:/u,
      )?.[1] ?? '';

    expect(entryContract).toContain('file-size tier and 40/50/60 function review');
    expect(exitContract).toContain('final file-size tier and 40/50/60 function review');
    expect(exitContract).toContain('over-800-line file and over-60-line function');
  });

  it('connects runtime failures to the established Either flow', () => {
    const canonicalStyle = readRepo(canonicalStylePath);
    const humanGuide = readRepo('docs/repo-human-style-guide.md');

    expect(canonicalStyle).toContain('`Either<RuntimeFailure, T>`');
    expect(humanGuide).toContain('left includes `RuntimeFailure`');
  });

  it('defines data-only DTOs and linear workflow-stage records', () => {
    const canonicalStyle = readRepo(canonicalStylePath);
    const normalizedStyle = canonicalStyle.replace(/\s+/g, ' ');

    expectAll(normalizedStyle, [
      '`Dto` marks a readonly, data-only value',
      'operation, service, transport, persistence, or process boundary',
      'A DTO contains properties, not callbacks',
      '`XxxServiceDependencies`',
      'Provide a service dependency bundle once when creating the service',
      'immutable workflow-stage record',
      'immediate predecessor exactly once',
      'readonly input: InvoiceInputDto;',
      'readonly read: InvoiceRead;',
      'readonly computed: InvoiceComputed;',
      'interface InvoiceValidationFailure',
      'readonly issues: readonly InvoiceValidationIssue[];',
      'Either<InvoiceValidationFailure, InvoiceComputed>',
    ]);
    expect(canonicalStyle).not.toContain('InvoiceComputedDto');
    expect(canonicalStyle).not.toContain('ReadInvoiceInput');
  });
});

function readRepo(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readRepo(filePath));
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
  const normalized = haystack.replace(/\s+/g, ' ').trim();
  for (const needle of needles) {
    expect(normalized, needle).toContain(needle.replace(/\s+/g, ' ').trim());
  }
}
