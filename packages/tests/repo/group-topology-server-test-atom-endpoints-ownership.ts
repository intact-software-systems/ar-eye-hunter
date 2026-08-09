import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The frozen ownership fixture and target owner retain the same explicit path inventory responsibility.';

export const declaredTopologyOwnershipAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-ownership.test.ts',
    sourceCaseId: 'support:serverRoot',
    sourceAtomId: 'fixture:6:6:declaration:serverRoot:a90b9a0d0479938a',
    sourceFingerprint: 'declaration:serverRoot:a90b9a0d0479938a',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts',
    ownerCaseId: 'support:serverRoot',
    ownerAtomId: 'fixture:8:6:declaration:serverRoot:98a4678f01872d30',
    ownerFingerprint: 'declaration:serverRoot:98a4678f01872d30',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-ownership.test.ts',
    sourceCaseId: 'support:testsRoot',
    sourceAtomId: 'fixture:7:6:declaration:testsRoot:0586a5079aabf15f',
    sourceFingerprint: 'declaration:testsRoot:0586a5079aabf15f',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts',
    ownerCaseId: 'support:testsRoot',
    ownerAtomId: 'fixture:11:6:declaration:testsRoot:e25fc14a59d7616e',
    ownerFingerprint: 'declaration:testsRoot:e25fc14a59d7616e',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-ownership.test.ts',
    sourceCaseId: 'support:materiallyChangedTestSupport',
    sourceAtomId: 'fixture:21:6:declaration:materiallyChangedTestSupport:7c986ea4d669aae7',
    sourceFingerprint: 'declaration:materiallyChangedTestSupport:7c986ea4d669aae7',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts',
    ownerCaseId: 'support:materiallyChangedTestSupport',
    ownerAtomId: 'fixture:25:6:declaration:materiallyChangedTestSupport:ae05b37e72f123de',
    ownerFingerprint: 'declaration:materiallyChangedTestSupport:ae05b37e72f123de',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
