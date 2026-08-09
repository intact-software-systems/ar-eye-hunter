import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The pinned endpoint retains the same exact AppInbox command-contract literal in its mapped operation, identity, canonicalization, or read-count responsibility; declaration disambiguates repeated values.';

export const declaredTopologyExactCommandAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'binds $operation to its exact queue type and durable payload',
    sourceAtomId:
      'raw-literal:72:34:call:toTopologyAppInboxCommand/property:actor/property:principalId:"owner"',
    sourceFingerprint: 'call:toTopologyAppInboxCommand/property:actor/property:principalId:"owner"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'binds $operation to its exact queue type and durable payload',
    ownerAtomId:
      'raw-literal:124:28:call:toTopologyAppInboxCommand/property:actor/property:principalId:"owner"',
    ownerFingerprint: 'call:toTopologyAppInboxCommand/property:actor/property:principalId:"owner"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'binds $operation to its exact queue type and durable payload',
    sourceAtomId:
      'raw-literal:72:54:call:toTopologyAppInboxCommand/property:actor/property:sessionId:"owner-session"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:actor/property:sessionId:"owner-session"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'binds $operation to its exact queue type and durable payload',
    ownerAtomId:
      'raw-literal:124:48:call:toTopologyAppInboxCommand/property:actor/property:sessionId:"owner-session"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:actor/property:sessionId:"owner-session"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'binds $operation to its exact queue type and durable payload',
    sourceAtomId:
      'raw-literal:74:31:call:toTopologyAppInboxCommand/property:groupRef/property:applicationId:"app-1"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:groupRef/property:applicationId:"app-1"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'binds $operation to its exact queue type and durable payload',
    ownerAtomId:
      'raw-literal:126:23:call:toTopologyAppInboxCommand/property:groupRef/property:applicationId:"app-1"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:groupRef/property:applicationId:"app-1"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'binds $operation to its exact queue type and durable payload',
    sourceAtomId:
      'raw-literal:75:29:call:toTopologyAppInboxCommand/property:groupRef/property:workspaceId:"workspace-1"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:groupRef/property:workspaceId:"workspace-1"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'binds $operation to its exact queue type and durable payload',
    ownerAtomId:
      'raw-literal:127:21:call:toTopologyAppInboxCommand/property:groupRef/property:workspaceId:"workspace-1"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:groupRef/property:workspaceId:"workspace-1"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'binds $operation to its exact queue type and durable payload',
    sourceAtomId:
      'raw-literal:76:25:call:toTopologyAppInboxCommand/property:groupRef/property:groupId:"room-1"',
    sourceFingerprint: 'call:toTopologyAppInboxCommand/property:groupRef/property:groupId:"room-1"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'binds $operation to its exact queue type and durable payload',
    ownerAtomId:
      'raw-literal:128:17:call:toTopologyAppInboxCommand/property:groupRef/property:groupId:"room-1"',
    ownerFingerprint: 'call:toTopologyAppInboxCommand/property:groupRef/property:groupId:"room-1"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId:
      'keeps HTTP topology identity stable across retry clocks and durable preparation changes',
    sourceAtomId:
      'raw-literal:127:22:call:logicalIdentity/property:authority/property:kind:"topology-config"',
    sourceFingerprint: 'call:logicalIdentity/property:authority/property:kind:"topology-config"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId:
      'keeps HTTP topology identity stable across retry clocks and durable preparation changes',
    ownerAtomId:
      'raw-literal:189:14:call:logicalIdentity/property:authority/property:kind:"topology-config"',
    ownerFingerprint: 'call:logicalIdentity/property:authority/property:kind:"topology-config"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId:
      'keeps HTTP topology identity stable across retry clocks and durable preparation changes',
    sourceAtomId:
      'raw-literal:137:22:call:logicalIdentity/property:authority/property:kind:"topology-config"',
    sourceFingerprint: 'call:logicalIdentity/property:authority/property:kind:"topology-config"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId:
      'keeps HTTP topology identity stable across retry clocks and durable preparation changes',
    ownerAtomId:
      'raw-literal:199:14:call:logicalIdentity/property:authority/property:kind:"topology-config"',
    ownerFingerprint: 'call:logicalIdentity/property:authority/property:kind:"topology-config"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'collides divergent stable topology semantics behind the same request id',
    sourceAtomId:
      'raw-literal:153:27:call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'collides divergent stable topology semantics behind the same request id',
    ownerAtomId:
      'raw-literal:215:19:call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'rejects unknown sparse request keys before durable enqueue',
    sourceAtomId:
      'raw-literal:172:34:call:toTopologyAppInboxCommand/property:actor/property:principalId:"owner"',
    sourceFingerprint: 'call:toTopologyAppInboxCommand/property:actor/property:principalId:"owner"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'rejects unknown sparse request keys before durable enqueue',
    ownerAtomId:
      'raw-literal:239:30:call:toTopologyAppInboxCommand/property:actor/property:principalId:"owner"',
    ownerFingerprint: 'call:toTopologyAppInboxCommand/property:actor/property:principalId:"owner"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'rejects unknown sparse request keys before durable enqueue',
    sourceAtomId:
      'raw-literal:172:54:call:toTopologyAppInboxCommand/property:actor/property:sessionId:"owner-session"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:actor/property:sessionId:"owner-session"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'rejects unknown sparse request keys before durable enqueue',
    ownerAtomId:
      'raw-literal:239:50:call:toTopologyAppInboxCommand/property:actor/property:sessionId:"owner-session"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:actor/property:sessionId:"owner-session"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'rejects unknown sparse request keys before durable enqueue',
    sourceAtomId:
      'raw-literal:174:31:call:toTopologyAppInboxCommand/property:groupRef/property:applicationId:"app-1"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:groupRef/property:applicationId:"app-1"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'rejects unknown sparse request keys before durable enqueue',
    ownerAtomId:
      'raw-literal:241:25:call:toTopologyAppInboxCommand/property:groupRef/property:applicationId:"app-1"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:groupRef/property:applicationId:"app-1"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'rejects unknown sparse request keys before durable enqueue',
    sourceAtomId:
      'raw-literal:175:29:call:toTopologyAppInboxCommand/property:groupRef/property:workspaceId:"workspace-1"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:groupRef/property:workspaceId:"workspace-1"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'rejects unknown sparse request keys before durable enqueue',
    ownerAtomId:
      'raw-literal:242:23:call:toTopologyAppInboxCommand/property:groupRef/property:workspaceId:"workspace-1"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:groupRef/property:workspaceId:"workspace-1"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'rejects unknown sparse request keys before durable enqueue',
    sourceAtomId:
      'raw-literal:176:25:call:toTopologyAppInboxCommand/property:groupRef/property:groupId:"room-1"',
    sourceFingerprint: 'call:toTopologyAppInboxCommand/property:groupRef/property:groupId:"room-1"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'rejects unknown sparse request keys before durable enqueue',
    ownerAtomId:
      'raw-literal:243:19:call:toTopologyAppInboxCommand/property:groupRef/property:groupId:"room-1"',
    ownerFingerprint: 'call:toTopologyAppInboxCommand/property:groupRef/property:groupId:"room-1"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'rejects unknown sparse request keys before durable enqueue',
    sourceAtomId:
      'raw-literal:181:27:call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'rejects unknown sparse request keys before durable enqueue',
    ownerAtomId:
      'raw-literal:248:21:call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'rejects unknown sparse request keys before durable enqueue',
    sourceAtomId:
      'raw-literal:183:34:property:payload/property:config/property:topologyKind:"tree"',
    sourceFingerprint: 'property:payload/property:config/property:topologyKind:"tree"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'rejects unknown sparse request keys before durable enqueue',
    ownerAtomId: 'raw-literal:250:26:property:payload/property:config/property:topologyKind:"tree"',
    ownerFingerprint: 'property:payload/property:config/property:topologyKind:"tree"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'canonicalizes omitted, set, and JSON-null clear actions exactly',
    sourceAtomId:
      'raw-literal:210:40:call:readCanonicalGroupTopologyConfigPatch/property:topologyKind/property:action:"clear"',
    sourceFingerprint:
      'call:readCanonicalGroupTopologyConfigPatch/property:topologyKind/property:action:"clear"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'canonicalizes omitted, set, and JSON-null clear actions exactly',
    ownerAtomId:
      'raw-literal:278:32:call:readCanonicalGroupTopologyConfigPatch/property:topologyKind/property:action:"clear"',
    ownerFingerprint:
      'call:readCanonicalGroupTopologyConfigPatch/property:topologyKind/property:action:"clear"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'canonicalizes omitted, set, and JSON-null clear actions exactly',
    sourceAtomId:
      'raw-literal:215:40:call:readCanonicalGroupTopologyConfigPatch/property:topologyKind/property:action:"clear"',
    sourceFingerprint:
      'call:readCanonicalGroupTopologyConfigPatch/property:topologyKind/property:action:"clear"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'canonicalizes omitted, set, and JSON-null clear actions exactly',
    ownerAtomId:
      'raw-literal:283:32:call:readCanonicalGroupTopologyConfigPatch/property:topologyKind/property:action:"clear"',
    ownerFingerprint:
      'call:readCanonicalGroupTopologyConfigPatch/property:topologyKind/property:action:"clear"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'treats set and clear as divergent stable topology semantics',
    sourceAtomId:
      'raw-literal:231:27:call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    sourceFingerprint:
      'call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'treats set and clear as divergent stable topology semantics',
    ownerAtomId:
      'raw-literal:299:19:call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    ownerFingerprint:
      'call:toTopologyAppInboxCommand/property:payload/property:operation:"putConfig"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'validates and hashes an observable payload exactly once per required phase',
    sourceAtomId: 'raw-literal:244:40:variable:payload:1',
    sourceFingerprint: 'variable:payload:1',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'validates and hashes an observable payload exactly once per required phase',
    ownerAtomId: 'raw-literal:312:32:variable:payload:1',
    ownerFingerprint: 'variable:payload:1',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'validates and hashes an observable payload exactly once per required phase',
    sourceAtomId: 'raw-literal:248:77:variable:payload:1',
    sourceFingerprint: 'variable:payload:1',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'validates and hashes an observable payload exactly once per required phase',
    ownerAtomId: 'raw-literal:317:41:variable:payload:1',
    ownerFingerprint: 'variable:payload:1',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
    sourceCaseId: 'validates and hashes an observable payload exactly once per required phase',
    sourceAtomId: 'raw-literal:249:71:variable:payload:1',
    sourceFingerprint: 'variable:payload:1',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
    ownerCaseId: 'validates and hashes an observable payload exactly once per required phase',
    ownerAtomId: 'raw-literal:320:38:variable:payload:1',
    ownerFingerprint: 'variable:payload:1',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
