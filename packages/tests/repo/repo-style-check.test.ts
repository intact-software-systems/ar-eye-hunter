import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  estimateCyclomaticComplexity,
  extractRouteHandlerRanges,
} from '../../../scripts/repo-style-check/factory-route-rules.mjs';
import {
  constructionRuleIds,
  scanConstructionRules,
} from '../../../scripts/repo-style-check/construction-rules.mjs';
import { isTestRunnerConfigFile } from '../../../scripts/repo-style-check/repository-scan.mjs';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/repo-style-check.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('repo style checker', () => {
  it('reports a callback that captures a service assigned after consumer construction', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer({ readService: () => service });',
          '  service = createService();',
          '  return { consumer, service };',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/service.*createConsumer.*2.*4/i),
      }),
    ]);
  });

  it('reports a callback that captures a sender bound after inbound construction', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let send!: Send;',
          '  const inbound = createInbound((message) => send(message));',
          '  const outbound = createOutbound();',
          '  send = outbound.send;',
          '  return { inbound, outbound };',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/send.*createInbound.*2.*5/i),
      }),
    ]);
  });

  it('does not report already-constructed or Promise callback dependencies as forward captures', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'const service = createService();',
          'const consumer = createConsumer({ readService: () => service });',
          '',
          'const emitter = createEmitter();',
          'const listener = createListener(() => emitter.emit());',
          '',
          'let resolveDone!: () => void;',
          'const done = new Promise<void>((resolve) => {',
          '  resolveDone = resolve;',
          '});',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([]);
  });

  it('parses forward-capture fixtures across supported TypeScript and MJS extensions', () => {
    const sources = [
      {
        file: 'runtime.tsx',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer({ readService: () => service });',
          '  service = createService();',
          '  return <Runtime consumer={consumer} />;',
          '}',
        ].join('\n'),
      },
      {
        file: 'runtime.mts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer({ readService: () => service });',
          '  service = createService();',
          '  return { consumer, service };',
          '}',
        ].join('\n'),
      },
      {
        file: 'runtime.cts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer({ readService: () => service });',
          '  service = createService();',
          '  return { consumer, service };',
          '}',
        ].join('\n'),
      },
      {
        file: 'runtime.mjs',
        raw: [
          'export function createRuntime() {',
          '  let service;',
          '  const consumer = createConsumer({ readService: () => service });',
          '  service = createService();',
          '  return { consumer, service };',
          '}',
        ].join('\n'),
      },
    ];

    for (const source of sources) {
      expect(scanConstructionRules(source, { details: false })).toContainEqual(
        expect.objectContaining({ ruleId: constructionRuleIds.forwardCapture }),
      );
    }
  });

  it('preserves runtime references and construction callees inside TypeScript wrappers', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let asserted!: Service;',
          '  let nonNull!: Service;',
          '  let satisfied!: Service;',
          '  let calleeWrapped!: Service;',
          '  const first = createConsumer(() => (asserted as Service).run());',
          '  const second = createConsumer(() => nonNull!.run());',
          '  const third = createConsumer(() => (satisfied satisfies Service).run());',
          '  const fourth = (createConsumer as Factory)(() => calleeWrapped);',
          '  asserted = createService();',
          '  nonNull = createService();',
          '  satisfied = createService();',
          '  calleeWrapped = createService();',
          '  return { first, second, third, fourth };',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/asserted/) }),
      expect.objectContaining({ message: expect.stringMatching(/nonNull/) }),
      expect.objectContaining({ message: expect.stringMatching(/satisfied/) }),
      expect.objectContaining({ message: expect.stringMatching(/calleeWrapped/) }),
    ]);
  });

  it('recognizes a pass-through call returned through a TypeScript wrapper', () => {
    const findings = scanConstructionRules(
      {
        file: 'adapter.ts',
        raw: [
          'function forward(input: Input): Output {',
          '  return target(input) as Output;',
          '}',
        ].join('\n'),
      },
      { details: true },
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: constructionRuleIds.passThrough,
        message: expect.stringMatching(/forward/),
      }),
    );
  });

  it('treats a callback catch parameter as a local shadow', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer(() => {',
          '    try {',
          '      return read();',
          '    } catch (service) {',
          '      return service;',
          '    }',
          '  });',
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([]);
  });

  it('keeps a catch parameter shadow limited to its lexical scope', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer(() => {',
          '    try {',
          '      read();',
          '    } catch (service) {',
          '      report(service);',
          '    }',
          '    return service;',
          '  });',
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/service.*11/),
      }),
    ]);
  });

  it('uses a destructuring assignment as a binding value source', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer(() => service);',
          '  ({ service } = createServices());',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/service.*4/),
      }),
    ]);
  });

  it('does not declare an object-pattern property key as a callback binding', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime(config: Config) {',
          '  let service!: Service;',
          '  const consumer = createConsumer(() => {',
          '    const { service: alias } = config;',
          '    return service ?? alias;',
          '  });',
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/service.*7/),
      }),
    ]);
  });

  it('treats a callback-local class declaration as a local shadow', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer(() => {',
          '    class service {}',
          '    return service;',
          '  });',
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([]);
  });

  it('treats a named class expression identifier as class-local', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer(() => {',
          '    const LocalService = class service {};',
          '    return LocalService;',
          '  });',
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([]);
  });

  it('gives a private class method its own function-like scope', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer(() => {',
          '    class Consumer {',
          '      #read(service: Service) {',
          '        const reader = createReader(() => service);',
          '        return reader;',
          '      }',
          '    }',
          '    return Consumer;',
          '  });',
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([]);
  });

  it('treats a later function declaration as initialized with its lexical scope', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  const consumer = createConsumer(() => service());',
          '  function service() {',
          '    return createService();',
          '  }',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([]);
  });

  it('treats a runtime TypeScript enum declaration as a lexical binding', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer(() => {',
          '    enum service { Ready }',
          '    return service.Ready;',
          '  });',
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([]);
  });

  it('does not attribute a nested call callback to an outer construction call', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime(emitter: Emitter) {',
          '  let service!: Service;',
          "  const consumer = createConsumer(emitter.on('ready', () => service));",
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([]);
  });

  it('excludes object methods and array-only descendants from callback depth', () => {
    const findings = scanConstructionRules(
      {
        file: 'callbacks.ts',
        raw: [
          'createOuter({',
          '  register() {',
          '    return createMiddle(() => createInner(() => value));',
          '  },',
          '});',
          'createOuter([() => createMiddle([() => createInner([() => value])])]);',
        ].join('\n'),
      },
      { details: true },
    );

    expect(findings).not.toContainEqual(
      expect.objectContaining({ ruleId: constructionRuleIds.nestedCallbackDepth }),
    );
  });

  it('recognizes pass-through callables with stable assignment names', () => {
    const findings = scanConstructionRules(
      {
        file: 'adapter.ts',
        raw: [
          'let assignedArrow: (input: Input) => Output;',
          'assignedArrow = (input: Input) => target(input);',
          'const assignedFunction = function namedForward(input: Input) {',
          '  return target(input);',
          '};',
        ].join('\n'),
      },
      { details: true },
    );

    expect(findings).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/assignedArrow/) }),
      expect.objectContaining({ message: expect.stringMatching(/assignedFunction/) }),
    ]);
  });

  it('classifies an optional construction call by its terminal callee name', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.ts',
        raw: [
          'export function createRuntime() {',
          '  let service!: Service;',
          '  const consumer = createConsumer?.(() => service);',
          '  service = createService();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/service.*createConsumer/),
      }),
    ]);
  });

  it('keeps construction detail findings opt-in and excludes detail-rule near misses', () => {
    const source = {
      file: 'construction-details.ts',
      raw: [
        'function createDetails() {',
        '  let value!: Value;',
        '  return createOuter(() => createMiddle(() => createInner(() => value)));',
        '}',
        '',
        'function createTwoBoundaryNearMiss() {',
        '  return createOuter(() => createMiddle(() => target()));',
        '}',
        '',
        'function forward(first: First, second: Second) {',
        '  return target(first, second);',
        '}',
        '',
        'async function forwardAsync(input: Input) {',
        '  return await target(input);',
        '}',
        '',
        'const forwardArrow = (input: Input) => target(input);',
        '',
        'const adapter = {',
        '  forwardMethod(input: Input) {',
        '    return target(input);',
        '  },',
        '};',
        '',
        'function reorder(first: First, second: Second) {',
        '  return target(second, first);',
        '}',
        '',
        'function transform(input: Input) {',
        '  return target(normalize(input));',
        '}',
        '',
        'function logThenForward(input: Input) {',
        '  log(input);',
        '  return target(input);',
        '}',
      ].join('\n'),
    };

    const defaultFindings = scanConstructionRules(source, { details: false });
    const detailFindings = scanConstructionRules(source, { details: true });

    expect(defaultFindings).not.toContainEqual(
      expect.objectContaining({ ruleId: constructionRuleIds.definiteAssignment }),
    );
    expect(defaultFindings).not.toContainEqual(
      expect.objectContaining({ ruleId: constructionRuleIds.nestedCallbackDepth }),
    );
    expect(defaultFindings).not.toContainEqual(
      expect.objectContaining({ ruleId: constructionRuleIds.passThrough }),
    );
    expect(detailFindings).toContainEqual(
      expect.objectContaining({ ruleId: constructionRuleIds.definiteAssignment }),
    );
    const nestedCallbackFindings = detailFindings.filter(
      (finding) => finding.ruleId === constructionRuleIds.nestedCallbackDepth,
    );
    const passThroughFindings = detailFindings.filter(
      (finding) => finding.ruleId === constructionRuleIds.passThrough,
    );

    expect(nestedCallbackFindings).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/callback depth.*3.*review/i),
      }),
    ]);
    expect(passThroughFindings).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/forward/) }),
      expect.objectContaining({ message: expect.stringMatching(/forwardAsync/) }),
      expect.objectContaining({ message: expect.stringMatching(/forwardArrow/) }),
      expect.objectContaining({ message: expect.stringMatching(/forwardMethod/) }),
    ]);
  });

  it('warns for optional command fields even when a decoder supplies defaults', () => {
    const fixtureRoot = createFixture({
      'command.ts': [
        'interface CreateThingCommand {',
        '  readonly mode?: string;',
        '}',
        '',
        'function toCreateThingCommand(mode?: string): CreateThingCommand {',
        "  return { mode: mode ?? 'default' };",
        '}',
      ].join('\n'),
    });

    expect(runChecker(fixtureRoot)).toContain(
      'Command model CreateThingCommand contains optional fields',
    );
  });

  it('keeps plain-object type guidance disabled unless explicitly requested', () => {
    const fixtureRoot = createFixture({
      'contract.ts': ['type Thing = {', '  readonly value: string;', '};'].join('\n'),
    });

    expect(runChecker(fixtureRoot)).not.toContain('plain object contract');
    expect(runChecker(fixtureRoot, '--object-interfaces')).toContain('plain object contract');
  });

  it('keeps output-contract naming disabled unless explicitly requested', () => {
    const fixtureRoot = createFixture({
      'computed.ts': ['function computeThing() {', '  return { first: 1, second: 2 };', '}'].join(
        '\n',
      ),
    });

    expect(runChecker(fixtureRoot)).not.toContain('without an explicit output contract');
    expect(runChecker(fixtureRoot, '--output-contracts')).toContain(
      'without an explicit output contract',
    );
  });

  it('warns for an inline object return type when output checks are requested', () => {
    const fixtureRoot = createFixture({
      'computed.ts': [
        'function computeThing(): { first: number; second: number } {',
        '  return { first: 1, second: 2 };',
        '}',
      ].join('\n'),
    });

    expect(runChecker(fixtureRoot, '--output-contracts')).toContain('Function computeThing');
  });

  it('warns for an inline object inside an async return type', () => {
    const fixtureRoot = createFixture({
      'computed.ts': [
        'async function computeThing(): Promise<{ first: number; second: number }> {',
        '  return { first: 1, second: 2 };',
        '}',
      ].join('\n'),
    });

    expect(runChecker(fixtureRoot, '--output-contracts')).toContain('Function computeThing');
  });

  it('does not report unknown when the word only appears in a string', () => {
    const fixtureRoot = createFixture({
      'message.ts': "const message = 'Normalize unknown values at the boundary.';",
    });

    expect(runChecker(fixtureRoot)).toContain('PASS (no issues found in this run)');
  });

  it('counts an else-if branch once in estimated cyclomatic complexity', () => {
    const fixtureRoot = createFixture({
      'route.ts': [
        "app.get('/thing', () => {",
        '  if (value === 1) return 1;',
        '  else if (value === 2) return 2;',
        '  else if (value === 3) return 3;',
        '  else if (value === 4) return 4;',
        '  else if (value === 5) return 5;',
        '  else if (value === 6) return 6;',
        '  else if (value === 7) return 7;',
        '  return 0;',
        '});',
      ].join('\n'),
    });

    expect(runChecker(fixtureRoot)).not.toContain('has complexity');
  });

  it('counts a catch block that omits the error binding', () => {
    expect(estimateCyclomaticComplexity('try {} catch {}')).toBe(2);
  });

  it('does not attach an expression-bodied route to the next block handler', () => {
    const source = [
      "app.get('/short', async (context) => context.json({ ok: true }));",
      "app.post('/long', async () => {",
      '  return response;',
      '});',
    ].join('\n');

    expect(extractRouteHandlerRanges(source)).toHaveLength(1);
  });

  it('excludes generated declaration files from production warnings', () => {
    const generatedLines = Array.from(
      { length: 450 },
      (_, index) => `export interface Generated${index} { readonly value: string; }`,
    );
    const fixtureRoot = createFixture({
      'schema.generated.d.ts': generatedLines.join('\n'),
    });

    expect(runChecker(fixtureRoot)).toContain('PASS (no issues found in this run)');
  });

  it('excludes test and mock paths from production warnings', () => {
    const longLine = `const value = '${'x'.repeat(110)}';`;
    const fixtureRoot = createFixture({
      'tests/example.ts': longLine,
      'mocks/example.ts': longLine,
    });

    expect(runChecker(fixtureRoot)).toContain('PASS (no issues found in this run)');
  });

  it('does not include excluded sources in layout directory counts', () => {
    const fixtureRoot = createFixture({
      ...Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          `auth-command-${index}.ts`,
          `export const authCommand${index} = ${index};`,
        ]),
      ),
      'schema.generated.ts': 'export const generatedSchema = true;',
      ...Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [
          `tests/test-command-${index}.ts`,
          `export const testCommand${index} = ${index};`,
        ]),
      ),
      ...Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [
          `mocks/mock-command-${index}.ts`,
          `export const mockCommand${index} = ${index};`,
        ]),
      ),
      ...Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [
          `generated/generated-command-${index}.ts`,
          `export const generatedCommand${index} = ${index};`,
        ]),
      ),
    });

    const result = runChecker(fixtureRoot, '--layout-only');

    expect(result).not.toContain('[layout.directory-density]');
    expect(result).not.toContain('[layout.feature-prefix-cluster]');
    expect(result).toContain('layout.directory-density=0');
    expect(result).toContain('layout.feature-prefix-cluster=0');
  });

  it('excludes test-runner configuration files from production warnings', () => {
    const longLine = `const value = '${'x'.repeat(110)}';`;
    const fixtureRoot = createFixture({
      'playwright.full-stack.config.ts': longLine,
      'vitest.config.ts': longLine,
      'jest.unit.config.ts': longLine,
      'cypress.config.ts': longLine,
    });

    expect(runChecker(fixtureRoot)).toContain('PASS (no issues found in this run)');
    expect(readFileSync(path.join(repoRoot, 'docs/repo-human-style-guide.md'), 'utf8')).toMatch(
      /test-runner\s+configuration files/,
    );
  });

  it('classifies test-runner configuration filenames without regex backtracking', () => {
    expect(isTestRunnerConfigFile('playwright.full-stack.config.ts')).toBe(true);
    expect(isTestRunnerConfigFile('vitest.config.mts')).toBe(true);
    expect(isTestRunnerConfigFile('jest-unit.config.cts')).toBe(true);
    expect(isTestRunnerConfigFile('cypress.config.js')).toBe(true);
    expect(isTestRunnerConfigFile(`jest-${'--'.repeat(32)}!.config.ts`)).toBe(false);
    expect(isTestRunnerConfigFile('jest-.unit.config.ts')).toBe(false);
    expect(isTestRunnerConfigFile('not-jest.config.ts')).toBe(false);
  });

  it('warns when an optional factory hides several defaults', () => {
    const fixtureRoot = createFixture({
      'factory.ts': [
        'interface CreateServerOptions {',
        '  readonly port?: number;',
        '  readonly host?: string;',
        '  readonly secure?: boolean;',
        '}',
        '',
        'export function createServer(options: CreateServerOptions = {}) {',
        '  const port = options.port ?? 8080;',
        "  const host = options.host ?? 'localhost';",
        '  return { port, host };',
        '}',
      ].join('\n'),
    });

    expect(runChecker(fixtureRoot)).toContain(
      'Prefer required factory input and createDefaultServer()',
    );
  });

  it('warns for hidden factory defaults regardless of the input type suffix', () => {
    const fixtureRoot = createFixture({
      'factory.ts': [
        'interface CreateServerInput {',
        '  readonly port?: number;',
        '  readonly host?: string;',
        '  readonly secure?: boolean;',
        '}',
        '',
        'export function createServer(input: CreateServerInput = {}) {',
        '  const port = input.port ?? 8080;',
        "  const host = input.host ?? 'localhost';",
        '  return { port, host };',
        '}',
      ].join('\n'),
    });

    expect(runChecker(fixtureRoot)).toContain(
      'Prefer required factory input and createDefaultServer()',
    );
  });

  it('keeps the checker implementation within its own file limits', () => {
    const checkerFiles = [
      'scripts/check-changed-repo-style.mjs',
      'scripts/repo-style-check.mjs',
      'scripts/repo-style-check/contract-rules.mjs',
      'scripts/repo-style-check/construction-rules.mjs',
      'scripts/repo-style-check/construction-scope-model.mjs',
      'scripts/repo-style-check/factory-route-rules.mjs',
      'scripts/repo-style-check/function-analysis.mjs',
      'scripts/repo-style-check/layout-rules.mjs',
      'scripts/repo-style-check/repository-scan.mjs',
      'scripts/repo-style-check/source-text.mjs',
    ];

    for (const relativePath of checkerFiles) {
      const lines = readFileSync(path.join(repoRoot, relativePath), 'utf8').split('\n');
      const overlongLines = lines
        .map((text, index) => ({ line: index + 1, length: text.length }))
        .filter((line) => line.length > 100);

      expect(lines.length, relativePath).toBeLessThanOrEqual(400);
      expect(overlongLines, relativePath).toEqual([]);
    }

    expect(runChecker(path.join(repoRoot, 'scripts/repo-style-check'))).toContain(
      'PASS (no issues found in this run)',
    );
  });

  it('reports conservative layout warnings by default and isolates them on request', () => {
    const fixtureRoot = createFixture({
      ...Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [
          `auth-command-${index}.ts`,
          index === 0
            ? `export const authCommand${index} = '${'x'.repeat(110)}';`
            : `export const authCommand${index} = ${index};`,
        ]),
      ),
    });

    const layoutOnly = executeChecker(fixtureRoot, '--layout-only');
    expect(layoutOnly.status).toBe(0);
    expect(layoutOnly.stdout).toContain('[layout.directory-density]');
    expect(layoutOnly.stdout).not.toContain('Line 1 exceeds');

    const defaultRun = executeChecker(fixtureRoot);
    expect(defaultRun.status).toBe(0);
    expect(defaultRun.stdout).toContain('[layout.directory-density]');
    expect(defaultRun.stdout).toContain('Line 1 exceeds');
  });

  it('adds detailed layout warnings only when requested', () => {
    const fixtureRoot = createFixture({
      'primary-name.ts': 'export function mismatchedName() {}',
    });

    const detailsOff = runChecker(fixtureRoot, '--layout-only');
    expect(detailsOff).not.toContain('layout.primary-export-name');

    const detailsOn = runChecker(fixtureRoot, '--layout-only', '--layout-details');
    expect(detailsOn).toContain('[layout.primary-export-name]');
    expect(detailsOn).toContain('layout.primary-export-name=1');
  });

  it('keeps mjs in file checks without projecting it into layout checks', () => {
    const fixtureRoot = createFixture(
      Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [
          `auth-command-${index}.mjs`,
          index === 0 ? `export const value = '${'x'.repeat(110)}';` : 'export const value = 1;',
        ]),
      ),
    );

    expect(runChecker(fixtureRoot)).toContain('Line 1 exceeds');

    const layoutOnly = runChecker(fixtureRoot, '--layout-only');
    expect(layoutOnly).not.toContain('[layout.directory-density]');
    expect(layoutOnly).not.toContain('[layout.feature-prefix-cluster]');
    expect(layoutOnly).toContain('layout.directory-density=0');
    expect(layoutOnly).toContain('layout.feature-prefix-cluster=0');
  });

  it('caps displayed warnings while preserving full finding and affected-item counts', () => {
    const files = {
      ...Object.fromEntries(
        Array.from({ length: 205 }, (_, index) => [
          `feature-${index}/long-line.ts`,
          `const value${index} = '${'x'.repeat(110)}';`,
        ]),
      ),
      'BadOne.ts': 'export const badOne = true;',
      'BadTwo.ts': 'export const badTwo = true;',
      'BadThree.ts': 'export const badThree = true;',
    };
    const result = runChecker(createFixture(files));

    expect(result.split('\n').filter((line) => line.startsWith('WARN: '))).toHaveLength(200);
    expect(result).toContain('6 additional findings not displayed');
    expect(result).toContain('Summary: 206 non-blocking issues found');
    expect(result).toContain('layout.filename-style=3');
  });

  it('keeps warnings non-blocking and rejects unavailable strict mode', () => {
    const fixtureRoot = createFixture({
      'long-line.ts': `const value = '${'x'.repeat(110)}';`,
    });

    expect(executeChecker(fixtureRoot).status).toBe(0);
    const strictResult = executeChecker(fixtureRoot, '--strict');
    expect(strictResult.status).toBe(1);
    expect(`${strictResult.stdout}${strictResult.stderr}`).toContain(
      'strict mode is not available',
    );
  });
});

function createFixture(files: Readonly<Record<string, string>>): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'repo-style-fixture-'));
  fixtureRoots.push(fixtureRoot);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }

  return fixtureRoot;
}

function runChecker(fixtureRoot: string, ...extraArgs: string[]): string {
  const result = executeChecker(fixtureRoot, ...extraArgs);

  expect(result.status, result.stderr).toBe(0);
  return `${result.stdout}${result.stderr}`;
}

function executeChecker(fixtureRoot: string, ...extraArgs: string[]) {
  return spawnSync(process.execPath, [checkerPath, '--root', fixtureRoot, ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}
