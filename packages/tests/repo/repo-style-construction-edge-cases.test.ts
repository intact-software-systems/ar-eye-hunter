import { describe, expect, it } from 'vitest';

import {
  constructionRuleIds,
  scanConstructionRules,
} from '../../../scripts/repo-style-check/construction-rules.mjs';

describe('repo style construction checker edge cases', () => {
  it('ignores callback syntax that is evaluated as a key or spread source', () => {
    const findings = scanTypeScript([
      'export function createRuntime() {',
      '  let service!: Service;',
      "  const keyed = createConsumer({ [() => service]: 'reader' });",
      '  const objectSpread = createConsumer({ ...(() => service) });',
      '  const argumentSpread = createConsumer(...(() => service));',
      '  service = createService();',
      '  return { keyed, objectSpread, argumentSpread };',
      '}',
    ]);

    expect(findings).toEqual([]);
  });

  it('discovers callback values selected by branches and nested object spreads', () => {
    const findings = scanTypeScript([
      'export function createRuntime(enabled: boolean) {',
      '  let conditionalService!: Service;',
      '  let logicalService!: Service;',
      '  let spreadService!: Service;',
      '  const conditional = createConsumer(enabled ? () => conditionalService : undefined);',
      '  const logical = createConsumer(enabled && (() => logicalService));',
      '  const spread = createConsumer({ ...{ readService: () => spreadService } });',
      '  conditionalService = createService();',
      '  logicalService = createService();',
      '  spreadService = createService();',
      '  return { conditional, logical, spread };',
      '}',
    ]);

    expect(findings).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/conditionalService.*8/) }),
      expect.objectContaining({ message: expect.stringMatching(/logicalService.*9/) }),
      expect.objectContaining({ message: expect.stringMatching(/spreadService.*10/) }),
    ]);
  });

  it('discovers callback-bearing object literals selected as spread sources', () => {
    const findings = scanTypeScript([
      'export function createRuntime(enabled: boolean) {',
      '  let conditionalService!: Service;',
      '  let logicalService!: Service;',
      '  const conditional = createConsumer({',
      '    ...(enabled ? { read: () => conditionalService } : {}),',
      '  });',
      '  const logical = createConsumer({',
      '    ...(enabled && { read: () => logicalService }),',
      '  });',
      '  conditionalService = createService();',
      '  logicalService = createService();',
      '  return { conditional, logical };',
      '}',
    ]);

    expect(findings).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/conditionalService.*10/) }),
      expect.objectContaining({ message: expect.stringMatching(/logicalService.*11/) }),
    ]);
  });

  it('reports self-capture until a declaration initializer or assignment RHS completes', () => {
    const findings = scanTypeScript([
      'export function createDeclaredConsumer() {',
      '  const consumer = createConsumer(() => consumer);',
      '  return consumer;',
      '}',
      '',
      'export function createAssignedConsumer() {',
      '  let consumer: Consumer;',
      '  consumer = createConsumer(() => consumer);',
      '  return consumer;',
      '}',
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/consumer.*createConsumer.*2.*2/i),
      }),
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/consumer.*createConsumer.*7.*8/i),
      }),
    ]);
  });

  it('ignores label and non-computed class-field identifiers', () => {
    const findings = scanTypeScript([
      'export function createRuntime() {',
      '  let service!: Service;',
      '  const consumer = createConsumer(() => {',
      '    service: for (const item of items) {',
      '      if (item.skip) {',
      '        continue service;',
      '      }',
      '      break service;',
      '    }',
      '    class Consumer {',
      '      service = true;',
      '      #service = true;',
      '    }',
      '    return Consumer;',
      '  });',
      '  service = createService();',
      '  return consumer;',
      '}',
    ]);

    expect(findings).toEqual([]);
  });

  it('ignores MetaProperty identifiers that share outer binding names', () => {
    const findings = scanTypeScript([
      'export function createRuntime() {',
      '  let target!: Target;',
      '  let meta!: Meta;',
      '  const consumer = createConsumer(() => [new.target, import.meta]);',
      '  target = createTarget();',
      '  meta = createMeta();',
      '  return consumer;',
      '}',
    ]);

    expect(findings).toEqual([]);
  });

  it('preserves runtime references in computed class-field keys', () => {
    const findings = scanTypeScript([
      'export function createRuntime() {',
      '  let service!: Service;',
      '  const consumer = createConsumer(() => {',
      '    class Consumer {',
      '      [service] = true;',
      '    }',
      '    return Consumer;',
      '  });',
      '  service = createService();',
      '  return consumer;',
      '}',
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/service.*createConsumer.*2.*9/i),
      }),
    ]);
  });

  it('reports a TSX component tag that is assigned after construction', () => {
    const findings = scanConstructionRules(
      {
        file: 'runtime.tsx',
        raw: [
          'export function createRuntime() {',
          '  let RuntimeView!: ComponentType;',
          '  const consumer = createConsumer(() => <RuntimeView />);',
          '  RuntimeView = createRuntimeView();',
          '  return consumer;',
          '}',
        ].join('\n'),
      },
      { details: false },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/RuntimeView.*createConsumer.*2.*4/i),
      }),
    ]);
  });

  it('uses later for-of and for-in targets as binding value sources', () => {
    const findings = scanTypeScript([
      'export function createRuntime() {',
      '  let iteratedService!: Service;',
      '  let keyedService!: string;',
      '  const iterated = createConsumer(() => iteratedService);',
      '  const keyed = createConsumer(() => keyedService);',
      '  for (iteratedService of services) {',
      '    use(iteratedService);',
      '  }',
      '  for (keyedService in servicesByKey) {',
      '    use(keyedService);',
      '  }',
      '  return { iterated, keyed };',
      '}',
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/iteratedService.*createConsumer.*2.*6/i),
      }),
      expect.objectContaining({
        message: expect.stringMatching(/keyedService.*createConsumer.*3.*9/i),
      }),
    ]);
  });

  it('uses an initialized var redeclaration as the first binding value source', () => {
    const findings = scanTypeScript([
      'export function createRuntime() {',
      '  var service: Service;',
      '  const consumer = createConsumer(() => service);',
      '  var service = createService();',
      '  return consumer;',
      '}',
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: constructionRuleIds.forwardCapture,
        message: expect.stringMatching(/service.*createConsumer.*2.*4/i),
      }),
    ]);
  });
});

function scanTypeScript(lines: readonly string[]) {
  return scanConstructionRules({ file: 'runtime.ts', raw: lines.join('\n') }, { details: false });
}
