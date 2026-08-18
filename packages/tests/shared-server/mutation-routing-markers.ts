export const ROUTING_SOURCE_MARKERS = {
  'apps/api-v1/src/routes/client-state-routes.ts': [
    'processClientAppInbox',
    'AppInboxType.CLIENT_PRINCIPAL_UPSERT',
  ],
  'apps/api-v1/src/group-state/register-group-state-routes.ts': [
    'registerGroupStateRoutes',
    'registerGroupStateMutationRoutes',
    'registerGroupAdmissionRoutes',
    'registerGroupMembershipRoutes',
    'registerGroupPresenceRoutes',
  ],
  'apps/api-v1/src/group-state/to-group-state-command.ts': [
    'toGroupStateCommand',
    'AppInboxType.GROUP_CREATE',
  ],
  'apps/api-v1/src/routes/graph-topology-routes.ts': [
    'processAuthenticatedEntryUntilCompletionResult',
    'AppInboxType.TOPOLOGY_RECONFIGURE',
  ],
  'apps/api-v1/src/routes/config-route.ts': ['AppAuthInboxService', 'appAuthInbox'],
  'apps/api-v1/src/routes/crdt-admin-routes.ts': ['writeCrdtAdminMutation'],
  'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts': [
    'writeCrdtAdminMutation',
    'writeCrdtCommandUntilCompletion',
  ],
  'apps/api-v1/src/services/create-api-admin-mutation-gateway.ts': [
    'AppInboxType.TOPOLOGY_RECONFIGURE',
    'appAdmin.pruneExpired',
    'crdtAdminMutations.writeCrdtAdminMutation',
  ],
  'apps/api-v1/src/services/request-auth-service.ts': [
    'requireSharedWsAuthSession',
    'appAuthInbox',
  ],
  'apps/api-v1/src/routes/ws-routes.ts': [
    'requireWsAuthSession',
    'enqueueAuthorisedWsClientConnect',
  ],
  'packages/shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts': [
    'mutationIngress.enqueueUpdate',
  ],
  'packages/shared-server/rallar-system/rtc-topology/topic/init-rtc-rtt-topic.ts': [
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
