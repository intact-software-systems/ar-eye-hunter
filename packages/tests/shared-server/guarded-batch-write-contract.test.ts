import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import * as ts from 'typescript/unstable/ast';
import { afterAll, describe, expect, it } from 'vitest';

import {
  callCallback,
  callName,
  findCall,
  findForOfAncestor,
  findFunction,
  findIf,
  findOutboxEffectPush,
  findSingleReturn,
  findVariableBinding,
  hasKind,
  isAwaited,
  ownedCalls,
  within,
} from './guarded-batch-contract-test-support.ts';

interface GuardedBatchContract {
  readonly family: string;
  readonly file: string;
  readonly writer: string;
  readonly materializer: string;
  readonly materializerArguments: readonly string[];
  readonly validationArgument: string;
  readonly appendsGroupEvent: boolean;
}

const capabilityCondition = 'isRuntimeStateGuardedBatchRepositoryLike(transaction)';
const groupFile = 'packages/shared-server/rallar-system/services/group-state-guarded-batch.ts';
const topologyFile =
  'packages/shared-server/rallar-system/services/group-topology-management-service.ts';
const contracts: readonly GuardedBatchContract[] = [
  {
    family: 'group mutation',
    file: groupFile,
    writer: 'writeGroupMutation',
    materializer: 'materializeGroupStateGuardedBatch',
    materializerArguments: ['computed'],
    validationArgument: '{ guard: materializeGuard(computed), effects, }',
    appendsGroupEvent: true,
  },
  {
    family: 'topology config mutation',
    file: topologyFile,
    writer: 'writeTopologyConfigMutation',
    materializer: 'materializeTopologyConfigGuardedBatch',
    materializerArguments: ['runtime', 'computed'],
    validationArgument: `{
      guard: materializeGroupStateAuthorityGuard(
        computed.groupAuthorityGuard,
      ),
      effects,
    }`,
    appendsGroupEvent: false,
  },
];
const repoCompiler = openCompiler(contracts.map(({ file }) => absolute(file)));
afterAll(() => {
  repoCompiler.snapshot.dispose();
  repoCompiler.api.close();
});

describe('guarded batch write structural contract', () => {
  it.each(contracts)(
    '$family validates before begin and classifies the guarded result atomically',
    (contract) => assertGuardedBatchContract(contract),
  );

  it('still rejects a group fallback write before its legacy guard', () => {
    const beforeGuard =
      '    // Aggregate/session ownership is always the first database statement.';
    const fallbackTail = `    await new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite(
      materialized.outbox,
    );
    await repository.appendEvent(computed.event);
    return computed.receipt;`;
    const mutated = replaceOnce(
      replaceOnce(
        readRepo(groupFile),
        beforeGuard,
        `    await repository.appendEvent(computed.event);\n\n${beforeGuard}`,
      ),
      fallbackTail,
      `    await new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite(
      materialized.outbox,
    );
    return computed.receipt;`,
    );
    withFixture(mutated, (source) => {
      expect(() => assertGuardedBatchContract(contracts[0]!, source)).toThrow(
        /legacy guard before dependent writes/,
      );
    });
  });

  it.each([
    [
      'an unawaited guarded batch execution',
      'await transaction.executeGuardedBatch(materialized.batch)',
      'transaction.executeGuardedBatch(materialized.batch)',
      /executeGuardedBatch/,
    ],
    [
      'a bypassed pre-begin validation',
      'batch: validateRuntimeStateGuardedBatch({',
      'batch: acceptUncheckedBatch({',
      /validateRuntimeStateGuardedBatch/,
    ],
    [
      'validation without the materialized outbox effects',
      '      effects,',
      '      effects: [],',
      /validateRuntimeStateGuardedBatch/,
    ],
    [
      'a capable return before its group event append',
      `      await repository.appendEvent(computed.event);
      return computed.receipt;`,
      `      return computed.receipt;
      await repository.appendEvent(computed.event);`,
      /event append before return/,
    ],
  ] as const)('rejects %s', (_name, before, after, error) => {
    withFixture(replaceOnce(readRepo(groupFile), before, after), (source) => {
      expect(() => assertGuardedBatchContract(contracts[0]!, source)).toThrow(error);
    });
  });
});

function assertGuardedBatchContract(
  contract: GuardedBatchContract,
  provided?: ts.SourceFile,
): void {
  const source = provided ?? repoSource(contract.file);
  const writer = findFunction(source, contract.writer);
  const materializer = findCall(source, writer, {
    callee: contract.materializer,
    arguments: contract.materializerArguments,
    awaited: false,
  });
  expect(findVariableBinding(materializer, writer), contract.family).toBe('materialized');
  const begin = findCall(source, writer, { callee: 'runtime.begin', awaited: true });
  expect(materializer.pos, `${contract.family}: materialize before begin`).toBeLessThan(begin.pos);

  const materializerOwner = findFunction(source, contract.materializer);
  const outbox = findCall(source, materializerOwner, {
    callee: 'createStateMutationOutboxRecord',
    arguments: ['computed.outbox'],
    awaited: false,
  });
  const outboxEffect = findOutboxEffectPush(source, materializerOwner);
  const validation = findCall(source, materializerOwner, {
    callee: 'validateRuntimeStateGuardedBatch',
    arguments: [contract.validationArgument],
    awaited: false,
  });
  expect(outbox.pos, `${contract.family}: outbox before effect`).toBeLessThan(outboxEffect.pos);
  expect(outboxEffect.pos, `${contract.family}: effect included in validation`).toBeLessThan(
    validation.pos,
  );

  const transaction = callCallback(begin, source);
  const capability = findIf(transaction, capabilityCondition, source);
  const resultValidation = findCall(source, capability.thenStatement, {
    callee: 'validateRuntimeStateGuardedBatchResult',
    arguments: ['materialized.batch', 'await transaction.executeGuardedBatch(materialized.batch)'],
    awaited: false,
  });
  expect(findVariableBinding(resultValidation, transaction), contract.family).toBe('result');
  findCall(source, capability.thenStatement, {
    callee: 'transaction.executeGuardedBatch',
    arguments: ['materialized.batch'],
    awaited: true,
  });

  const guardConflict = findIf(transaction, "result.guard.status === 'conflict'", source);
  const applied = findIf(transaction, "effect.status === 'applied'", source);
  const outboxConflict = findIf(transaction, "effect.effectId === 'outbox'", source);
  expect(resultValidation.pos, `${contract.family}: classify after result validation`).toBeLessThan(
    guardConflict.pos,
  );
  expect(hasKind(guardConflict.thenStatement, ts.SyntaxKind.ThrowStatement)).toBe(true);
  expect(hasKind(applied.thenStatement, ts.SyntaxKind.ContinueStatement)).toBe(true);
  expect(hasKind(outboxConflict.thenStatement, ts.SyntaxKind.ThrowStatement)).toBe(true);
  const classification = findForOfAncestor(applied, transaction);
  const capableReturn = findSingleReturn(capability.thenStatement);
  expect(classification.end, `${contract.family}: classify before return`).toBeLessThanOrEqual(
    capableReturn.pos,
  );

  if (contract.appendsGroupEvent) {
    const append = findCall(source, capability.thenStatement, {
      callee: 'repository.appendEvent',
      arguments: ['computed.event'],
      awaited: true,
    });
    expect(classification.end, 'classify before event append').toBeLessThan(append.pos);
    expect(append.end, 'event append before return').toBeLessThanOrEqual(capableReturn.pos);
    assertLegacyGroupGuardOrder(source, transaction, capability);
  }
  findCall(source, transaction, {
    callee: 'new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite',
    arguments: ['materialized.outbox'],
    awaited: true,
  });
}

function assertLegacyGroupGuardOrder(
  source: ts.SourceFile,
  transaction: ts.FunctionLikeDeclaration,
  capability: ts.IfStatement,
): void {
  const calls = ownedCalls(transaction).filter(({ node }) => !within(node, capability));
  const guardNames = new Set([
    'insertGroup',
    'updateGroup',
    'insertPresence',
    'updatePresence',
    'deletePresence',
  ]);
  const dependentNames = new Set([
    'insertPresenceAdmission',
    'updatePresenceAdmission',
    'putMember',
    'insertPresenceSummary',
    'insertIdempotentGroupMutationReceipt',
    'insertForAuthoritativeWrite',
    'appendEvent',
  ]);
  const guards = calls.filter(({ name }) => guardNames.has(name));
  const dependent = calls.filter(({ name }) => dependentNames.has(name));
  expect(guards.length, 'legacy guards').toBeGreaterThan(0);
  expect(dependent.length, 'legacy dependent writes').toBeGreaterThan(0);
  expect(
    Math.max(...guards.map(({ node }) => node.pos)),
    'legacy guard before dependent writes',
  ).toBeLessThan(Math.min(...dependent.map(({ node }) => node.pos)));
  for (const guard of guards) {
    expect(isAwaited(guard.node), `${callName(guard.node)} awaited`).toBe(true);
  }
  void source;
}

function absolute(file: string): string {
  return path.join(process.cwd(), file);
}

function repoSource(file: string): ts.SourceFile {
  const source = repoCompiler.snapshot
    .getDefaultProjectForFile(absolute(file))
    ?.program.getSourceFile(absolute(file));
  expect(source, file).toBeDefined();
  return source!;
}

function withFixture(source: string, run: (source: ts.SourceFile) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'rallar-guarded-batch-contract-'));
  const file = path.join(directory, 'fixture.ts');
  let compiler: ReturnType<typeof openCompiler> | undefined;
  try {
    writeFileSync(file, source);
    compiler = openCompiler([file]);
    const parsed = compiler.snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
    expect(parsed, file).toBeDefined();
    run(parsed!);
  } finally {
    compiler?.snapshot.dispose();
    compiler?.api.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function openCompiler(openFiles: readonly string[]) {
  const api = new API();
  try {
    return { api, snapshot: api.updateSnapshot({ openFiles: [...openFiles] }) };
  } catch (error) {
    api.close();
    throw error;
  }
}

function readRepo(file: string): string {
  return readFileSync(absolute(file), 'utf8');
}

function replaceOnce(source: string, before: string, after: string): string {
  expect(source.split(before), before).toHaveLength(2);
  return source.replace(before, after);
}
