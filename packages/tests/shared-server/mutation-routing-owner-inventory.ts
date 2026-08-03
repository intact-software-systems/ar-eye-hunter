const CLIENT_ROUTE = '/api/state/apps/:applicationId/workspaces/:workspaceId/clients';
const GROUP_ROUTE = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups';
const GROUP_ITEM_ROUTE = `${GROUP_ROUTE}/:groupId`;
const TOPOLOGY_ROUTE = `${GROUP_ITEM_ROUTE}/topology`;

export const MUTATION_ROUTE_OWNER_PATHS = {
  C: 'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
  G: 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
  I: 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts',
  H: 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts',
  P: 'packages/shared-server/rallar-system/group-state/presence/group-presence-service.ts',
  T: 'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts',
  R: 'packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts',
  A: 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
  D: 'packages/shared-server/rallar-system/services/AppCrdtInboxService.ts',
  N: 'packages/shared-server/rallar-system/services/AppAdminInboxService.ts',
} as const;

export const MUTATION_ROUTE_OWNER_DISPATCH_PATHS = {
  'AppAdminInboxService.processCommand': 'processCommand',
  'AppAuthInboxService.processCommand': 'processCommand',
  'AppClientInboxService.processAuthorisedWsConnect': 'processAuthorisedWsConnect',
  'AppClientInboxService.processAuthorisedWsDisconnect': 'processAuthorisedWsDisconnect',
  'AppClientInboxService.processCommand': 'processCommand',
  'AppClientInboxService.processExpiredSessionCommands': 'processExpiredSessionCommands',
  'AppCrdtInboxService.processCommand': 'processCommand',
  'GroupStateInboxHandler.processGroupStateMutation':
    'groupStateInboxHandler.processGroupStateMutation',
  'RtcRttAppInboxHandler.processMutation': 'rtcRttAppInboxHandler.processMutation',
  'TopologyAppInboxHandler.processMutation': 'topologyAppInboxHandler.processMutation',
  processGroupSessionCleanup: 'processGroupSessionCleanup',
} as const;

export const MUTATION_ROUTE_INVENTORY_ROWS = `
HTTP\tPUT ${CLIENT_ROUTE}/:principalId/principal\tCLIENT_PRINCIPAL_UPSERT\tc\t/clients/:principalId/principal\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tPUT ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId\tCLIENT_INSTANCE_UPSERT\tc\t/instances/:clientInstanceId\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tPUT ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId\tCLIENT_SESSION_CONNECT\tc\t/sessions/:sessionId\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tPOST ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId/heartbeat\tCLIENT_SESSION_HEARTBEAT\tc\t/sessions/:sessionId/heartbeat\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tPOST ${CLIENT_ROUTE}/:principalId/instances/:clientInstanceId/sessions/:sessionId/disconnect\tCLIENT_SESSION_DISCONNECT\tc\t/sessions/:sessionId/disconnect\tc\tprocessClientAppInbox\tC\tAppClientInboxService.processCommand
HTTP\tGET /api/ws/:sessionId upgrade\tAUTH_WS_TICKET_CONSUME\tw\t'/api/ws/:sessionId'\trq\trequireSharedWsAuthSession\tA\tAppAuthInboxService.processCommand
HTTP\tGET /api/ws/:sessionId upgrade\tCLIENT_AUTHORISED_WS_CONNECT\tw\t'/api/ws/:sessionId'\tw\tenqueueAuthorisedWsClientConnect\tC\tAppClientInboxService.processAuthorisedWsConnect
WS_LIFECYCLE\twebsocket onClose\tCLIENT_AUTHORISED_WS_DISCONNECT\tl\tonClose:\tl\tenqueueClientSessionDisconnect\tC\tAppClientInboxService.processAuthorisedWsDisconnect
MAINTENANCE\tclient session expiry reconciliation\tCLIENT_EXPIRED_SESSIONS\te\tenqueuePresenceExpiryReconciliation\te\tenqueueExpiredSessions\tC\tAppClientInboxService.processExpiredSessionCommands
HTTP\tPOST /api/auth/register\tAUTH_USER_REGISTER\ta\t'/api/auth/register'\ta\tregisterUser\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/login\tAUTH_SESSION_ISSUE\ta\t'/api/auth/login'\ta\tissueSession\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/logout\tAUTH_SESSION_LOGOUT\ta\t'/api/auth/logout'\ta\tlogoutSession\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/ws-ticket\tAUTH_WS_TICKET_ISSUE\ta\t'/api/auth/ws-ticket'\ta\tissueWebSocketTicket\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/agent-session-tickets\tAUTH_AGENT_SESSION_TICKETS_ISSUE\ta\t'/api/auth/agent-session-tickets'\ta\tissueAgentSessionTickets\tA\tAppAuthInboxService.processCommand
HTTP\tPOST /api/auth/agent-session-tickets/consume\tAUTH_AGENT_SESSION_TICKET_CONSUME\ta\t'/api/auth/agent-session-tickets/consume'\ta\tconsumeAgentSessionTicket\tA\tAppAuthInboxService.processCommand
HTTP\tPOST ${GROUP_ROUTE}\tGROUP_CREATE\tgs\tregisterCreateGroupRoute\tgc\tAppInboxType.GROUP_CREATE\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tcreate-group\tregisterGroupStateMutationRoutes
HTTP\tPUT ${GROUP_ITEM_ROUTE}\tGROUP_UPDATE\tgs\tregisterUpdateGroupRoute\tgc\tAppInboxType.GROUP_UPDATE\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tupdate-group\tregisterGroupStateMutationRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/director/appoint\tGROUP_DIRECTOR_APPOINT\tgs\tregisterAppointGroupDirectorRoute\tgc\tAppInboxType.GROUP_DIRECTOR_APPOINT\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tappoint-group-director\tregisterGroupStateMutationRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/join\tGROUP_JOIN\tga\tregisterJoinGroupRoute\tgc\tAppInboxType.GROUP_JOIN\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tjoin-group\tregisterGroupAdmissionRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/invites/:principalId\tGROUP_INVITE_CREATE\tga\tregisterCreateGroupInviteRoute\tgc\tAppInboxType.GROUP_INVITE_CREATE\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tcreate-group-invite\tregisterGroupAdmissionRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/invites/:principalId/revoke\tGROUP_INVITE_REVOKE\tga\tregisterRevokeGroupInviteRoute\tgc\tAppInboxType.GROUP_INVITE_REVOKE\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\trevoke-group-invite\tregisterGroupAdmissionRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/invites/accept\tGROUP_INVITE_ACCEPT\tga\tregisterAcceptGroupInviteRoute\tgc\tAppInboxType.GROUP_INVITE_ACCEPT\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\taccept-group-invite\tregisterGroupAdmissionRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/join-code/rotate\tGROUP_JOIN_CODE_ROTATE\tga\tregisterRotateGroupJoinCodeRoute\tgc\tAppInboxType.GROUP_JOIN_CODE_ROTATE\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\trotate-group-join-code\tregisterGroupAdmissionRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/members/:principalId/remove\tGROUP_MEMBER_REMOVE\tgm\tregisterRemoveGroupMemberRoute\tgc\tAppInboxType.GROUP_MEMBER_REMOVE\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tremove-group-member\tregisterGroupMembershipRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/members/:principalId/ban\tGROUP_MEMBER_BAN\tgm\tregisterBanGroupMemberRoute\tgc\tAppInboxType.GROUP_MEMBER_BAN\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tban-group-member\tregisterGroupMembershipRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/members/:principalId/unban\tGROUP_MEMBER_UNBAN\tgm\tregisterUnbanGroupMemberRoute\tgc\tAppInboxType.GROUP_MEMBER_UNBAN\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tunban-group-member\tregisterGroupMembershipRoutes
HTTP\tPUT ${GROUP_ITEM_ROUTE}/members/:principalId/role\tGROUP_MEMBER_ROLE_SET\tgm\tregisterSetGroupMemberRoleRoute\tgc\tAppInboxType.GROUP_MEMBER_ROLE_SET\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tset-group-member-role\tregisterGroupMembershipRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/owner/transfer\tGROUP_OWNERSHIP_TRANSFER\tgm\tregisterTransferGroupOwnershipRoute\tgc\tAppInboxType.GROUP_OWNERSHIP_TRANSFER\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\ttransfer-group-ownership\tregisterGroupMembershipRoutes
HTTP\tPUT ${GROUP_ITEM_ROUTE}/members/:principalId\tGROUP_MEMBER_UPSERT\tgm\tregisterUpsertSelfGroupMemberRoute\tgc\tAppInboxType.GROUP_MEMBER_UPSERT\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tupsert-group-member\tregisterGroupMembershipRoutes
HTTP\tPUT ${GROUP_ITEM_ROUTE}/sessions/:sessionId\tGROUP_PRESENCE_CONNECT\tgp\tregisterConnectGroupPresenceRoute\tgc\tAppInboxType.GROUP_PRESENCE_CONNECT\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tconnect-group-presence\tregisterGroupPresenceRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/sessions/:sessionId/heartbeat\tGROUP_PRESENCE_HEARTBEAT\tgp\tregisterHeartbeatGroupPresenceRoute\tgc\tAppInboxType.GROUP_PRESENCE_HEARTBEAT\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\theartbeat-group-presence\tregisterGroupPresenceRoutes
HTTP\tPOST ${GROUP_ITEM_ROUTE}/sessions/:sessionId/disconnect\tGROUP_PRESENCE_DISCONNECT\tgp\tregisterDisconnectGroupPresenceRoute\tgc\tAppInboxType.GROUP_PRESENCE_DISCONNECT\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG\tdisconnect-group-presence\tregisterGroupPresenceRoutes
MAINTENANCE\tgroup presence expiry reconciliation\tGROUP_PRESENCE_EXPIRE\te\tenqueuePresenceExpiryReconciliation\te\tenqueueExpiredPresenceSessions\tH\tGroupStateInboxHandler.processGroupStateMutation\tI\tG
WS_LIFECYCLE\twebsocket onClose group cleanup\tGROUP_PRESENCE_SESSION_CLEANUP\tl\tonClose:\tl\tenqueueGroupSessionCleanup\tP\tprocessGroupSessionCleanup\tG\tG
HTTP\tPUT ${TOPOLOGY_ROUTE}/config\tTOPOLOGY_CONFIG_PUT\tt\t/topology/config\tt\tAppInboxType.TOPOLOGY_CONFIG_PUT\tT\tTopologyAppInboxHandler.processMutation\tG\tG
HTTP\tDELETE ${TOPOLOGY_ROUTE}/config\tTOPOLOGY_CONFIG_DELETE\tt\t/topology/config\tt\tAppInboxType.TOPOLOGY_CONFIG_DELETE\tT\tTopologyAppInboxHandler.processMutation\tG\tG
HTTP\tPUT ${TOPOLOGY_ROUTE}/override\tTOPOLOGY_OVERRIDE_PUT\tt\t/topology/override\tt\tAppInboxType.TOPOLOGY_OVERRIDE_PUT\tT\tTopologyAppInboxHandler.processMutation\tG\tG
HTTP\tDELETE ${TOPOLOGY_ROUTE}/override\tTOPOLOGY_OVERRIDE_DELETE\tt\t/topology/override\tt\tAppInboxType.TOPOLOGY_OVERRIDE_DELETE\tT\tTopologyAppInboxHandler.processMutation\tG\tG
HTTP\tPOST ${TOPOLOGY_ROUTE}/reconfigure\tTOPOLOGY_RECONFIGURE\tt\t/topology/reconfigure\tt\tAppInboxType.TOPOLOGY_RECONFIGURE\tT\tTopologyAppInboxHandler.processMutation\tG\tG
HTTP\tPOST /api/admin/operations/topology/recompute\tTOPOLOGY_RECONFIGURE\tad\t'/api/admin/operations/topology/recompute'\tag\tprocessAuthenticatedEntryUntilCompletionResult\tT\tTopologyAppInboxHandler.processMutation\tG\tG
WS_INBOX\ttopic rallar/rtt\tRTC_RTT_SUBMIT\ts\tAppTopics.rtt\ts\tenqueueRtcRttMutation\tR\tRtcRttAppInboxHandler.processMutation\tG\tG
WS_INBOX\ttopic rallar/crdt/update\tCRDT_UPDATE_APPEND\td\tkind === 'update'\td\tmutationIngress.enqueueUpdate\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/crdt/admin/documents/rebuild-projection\tCRDT_PROJECTION_REBUILD\tcr\t'/api/crdt/admin/documents/rebuild-projection'\tcr\tmutate(c, options, 'rebuild-projection'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/crdt/admin/documents/compact\tCRDT_SNAPSHOT_COMPACT\tcr\t'/api/crdt/admin/documents/compact'\tcr\tmutate(c, options, 'compact'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/admin/operations/crdt/compact\tCRDT_SNAPSHOT_COMPACT\tad\t'/api/admin/operations/crdt/compact'\tag\tprocessAdminMutationUntilCompletion('compact'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/crdt/admin/documents/lifecycle\tCRDT_LIFECYCLE_UPDATE\tcr\t'/api/crdt/admin/documents/lifecycle'\tcr\tmutate(c, options, 'lifecycle'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/admin/operations/crdt/lifecycle\tCRDT_LIFECYCLE_UPDATE\tad\t'/api/admin/operations/crdt/lifecycle'\tag\tprocessAdminMutationUntilCompletion('lifecycle'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/crdt/admin/documents/erase\tCRDT_ERASE\tcr\t'/api/crdt/admin/documents/erase'\tcr\tmutate(c, options, 'erase'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/admin/operations/crdt/erase\tCRDT_ERASE\tad\t'/api/admin/operations/crdt/erase'\tag\tprocessAdminMutationUntilCompletion('erase'\tD\tAppCrdtInboxService.processCommand
HTTP\tPOST /api/admin/operations/maintenance/prune-expired\tADMIN_PRUNE_EXPIRED\tad\t'/api/admin/operations/maintenance/prune-expired'\tag\tappAdmin.pruneExpired\tN\tAppAdminInboxService.processCommand
`;
