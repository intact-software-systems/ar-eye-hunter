import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  computeGovernanceDecisionId,
  decodeGovernanceDecisionRequest,
} from '../../../../scripts/governance-decisions/governance-decision-request.mjs';
import {
  createGovernanceDecisionReceipt,
  serializeGovernanceDecisionReceipt,
} from '../../../../scripts/governance-decisions/governance-decision-receipt.mjs';
import { toCanonicalJson } from '../../../../scripts/governance-decisions/canonical-json.mjs';

const expectedHeadOid = '1'.repeat(40);

describe('governance decision contracts', () => {
  it('recursively sorts object keys, preserves array order, and emits no newline', () => {
    expect(toCanonicalJson({ z: [{ b: 2, a: 1 }, 3], a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2},3]}',
    );
  });

  it('accepts only the exact common request keys and fixed repository authority', () => {
    const request = decodeGovernanceDecisionRequest(cancelRequest());

    expect(Object.keys(request)).toEqual([
      'schemaVersion',
      'operation',
      'repository',
      'defaultBranch',
      'expectedHeadOid',
      'force',
      'reason',
      'target',
      'payload',
    ]);
    expect(() => decodeGovernanceDecisionRequest({ ...cancelRequest(), actor: 'mallory' })).toThrow(
      'unsupported request keys: actor',
    );
    expect(() =>
      decodeGovernanceDecisionRequest({ ...cancelRequest(), repository: 'other/repository' }),
    ).toThrow('repository must be intact-software-systems/ar-eye-hunter');
    expect(() => decodeGovernanceDecisionRequest({ ...cancelRequest(), force: false })).toThrow(
      'force must be true',
    );
    expect(() =>
      decodeGovernanceDecisionRequest({ ...cancelRequest(), expectedHeadOid: 'A'.repeat(40) }),
    ).toThrow('expectedHeadOid must be 40 lowercase hexadecimal characters');
  });

  it('requires each operation exact target and payload keys', () => {
    const valid = [
      repairRequest(),
      cancelRequest(),
      supersedeRequest(),
      completeRequest(),
      quarantineRequest(),
    ];
    expect(valid.map((request) => decodeGovernanceDecisionRequest(request).operation)).toEqual([
      'plan.repair',
      'plan.cancel',
      'plan.supersede',
      'plan.complete',
      'plan.quarantine',
    ]);

    expect(() =>
      decodeGovernanceDecisionRequest({
        ...cancelRequest(),
        target: { ...cancelRequest().target, extra: true },
      }),
    ).toThrow('plan.cancel target must contain exactly: planPath, planDigest');
    expect(() =>
      decodeGovernanceDecisionRequest({ ...completeRequest(), payload: { content: 'arbitrary' } }),
    ).toThrow('plan.complete payload must be empty');
    expect(() =>
      decodeGovernanceDecisionRequest({
        ...quarantineRequest(),
        target: { planPath: '../escape.md', planBlobOid: '3'.repeat(40) },
      }),
    ).toThrow('planPath must identify a direct plans/<kebab>.md file');
  });

  it('binds the decision ID and request digest to the canonical request bytes', () => {
    const request = decodeGovernanceDecisionRequest(cancelRequest());
    const canonicalRequest = toCanonicalJson(request);
    const expectedDigest = createHash('sha256').update(canonicalRequest).digest('hex');

    expect(computeGovernanceDecisionId(request)).toBe(expectedDigest);
    expect(canonicalRequest.endsWith('\n')).toBe(false);
  });

  it('creates an admin-only canonical receipt with sorted evidence and one newline', () => {
    const request = decodeGovernanceDecisionRequest(cancelRequest());
    const receipt = createGovernanceDecisionReceipt({
      request,
      actor: { login: 'repository-admin', permission: 'admin' },
      transport: { kind: 'local-gh' },
      result: { acceptanceStatus: 'not-achieved' },
      bypassedInvariants: ['z-last', 'a-first'],
      stateChanges: [
        {
          path: 'plans/README.md',
          before: { blobOid: '5'.repeat(40), sha256: '6'.repeat(64) },
          after: { blobOid: '7'.repeat(40), sha256: '8'.repeat(64) },
        },
        {
          path: 'plans/example.md',
          before: { blobOid: '9'.repeat(40), sha256: 'a'.repeat(64) },
          after: null,
        },
      ],
    });
    const serialized = serializeGovernanceDecisionReceipt(receipt);

    expect(receipt.schemaVersion).toBe('governance-decision-receipt-v1');
    expect(receipt.decisionId).toBe(computeGovernanceDecisionId(request));
    expect(receipt.requestDigest).toBe(receipt.decisionId);
    expect(receipt.bypassedInvariants).toEqual(['a-first', 'z-last']);
    expect(receipt.stateChanges.map((change) => change.path)).toEqual([
      'plans/README.md',
      'plans/example.md',
    ]);
    expect(serialized).toBe(`${toCanonicalJson(receipt)}\n`);
    expect(serialized.endsWith('\n\n')).toBe(false);
    expect(() =>
      createGovernanceDecisionReceipt({
        request,
        actor: { login: 'writer', permission: 'write' },
        transport: { kind: 'local-gh' },
        result: { acceptanceStatus: 'not-achieved' },
        bypassedInvariants: [],
        stateChanges: [],
      }),
    ).toThrow('authenticated actor permission must be admin');
    expect(() =>
      createGovernanceDecisionReceipt({
        request,
        actor: { login: 'repository-admin', permission: 'admin', claimed: true },
        transport: { kind: 'local-gh' },
        result: { acceptanceStatus: 'not-achieved' },
        bypassedInvariants: [],
        stateChanges: [],
      }),
    ).toThrow('authenticated actor must contain exactly: login, permission');
    expect(() =>
      createGovernanceDecisionReceipt({
        request,
        actor: { login: 'repository-admin', permission: 'admin' },
        transport: { kind: 'local-gh' },
        result: { acceptanceStatus: 'not-achieved' },
        bypassedInvariants: [],
        stateChanges: [
          {
            path: 'plans/example.md',
            before: { blobOid: '9'.repeat(40), sha256: 'a'.repeat(64) },
            after: null,
          },
          {
            path: 'plans/example.md',
            before: { blobOid: '9'.repeat(40), sha256: 'a'.repeat(64) },
            after: null,
          },
        ],
      }),
    ).toThrow('state change paths must be unique');
    expect(() =>
      createGovernanceDecisionReceipt({
        request,
        actor: { login: 'repository-admin', permission: 'admin' },
        transport: { kind: 'local-gh', extra: true },
        result: { acceptanceStatus: 'not-achieved' },
        bypassedInvariants: [],
        stateChanges: [],
      }),
    ).toThrow('local-gh transport must contain exactly: kind');
    expect(() =>
      createGovernanceDecisionReceipt({
        request,
        actor: { login: 'repository-admin', permission: 'admin' },
        transport: { kind: 'workflow-dispatch', runId: 12 },
        result: { acceptanceStatus: 'not-achieved' },
        bypassedInvariants: [],
        stateChanges: [],
      }),
    ).toThrow(
      'workflow-dispatch transport must contain exactly: kind, runId, runAttempt, workflowRef, workflowSha',
    );
    expect(() =>
      createGovernanceDecisionReceipt({
        request,
        actor: { login: 'repository-admin', permission: 'admin' },
        transport: { kind: 'local-gh' },
        result: { acceptanceStatus: 'admin-attested' },
        bypassedInvariants: [],
        stateChanges: [],
      }),
    ).toThrow('plan.cancel result must record not-achieved');
    expect(() =>
      createGovernanceDecisionReceipt({
        request,
        actor: { login: 'repository-admin', permission: 'admin' },
        transport: { kind: 'local-gh' },
        result: { acceptanceStatus: 'not-achieved' },
        bypassedInvariants: [''],
        stateChanges: [],
      }),
    ).toThrow('bypassed invariants must be non-empty strings');
  });
});

function commonRequest(operation: string, target: object, payload: object) {
  return {
    schemaVersion: 'governance-decision-request-v1',
    operation,
    repository: 'intact-software-systems/ar-eye-hunter',
    defaultBranch: 'main',
    expectedHeadOid,
    force: true,
    reason: 'Administrator disposition is required.',
    target,
    payload,
  };
}

function repairRequest() {
  return commonRequest(
    'plan.repair',
    { planPath: 'plans/example.md', planDigest: '2'.repeat(64) },
    {
      checkpoint: {
        outcome: 'Recovered truthful plan state.',
        learning: 'The stale facts were replaced.',
        structure: 'Ownership remains coherent.',
        decision: 'amend',
        nextSlices: ['next-slice'],
      },
    },
  );
}

function cancelRequest() {
  return commonRequest(
    'plan.cancel',
    { planPath: 'plans/example.md', planDigest: '2'.repeat(64) },
    {},
  );
}

function supersedeRequest() {
  return commonRequest(
    'plan.supersede',
    { planPath: 'plans/example.md', planDigest: '2'.repeat(64) },
    {
      successorPlanPath: 'plans/successor.md',
      successorPlanBlobOid: '3'.repeat(40),
    },
  );
}

function completeRequest() {
  return commonRequest(
    'plan.complete',
    { planPath: 'plans/example.md', planDigest: '2'.repeat(64) },
    {},
  );
}

function quarantineRequest() {
  return commonRequest(
    'plan.quarantine',
    { planPath: 'plans/example.md', planBlobOid: '3'.repeat(40) },
    {},
  );
}
