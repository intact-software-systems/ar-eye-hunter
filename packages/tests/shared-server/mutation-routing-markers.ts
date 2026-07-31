export const ROUTING_SOURCE_MARKERS = {
  'apps/api-v1/src/routes/client-state-routes.ts': [
    'processClientAppInbox',
    'AppInboxType.CLIENT_PRINCIPAL_UPSERT',
  ],
  'apps/api-v1/src/routes/group-state-routes.ts': [
    'processAuthenticatedEntryUntilCompletion',
    'AppInboxType.GROUP_CREATE',
  ],
  'apps/api-v1/src/routes/graph-topology-routes.ts': [
    'processAuthenticatedEntryUntilCompletionResult',
    'AppInboxType.TOPOLOGY_RECONFIGURE',
  ],
  'apps/api-v1/src/routes/config-route.ts': [
    'AppAuthInboxService',
    'readAppAuthInbox',
  ],
  'apps/api-v1/src/routes/crdt-admin-routes.ts': [
    'processAdminMutationUntilCompletion',
  ],
  'apps/api-v1/src/services/create-api-admin-mutation-gateway.ts': [
    'AppInboxType.TOPOLOGY_RECONFIGURE',
    'appAdmin.pruneExpired',
    'appCrdt.processAdminMutationUntilCompletion',
  ],
  'apps/api-v1/src/services/request-auth-service.ts': [
    'requireSharedWsAuthSession',
    'appAuthInbox',
  ],
  'apps/api-v1/src/routes/ws-routes.ts': [
    'requireWsAuthSession',
    'enqueueAuthorisedWsClientConnect',
  ],
  'packages/shared-server/crdt/RallarCrdtServer.ts': [
    'mutationIngress.enqueueUpdate',
  ],
  'packages/shared-server/rallar-system/ws-system-topics.ts': [
    'enqueueRtcRttMutation',
  ],
  'packages/shared-server/rallar-system/services/ws-lifecycle-service.ts': [
    'enqueueClientSessionDisconnect',
    'enqueueGroupSessionCleanup',
  ],
  'packages/shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts': [
    'enqueueExpiredSessions',
    'enqueueExpiredPresenceSessions',
  ],
} as const;
