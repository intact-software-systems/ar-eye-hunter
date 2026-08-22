import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { constructionRuleIds, scanConstructionRules } from '../../../scripts/repo-style-check/construction-rules.mjs';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/repo-style-check.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('repo style construction checker', () => {
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
                    '}'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/service.*createConsumer.*2.*4/i)
            })
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
                    '}'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/send.*createInbound.*2.*5/i)
            })
        ]);
    });

    it(
        'does not report already-constructed or Promise callback dependencies ' + 'as forward captures',
        () => {
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
                        '});'
                    ].join('\n')
                },
                { details: false }
            );

            expect(findings).toEqual([]);
        }
    );

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
                    '}'
                ].join('\n')
            },
            {
                file: 'runtime.mts',
                raw: [
                    'export function createRuntime() {',
                    '  let service!: Service;',
                    '  const consumer = createConsumer({ readService: () => service });',
                    '  service = createService();',
                    '  return { consumer, service };',
                    '}'
                ].join('\n')
            },
            {
                file: 'runtime.cts',
                raw: [
                    'export function createRuntime() {',
                    '  let service!: Service;',
                    '  const consumer = createConsumer({ readService: () => service });',
                    '  service = createService();',
                    '  return { consumer, service };',
                    '}'
                ].join('\n')
            },
            {
                file: 'runtime.mjs',
                raw: [
                    'export function createRuntime() {',
                    '  let service;',
                    '  const consumer = createConsumer({ readService: () => service });',
                    '  service = createService();',
                    '  return { consumer, service };',
                    '}'
                ].join('\n')
            }
        ];

        for (const source of sources) {
            expect(scanConstructionRules(source, { details: false })).toContainEqual(
                expect.objectContaining({ ruleId: constructionRuleIds.forwardCapture })
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
                    '}'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({ message: expect.stringMatching(/asserted/) }),
            expect.objectContaining({ message: expect.stringMatching(/nonNull/) }),
            expect.objectContaining({ message: expect.stringMatching(/satisfied/) }),
            expect.objectContaining({ message: expect.stringMatching(/calleeWrapped/) })
        ]);
    });

    it('recognizes a pass-through call returned through a TypeScript wrapper', () => {
        const findings = scanConstructionRules(
            {
                file: 'adapter.ts',
                raw: [
                    'function forward(input: Input): Output {',
                    '  return target(input) as Output;',
                    '}'
                ].join('\n')
            },
            { details: true }
        );

        expect(findings).toContainEqual(
            expect.objectContaining({
                ruleId: constructionRuleIds.passThrough,
                message: expect.stringMatching(/forward/)
            })
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
                    '}'
                ].join('\n')
            },
            { details: false }
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
                    '}'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/service.*11/)
            })
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
                    '}'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/service.*4/)
            })
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
                    '}'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/service.*7/)
            })
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
                    '}'
                ].join('\n')
            },
            { details: false }
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
                    '}'
                ].join('\n')
            },
            { details: false }
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
                    '}'
                ].join('\n')
            },
            { details: false }
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
                    '}'
                ].join('\n')
            },
            { details: false }
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
                    '}'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([]);
    });

    it('resolves a runtime namespace var before an outer binding', () => {
        const findings = scanConstructionRules(
            {
                file: 'runtime.ts',
                raw: [
                    'let service: Service;',
                    'namespace Runtime {',
                    '  var service = createNamespaceService();',
                    '  export const consumer = createConsumer(() => service);',
                    '}',
                    'service = createRootService();',
                    'export { Runtime };'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([]);
    });

    it('keeps a runtime namespace var out of the enclosing scope', () => {
        const findings = scanConstructionRules(
            {
                file: 'runtime.ts',
                raw: [
                    'namespace Runtime {',
                    '  var service = createNamespaceService();',
                    '}',
                    'const consumer = createConsumer(() => service);',
                    'let service: Service;',
                    'service = createRootService();',
                    'export { consumer };'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/service.*createConsumer.*5.*6/i)
            })
        ]);
    });

    it('ignores ambient namespace vars when resolving runtime bindings', () => {
        const findings = scanConstructionRules(
            {
                file: 'runtime.ts',
                raw: [
                    'declare namespace Contracts {',
                    '  var service: Service;',
                    '}',
                    'const consumer = createConsumer(() => service);',
                    'const service = createService();',
                    'export { consumer };'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/service.*createConsumer.*5.*5/i)
            })
        ]);
    });

    it('keeps a nested namespace declaration out of the enclosing runtime scope', () => {
        const findings = scanConstructionRules(
            {
                file: 'runtime.ts',
                raw: [
                    'namespace Outer {',
                    '  export namespace service {}',
                    '}',
                    'const consumer = createConsumer(() => service);',
                    'let service: Service;',
                    'service = createService();',
                    'export { consumer };'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/service.*createConsumer.*5.*6/i)
            })
        ]);
    });

    it('resolves an enum inside a namespace before an outer binding', () => {
        const findings = scanConstructionRules(
            {
                file: 'runtime.ts',
                raw: [
                    'let service: Service;',
                    'namespace Outer {',
                    '  export enum service { Ready }',
                    '  export const consumer = createConsumer(() => service);',
                    '}',
                    'service = createService();',
                    'export { Outer };'
                ].join('\n')
            },
            { details: false }
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
                    '  const consumer = createConsumer(emitter.on(\'ready\', () => service));',
                    '  service = createService();',
                    '  return consumer;',
                    '}'
                ].join('\n')
            },
            { details: false }
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
                    'createOuter([() => createMiddle([() => createInner([() => value])])]);'
                ].join('\n')
            },
            { details: true }
        );

        expect(findings).not.toContainEqual(
            expect.objectContaining({ ruleId: constructionRuleIds.nestedCallbackDepth })
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
                    '};'
                ].join('\n')
            },
            { details: true }
        );

        expect(findings).toEqual([
            expect.objectContaining({ message: expect.stringMatching(/assignedArrow/) }),
            expect.objectContaining({ message: expect.stringMatching(/assignedFunction/) })
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
                    '}'
                ].join('\n')
            },
            { details: false }
        );

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: constructionRuleIds.forwardCapture,
                message: expect.stringMatching(/service.*createConsumer/)
            })
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
                '}'
            ].join('\n')
        };

        const defaultFindings = scanConstructionRules(source, { details: false });
        const detailFindings = scanConstructionRules(source, { details: true });

        expect(defaultFindings).not.toContainEqual(
            expect.objectContaining({ ruleId: constructionRuleIds.definiteAssignment })
        );
        expect(defaultFindings).not.toContainEqual(
            expect.objectContaining({ ruleId: constructionRuleIds.nestedCallbackDepth })
        );
        expect(defaultFindings).not.toContainEqual(
            expect.objectContaining({ ruleId: constructionRuleIds.passThrough })
        );
        expect(detailFindings).toContainEqual(
            expect.objectContaining({ ruleId: constructionRuleIds.definiteAssignment })
        );
        const nestedCallbackFindings = detailFindings.filter(
            (finding) => finding.ruleId === constructionRuleIds.nestedCallbackDepth
        );
        const passThroughFindings = detailFindings.filter(
            (finding) => finding.ruleId === constructionRuleIds.passThrough
        );

        expect(nestedCallbackFindings).toEqual([
            expect.objectContaining({
                message: expect.stringMatching(/callback depth.*3.*review/i)
            })
        ]);
        expect(passThroughFindings).toEqual([
            expect.objectContaining({ message: expect.stringMatching(/forward/) }),
            expect.objectContaining({ message: expect.stringMatching(/forwardAsync/) }),
            expect.objectContaining({ message: expect.stringMatching(/forwardArrow/) }),
            expect.objectContaining({ message: expect.stringMatching(/forwardMethod/) })
        ]);
    });

    it('reports forward captures through the default warning checker', () => {
        const fixtureRoot = createFixture({
            'runtime.ts': [
                'export function createRuntime() {',
                '  let service!: Service;',
                '  const consumer = createConsumer(() => service);',
                '  service = createService();',
                '  return consumer;',
                '}'
            ].join('\n')
        });

        expect(runChecker(fixtureRoot)).toContain('[construction.forward-capture]');
    });

    it('adds construction detail warnings only when requested', () => {
        const fixtureRoot = createFixture({
            'construction-details.ts': [
                'let value!: Value;',
                'value = createValue();',
                '',
                'function forward(input: Input): Output {',
                '  return target(input);',
                '}'
            ].join('\n')
        });

        const detailsOff = runChecker(fixtureRoot);
        expect(detailsOff).not.toContain('[construction.definite-assignment]');
        expect(detailsOff).not.toContain('[abstraction.pass-through]');

        const detailsOn = runChecker(fixtureRoot, '--construction-details');
        expect(detailsOn).toContain('[construction.definite-assignment]');
        expect(detailsOn).toContain('[abstraction.pass-through]');
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
        encoding: 'utf8'
    });
}
