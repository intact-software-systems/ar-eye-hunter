import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  ClientEvent,
  ClientPresenceSnapshot,
  ClientPrincipalRef,
  ClientSession,
  ClientSnapshot,
} from '@shared/api/client-types.ts';
import type {
  GroupEvent,
  GroupPresenceSession,
  GroupRef,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import type {
  AdminSupportExplainClientRequest,
  AdminSupportExplainCrdtDocumentRequest,
  AdminSupportExplainGroupRequest,
  AdminSupportExplainQueueItemRequest,
  AdminSupportExplainRequestRequest,
  AdminSupportFact,
  AdminSupportNarrativeResponse,
  AdminSupportSuggestedAction,
  AdminSupportTimelineItem,
  AdminSupportWarning,
} from '@shared/api/admin-support-types.ts';
import type {
  RallarCrdtAdminLogRepository,
  RallarCrdtDebugBundle,
  RallarCrdtDocumentMetadata,
  RallarCrdtDocumentRef,
  RallarCrdtIntegrityReport,
} from '@shared/crdt/mod.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import type { ClientStateService } from '../services/client-state-service.ts';
import type { GroupStateService } from '../services/group-state-service.ts';
import {
  nowMs,
  type RallarTimingDetails,
  type RallarTimingEventInput,
  type RallarTimingSink,
  recordRallarTiming,
} from '../services/timing.ts';

export type AdminSupportReadInput = Readonly<{
  adminSession: AuthSession;
}>;

export type AdminSupportWriteInput<TRequest> = Readonly<{
  adminSession: AuthSession;
  request: TRequest;
}>;

export type AdminSupportQueueEntrySource =
  | 'resource_inbox'
  | 'resource_inbox_results';

export type AdminSupportQueueEntryRead = Readonly<{
  source: AdminSupportQueueEntrySource;
  key: Key;
  typeId: string;
  status: string;
  attempts: number;
  createdAtEpochMs?: number;
  startedAtEpochMs?: number;
  endedAtEpochMs?: number;
  nextRetryAtEpochMs?: number;
  expiresAtEpochMs?: number;
  payload: string;
}>;

export type AdminSupportReader = Readonly<{
  readQueueEntry(
    key: Key,
    includeExpired: boolean,
  ): Promise<AdminSupportQueueEntryRead | undefined>;
  readQueueResult(
    key: Key,
    includeExpired: boolean,
  ): Promise<AdminSupportQueueEntryRead | undefined>;
}>;

export type AdminSupportClientStateService = Pick<
  ClientStateService,
  'readSnapshot' | 'readPresenceSnapshot' | 'listRecentEvents'
>;

export type AdminSupportGroupStateService = Pick<
  GroupStateService,
  'readSnapshot' | 'listRecentEvents'
>;

export type AdminSupportTopologyManagement = Readonly<{
  readTopologyView(groupRef: GroupRef): Promise<unknown>;
}>;

export type AdminSupportWsStatus = Readonly<{
  connectionCount: number;
  openConnectionCount: number;
  connectionIds: readonly string[];
  openConnectionIds: readonly string[];
  connections?: readonly unknown[];
}>;

export type AdminSupportServiceOptions = Readonly<{
  now: () => number;
  serverId?: string;
  reader: AdminSupportReader;
  clientStateService?: AdminSupportClientStateService;
  groupStateService?: AdminSupportGroupStateService;
  topologyManagement?: AdminSupportTopologyManagement;
  wsStatus?: () => AdminSupportWsStatus;
  crdtAdminRepository?: Partial<RallarCrdtAdminLogRepository>;
  timing?: RallarTimingSink;
}>;

export class AdminSupportService {
  constructor(private readonly options: AdminSupportServiceOptions) {}

  async explainClient(
    input: AdminSupportWriteInput<AdminSupportExplainClientRequest>,
  ): Promise<AdminSupportNarrativeResponse> {
    return await this.timeExplain('explain.client', input, async () => {
      const ref: ClientPrincipalRef = {
        ...input.request.scope,
        principalId: input.request.principalId,
      };
      const limit = readRecentEventLimit(input.request.limitRecentEvents);
      const clientStateService = this.options.clientStateService;
      const wsStatus = this.options.wsStatus?.();
      const [snapshot, presence, recentEvents] = clientStateService
        ? await Promise.all([
          clientStateService.readSnapshot(ref),
          clientStateService.readPresenceSnapshot(ref),
          clientStateService.listRecentEvents?.(ref, { limit }) ?? Promise.resolve([]),
        ])
        : [undefined, undefined, []] as const;
      const session = findClientSession(
        snapshot,
        input.request.clientInstanceId,
        input.request.sessionId,
      );
      const facts = clientFacts({
        snapshot,
        presence,
        recentEvents,
        session,
        sessionId: input.request.sessionId,
        clientInstanceId: input.request.clientInstanceId,
        wsStatus,
      });
      const warnings = clientWarnings({
        hasClientStateService: Boolean(clientStateService),
        snapshot,
        session,
        sessionId: input.request.sessionId,
        wsStatus,
      });

      return {
        ...this.base({
          kind: 'client',
          scope: input.request.scope,
          principalId: input.request.principalId,
          clientInstanceId: input.request.clientInstanceId,
          sessionId: input.request.sessionId,
        }),
        facts,
        timeline: clientTimeline(recentEvents),
        warnings,
        likelyCauses: clientLikelyCauses(snapshot, session, input.request.sessionId, wsStatus),
        suggestedActions: clientSuggestedActions(snapshot, session, input.request.sessionId),
        rawRefs: [`client:${toClientRef(ref)}`],
      };
    });
  }

  async explainGroup(
    input: AdminSupportWriteInput<AdminSupportExplainGroupRequest>,
  ): Promise<AdminSupportNarrativeResponse> {
    return await this.timeExplain('explain.group', input, async () => {
      const groupRef = input.request.groupRef;
      const limit = readRecentEventLimit(input.request.limitRecentEvents);
      const snapshot = await this.options.groupStateService?.readSnapshot(groupRef);
      const recentEvents =
        await this.options.groupStateService?.listRecentEvents?.(groupRef, { limit }) ?? [];
      const topologyView = await this.options.topologyManagement?.readTopologyView(groupRef);
      const session = findGroupSession(
        snapshot,
        input.request.principalId,
        input.request.sessionId,
      );
      const facts = groupFacts({
        snapshot,
        recentEvents,
        topologyView,
        principalId: input.request.principalId,
        sessionId: input.request.sessionId,
        session,
      });
      const warnings = groupWarnings({
        hasGroupStateService: Boolean(this.options.groupStateService),
        hasTopologyManagement: Boolean(this.options.topologyManagement),
        snapshot,
        principalId: input.request.principalId,
        sessionId: input.request.sessionId,
        session,
        topologyView,
      });

      return {
        ...this.base({
          kind: 'group',
          groupRef,
          principalId: input.request.principalId,
          sessionId: input.request.sessionId,
        }),
        facts,
        timeline: groupTimeline(recentEvents),
        warnings,
        likelyCauses: groupLikelyCauses(snapshot, session, input.request.sessionId),
        suggestedActions: groupSuggestedActions(snapshot, session, input.request.sessionId),
        rawRefs: [`group:${toGroupRef(groupRef)}`],
      };
    });
  }

  async explainRequest(
    input: AdminSupportWriteInput<AdminSupportExplainRequestRequest>,
  ): Promise<AdminSupportNarrativeResponse> {
    return await this.timeExplain('explain.request', input, async () => {
      if (input.request.queueKey) {
        const queue = await this.explainQueueItem({
          adminSession: input.adminSession,
          request: {
            queueKey: input.request.queueKey,
            includeExpired: true,
          },
        });
        return {
          ...queue,
          target: {
            kind: 'request',
            requestId: input.request.requestId,
            idempotencyKey: input.request.idempotencyKey,
            queueKey: input.request.queueKey,
            target: input.request.target,
          },
        };
      }

      return {
        ...this.base({
          kind: 'request',
          requestId: input.request.requestId,
          idempotencyKey: input.request.idempotencyKey,
          target: input.request.target,
        }),
        facts: [{
          label: 'request.search',
          source: 'admin-support',
          value: 'not-run',
          certainty: 'unavailable',
        }],
        timeline: [],
        warnings: [{
          code: 'unsupported-global-request-search',
          message: 'Request explanation requires queueKey or a specific target in phase 1.',
          source: 'admin-support',
        }],
        likelyCauses: [],
        suggestedActions: [{
          code: 'provide-queue-key',
          label: 'Provide a QueueBox key or scoped target to explain this request',
          severity: 'info',
        }],
        rawRefs: [],
      };
    });
  }

  async explainCrdtDocument(
    input: AdminSupportWriteInput<AdminSupportExplainCrdtDocumentRequest>,
  ): Promise<AdminSupportNarrativeResponse> {
    return await this.timeExplain('explain.crdt-document', input, async () => {
      const document = input.request.document;
      const repository = this.options.crdtAdminRepository;
      const metadata = await repository?.readDocumentMetadata?.(document);
      const integrity = input.request.includeIntegrity === true
        ? await repository?.verifyIntegrity?.(document)
        : undefined;
      const debugBundle = input.request.includeRedactedDebugBundle === true
        ? await repository?.exportDebugBundle?.(document, {
          reason: 'api-v1-admin-support-debug-export',
          exportedAtEpochMs: this.options.now(),
          redaction: {
            payloadsRedacted: true,
            reason: 'api-v1-admin-support-redaction',
          },
        })
        : undefined;
      const facts = crdtFacts({
        metadata,
        integrity,
        debugBundle,
      });
      const warnings = crdtWarnings({
        hasRepository: Boolean(repository),
        hasMetadataReader: Boolean(repository?.readDocumentMetadata),
        requestedIntegrity: input.request.includeIntegrity === true,
        hasIntegrityReader: Boolean(repository?.verifyIntegrity),
        requestedDebugBundle: input.request.includeRedactedDebugBundle === true,
        hasDebugBundleReader: Boolean(repository?.exportDebugBundle),
        metadata,
        integrity,
      });

      return {
        ...this.base({
          kind: 'crdt-document',
          document,
        }),
        facts,
        timeline: crdtTimeline(metadata),
        warnings,
        likelyCauses: crdtLikelyCauses(metadata, integrity),
        suggestedActions: crdtSuggestedActions(metadata, integrity),
        rawRefs: [metadata ? `crdt:${metadata.documentKey}` : `crdt:${toDocumentRef(document)}`],
      };
    });
  }

  async explainQueueItem(
    input: AdminSupportWriteInput<AdminSupportExplainQueueItemRequest>,
  ): Promise<AdminSupportNarrativeResponse> {
    return await this.timeExplain('explain.queue-item', input, async () => {
      const queueKey = requireQueueKey(input.request.queueKey);
      const includeExpired = input.request.includeExpired === true;
      const [inbox, result] = await Promise.all([
        this.options.reader.readQueueEntry(queueKey, includeExpired),
        this.options.reader.readQueueResult(queueKey, includeExpired),
      ]);
      const facts = [
        ...entryFacts('inbox', inbox),
        ...entryFacts('result', result),
      ];
      const timeline = [
        ...entryTimeline('inbox', inbox),
        ...entryTimeline('result', result),
      ];
      const warnings: AdminSupportWarning[] = [];

      if (!inbox) {
        warnings.push({
          code: 'queue-inbox-row-missing',
          message: 'No matching resource_inbox row was found for the QueueBox key.',
          source: 'resource_inbox',
        });
      }
      if (!result) {
        warnings.push({
          code: 'queue-result-row-missing',
          message: 'No matching resource_inbox_results row was found for the QueueBox key.',
          source: 'resource_inbox_results',
        });
      }

      return {
        ...this.base({
          kind: 'queue-item',
          queueKey,
        }),
        facts,
        timeline,
        warnings,
        likelyCauses: queueLikelyCauses(inbox, result),
        suggestedActions: queueSuggestedActions(inbox, result),
        rawRefs: [`queue:${toQueueKeyRef(queueKey)}`],
      };
    });
  }

  private async timeExplain<T extends AdminSupportNarrativeResponse>(
    operation: string,
    input: AdminSupportWriteInput<unknown>,
    action: () => Promise<T>,
  ): Promise<T> {
    const timingInput = this.createTimingInput(operation, input);
    const startedAt = nowMs();
    try {
      const result = await action();
      recordRallarTiming(
        this.options.timing,
        {
          ...timingInput,
          details: {
            ...timingInput.details,
            warningCount: result.warnings.length,
            factCount: result.facts.length,
          },
        },
        'ok',
        nowMs() - startedAt,
      );
      return result;
    } catch (error) {
      recordRallarTiming(
        this.options.timing,
        timingInput,
        'error',
        nowMs() - startedAt,
        error,
      );
      throw error;
    }
  }

  private createTimingInput(
    operation: string,
    input: AdminSupportWriteInput<unknown>,
  ): RallarTimingEventInput {
    const request = readObject(input.request);
    const queueKey = readRecord(request.queueKey);

    return {
      component: 'admin-support',
      operation,
      serviceId: this.options.serverId,
      requestId: readTimingString(request.requestId),
      principalId: input.adminSession.clientId,
      sessionId: input.adminSession.sessionId,
      details: compactTimingDetails({
        adminClientId: input.adminSession.clientId,
        queueTopicId: readTimingString(queueKey?.topicId),
        queueResourceId: readTimingString(queueKey?.resourceId),
        queueContextId: readTimingString(queueKey?.contextId),
      }),
    };
  }

  private base(target: AdminSupportNarrativeResponse['target']) {
    return {
      target,
      generatedAtEpochMs: this.options.now(),
      serverId: this.options.serverId,
    };
  }
}

function clientFacts(
  input: Readonly<{
    snapshot: ClientSnapshot | undefined;
    presence: ClientPresenceSnapshot | undefined;
    recentEvents: readonly ClientEvent[];
    session: ClientSession | undefined;
    sessionId: string | undefined;
    clientInstanceId: string | undefined;
    wsStatus: AdminSupportWsStatus | undefined;
  }>,
): readonly AdminSupportFact[] {
  const facts: AdminSupportFact[] = [{
    label: 'client.snapshot',
    source: 'client-state',
    value: input.snapshot ? 'found' : 'missing',
    certainty: input.snapshot ? 'exact' : 'unavailable',
  }];

  if (input.snapshot) {
    facts.push(
      {
        label: 'client.principal.status',
        source: 'client-state',
        value: input.snapshot.principal.status,
        certainty: 'exact',
      },
      {
        label: 'client.isOnline',
        source: 'client-state',
        value: input.snapshot.isOnline,
        certainty: 'exact',
      },
      {
        label: 'client.activeSessionCount',
        source: 'client-state',
        value: input.snapshot.activeSessionCount,
        certainty: 'exact',
      },
    );
    if (input.clientInstanceId) {
      const instance = input.snapshot.instances.find((candidate) =>
        candidate.clientInstanceId === input.clientInstanceId
      );
      facts.push({
        label: 'client.instance.status',
        source: 'client-state',
        value: instance?.status ?? 'missing',
        certainty: instance ? 'exact' : 'unavailable',
      });
    }
  }

  if (input.presence) {
    facts.push(
      {
        label: 'client.presence.isOnline',
        source: 'client-state',
        value: input.presence.isOnline,
        certainty: 'exact',
      },
      {
        label: 'client.presence.activeSessionCount',
        source: 'client-state',
        value: input.presence.activeSessions.length,
        certainty: 'exact',
      },
    );
  }

  if (input.sessionId || input.clientInstanceId) {
    facts.push({
      label: 'client.session.status',
      source: 'client-state',
      value: input.session?.status ?? 'missing',
      certainty: input.session ? 'exact' : 'unavailable',
    });
  }

  if (input.wsStatus) {
    facts.push(
      {
        label: 'client.websocket.openConnectionCount',
        source: 'websocket',
        value: input.wsStatus.openConnectionCount,
        certainty: 'exact',
      },
    );
    if (input.sessionId) {
      facts.push({
        label: 'client.session.currentProcessOpen',
        source: 'websocket',
        value: Boolean(
          input.session?.connectionId &&
            input.wsStatus.openConnectionIds.includes(input.session.connectionId),
        ),
        certainty: input.session?.connectionId ? 'exact' : 'inferred',
      });
    }
  }

  facts.push({
    label: 'client.recentEventCount',
    source: 'client-state-events',
    value: input.recentEvents.length,
    certainty: 'exact',
  });

  return facts;
}

function clientTimeline(events: readonly ClientEvent[]): readonly AdminSupportTimelineItem[] {
  return events.map((event) => ({
    atEpochMs: event.occurredAtEpochMs,
    source: 'client-state-events',
    eventType: event.eventType,
    summary: `Client event ${event.eventType}.`,
    rawRef: `client-event:${event.eventId}`,
  }));
}

function clientWarnings(
  input: Readonly<{
    hasClientStateService: boolean;
    snapshot: ClientSnapshot | undefined;
    session: ClientSession | undefined;
    sessionId: string | undefined;
    wsStatus: AdminSupportWsStatus | undefined;
  }>,
): readonly AdminSupportWarning[] {
  const warnings: AdminSupportWarning[] = [];
  if (!input.hasClientStateService) {
    warnings.push({
      code: 'client-readers-unconfigured',
      message: 'Client state readers are not configured for support explanation.',
      source: 'admin-support',
    });
  }
  if (input.hasClientStateService && !input.snapshot) {
    warnings.push({
      code: 'client-snapshot-missing',
      message: 'No client snapshot was found for the requested principal.',
      source: 'client-state',
    });
  }
  if (input.sessionId && !input.session) {
    warnings.push({
      code: 'client-session-missing',
      message: 'No active client session matched the requested session id.',
      source: 'client-state',
    });
  }
  if (input.wsStatus) {
    warnings.push({
      code: 'process-local-realtime',
      message:
        'WebSocket connection status is process-local and may not include other API workers.',
      source: 'websocket',
    });
    if (
      input.session?.connectionId &&
      !input.wsStatus.openConnectionIds.includes(input.session.connectionId)
    ) {
      warnings.push({
        code: 'client-session-not-open-in-process',
        message: 'The matched client session connection is not open in this API process.',
        source: 'websocket',
      });
    }
  }
  return warnings;
}

function clientLikelyCauses(
  snapshot: ClientSnapshot | undefined,
  session: ClientSession | undefined,
  sessionId: string | undefined,
  wsStatus: AdminSupportWsStatus | undefined,
): readonly string[] {
  const causes = [];
  if (!snapshot) {
    causes.push('Client principal has no durable state snapshot.');
  }
  if (sessionId && !session) {
    causes.push('Requested client session is no longer active or belongs to another instance.');
  }
  if (
    session?.connectionId &&
    wsStatus &&
    !wsStatus.openConnectionIds.includes(session.connectionId)
  ) {
    causes.push('Client session state is active but the local WebSocket is not open.');
  }
  return causes;
}

function clientSuggestedActions(
  snapshot: ClientSnapshot | undefined,
  session: ClientSession | undefined,
  sessionId: string | undefined,
): readonly AdminSupportSuggestedAction[] {
  const actions: AdminSupportSuggestedAction[] = [];
  if (!snapshot) {
    actions.push({
      code: 'verify-client-scope',
      label: 'Verify application/workspace scope and principal id',
      severity: 'info',
    });
  }
  if (sessionId && !session) {
    actions.push({
      code: 'refresh-client-session',
      label: 'Refresh client session state before retrying realtime operations',
      severity: 'warning',
    });
  }
  return actions;
}

function groupFacts(
  input: Readonly<{
    snapshot: GroupSnapshot | undefined;
    recentEvents: readonly GroupEvent[];
    topologyView: unknown;
    principalId: string | undefined;
    sessionId: string | undefined;
    session: GroupPresenceSession | undefined;
  }>,
): readonly AdminSupportFact[] {
  const facts: AdminSupportFact[] = [{
    label: 'group.snapshot',
    source: 'group-state',
    value: input.snapshot ? 'found' : 'missing',
    certainty: input.snapshot ? 'exact' : 'unavailable',
  }];

  if (input.snapshot) {
    facts.push(
      {
        label: 'group.status',
        source: 'group-state',
        value: input.snapshot.group.status,
        certainty: 'exact',
      },
      {
        label: 'group.memberCount',
        source: 'group-state',
        value: input.snapshot.memberCount,
        certainty: 'exact',
      },
      {
        label: 'group.onlineMemberCount',
        source: 'group-state',
        value: input.snapshot.onlineMemberCount,
        certainty: 'exact',
      },
      {
        label: 'group.activeSessionCount',
        source: 'group-state',
        value: input.snapshot.activeSessions.length,
        certainty: 'exact',
      },
    );
    if (input.principalId) {
      const member = input.snapshot.members.find((candidate) =>
        candidate.principalId === input.principalId
      );
      facts.push({
        label: 'group.member.status',
        source: 'group-state',
        value: member?.status ?? 'missing',
        certainty: member ? 'exact' : 'unavailable',
      });
    }
  }

  if (input.sessionId || input.principalId) {
    facts.push({
      label: 'group.session.match',
      source: 'group-state',
      value: input.session ? 'found' : 'missing',
      certainty: input.session ? 'exact' : 'unavailable',
    });
  }

  facts.push(
    {
      label: 'group.topology',
      source: 'group-topology',
      value: summarizeTopologyView(input.topologyView),
      certainty: input.topologyView ? 'exact' : 'unavailable',
    },
    {
      label: 'group.recentEventCount',
      source: 'group-state-events',
      value: input.recentEvents.length,
      certainty: 'exact',
    },
  );

  return facts;
}

function groupTimeline(events: readonly GroupEvent[]): readonly AdminSupportTimelineItem[] {
  return events.map((event) => ({
    atEpochMs: event.occurredAtEpochMs,
    source: 'group-state-events',
    eventType: event.eventType,
    summary: `Group event ${event.eventType}.`,
    rawRef: `group-event:${event.eventId}`,
  }));
}

function groupWarnings(
  input: Readonly<{
    hasGroupStateService: boolean;
    hasTopologyManagement: boolean;
    snapshot: GroupSnapshot | undefined;
    principalId: string | undefined;
    sessionId: string | undefined;
    session: GroupPresenceSession | undefined;
    topologyView: unknown;
  }>,
): readonly AdminSupportWarning[] {
  const warnings: AdminSupportWarning[] = [];
  if (!input.hasGroupStateService) {
    warnings.push({
      code: 'group-readers-unconfigured',
      message: 'Group state readers are not configured for support explanation.',
      source: 'admin-support',
    });
  }
  if (input.hasGroupStateService && !input.snapshot) {
    warnings.push({
      code: 'group-snapshot-missing',
      message: 'No group snapshot was found for the requested group.',
      source: 'group-state',
    });
  }
  if ((input.principalId || input.sessionId) && !input.session) {
    warnings.push({
      code: 'group-session-missing',
      message: 'No active group presence session matched the requested principal or session id.',
      source: 'group-state',
    });
  }
  if (!input.hasTopologyManagement) {
    warnings.push({
      code: 'topology-reader-unconfigured',
      message: 'Group topology reader is not configured for support explanation.',
      source: 'group-topology',
    });
  } else if (!input.topologyView) {
    warnings.push({
      code: 'topology-view-missing',
      message: 'No topology view was found for the requested group.',
      source: 'group-topology',
    });
  }
  return warnings;
}

function groupLikelyCauses(
  snapshot: GroupSnapshot | undefined,
  session: GroupPresenceSession | undefined,
  sessionId: string | undefined,
): readonly string[] {
  const causes = [];
  if (!snapshot) {
    causes.push('Group has no durable state snapshot.');
  }
  if (sessionId && !session) {
    causes.push('Requested group session is no longer active.');
  }
  return causes;
}

function groupSuggestedActions(
  snapshot: GroupSnapshot | undefined,
  session: GroupPresenceSession | undefined,
  sessionId: string | undefined,
): readonly AdminSupportSuggestedAction[] {
  const actions: AdminSupportSuggestedAction[] = [];
  if (!snapshot) {
    actions.push({
      code: 'verify-group-ref',
      label: 'Verify application/workspace scope and group id',
      severity: 'info',
    });
  }
  if (sessionId && !session) {
    actions.push({
      code: 'refresh-group-presence',
      label: 'Refresh group presence before retrying room traffic',
      severity: 'warning',
    });
  }
  return actions;
}

function crdtFacts(
  input: Readonly<{
    metadata: RallarCrdtDocumentMetadata | undefined;
    integrity: RallarCrdtIntegrityReport | undefined;
    debugBundle: RallarCrdtDebugBundle | undefined;
  }>,
): readonly AdminSupportFact[] {
  const facts: AdminSupportFact[] = [{
    label: 'crdt.metadata',
    source: 'crdt-admin-log',
    value: input.metadata ? 'found' : 'missing',
    certainty: input.metadata ? 'exact' : 'unavailable',
  }];

  if (input.metadata) {
    facts.push(
      {
        label: 'crdt.lifecycle',
        source: 'crdt-admin-log',
        value: input.metadata.lifecycle,
        certainty: 'exact',
      },
      {
        label: 'crdt.updateCount',
        source: 'crdt-admin-log',
        value: input.metadata.updateCount,
        certainty: 'exact',
      },
      {
        label: 'crdt.snapshotCount',
        source: 'crdt-admin-log',
        value: input.metadata.snapshotCount,
        certainty: 'exact',
      },
      {
        label: 'crdt.lastAppendSequence',
        source: 'crdt-admin-log',
        value: input.metadata.lastAppendSequence,
        certainty: 'exact',
      },
    );
  }

  if (input.integrity) {
    facts.push(
      {
        label: 'crdt.integrity.valid',
        source: 'crdt-admin-log',
        value: input.integrity.valid,
        certainty: 'exact',
      },
      {
        label: 'crdt.integrity.checkedUpdateCount',
        source: 'crdt-admin-log',
        value: input.integrity.checkedUpdateCount,
        certainty: 'exact',
      },
      {
        label: 'crdt.integrity.sequenceGaps',
        source: 'crdt-admin-log',
        value: input.integrity.sequenceGaps,
        certainty: 'exact',
      },
    );
  }

  if (input.debugBundle) {
    facts.push({
      label: 'crdt.debugExport',
      source: 'crdt-admin-log',
      value: {
        format: input.debugBundle.format,
        recordCount: input.debugBundle.records.length,
        payloadsRedacted: input.debugBundle.redaction.payloadsRedacted,
        updateCount: input.debugBundle.integrity.updateCount,
      },
      certainty: 'exact',
      redacted: true,
    });
  }

  return facts;
}

function crdtTimeline(
  metadata: RallarCrdtDocumentMetadata | undefined,
): readonly AdminSupportTimelineItem[] {
  if (!metadata) {
    return [];
  }
  return [
    toTimeline(
      metadata.createdAtEpochMs,
      'crdt-admin-log',
      'crdt.created',
      'CRDT document metadata was created.',
    ),
    toTimeline(
      metadata.updatedAtEpochMs,
      'crdt-admin-log',
      'crdt.updated',
      'CRDT document metadata was updated.',
    ),
    toTimeline(
      metadata.archivedAtEpochMs,
      'crdt-admin-log',
      'crdt.archived',
      'CRDT document was archived.',
    ),
    toTimeline(
      metadata.destroyedAtEpochMs,
      'crdt-admin-log',
      'crdt.destroyed',
      'CRDT document was destroyed.',
    ),
  ].filter((item): item is AdminSupportTimelineItem => item !== undefined);
}

function crdtWarnings(
  input: Readonly<{
    hasRepository: boolean;
    hasMetadataReader: boolean;
    requestedIntegrity: boolean;
    hasIntegrityReader: boolean;
    requestedDebugBundle: boolean;
    hasDebugBundleReader: boolean;
    metadata: RallarCrdtDocumentMetadata | undefined;
    integrity: RallarCrdtIntegrityReport | undefined;
  }>,
): readonly AdminSupportWarning[] {
  const warnings: AdminSupportWarning[] = [];
  if (!input.hasRepository) {
    warnings.push({
      code: 'crdt-repository-unconfigured',
      message: 'CRDT admin repository is not configured for support explanation.',
      source: 'admin-support',
    });
  }
  if (input.hasRepository && !input.hasMetadataReader) {
    warnings.push({
      code: 'crdt-metadata-reader-unavailable',
      message: 'CRDT metadata reader is not available.',
      source: 'crdt-admin-log',
    });
  }
  if (input.hasMetadataReader && !input.metadata) {
    warnings.push({
      code: 'crdt-metadata-missing',
      message: 'No CRDT document metadata was found.',
      source: 'crdt-admin-log',
    });
  }
  if (input.requestedIntegrity && !input.hasIntegrityReader) {
    warnings.push({
      code: 'crdt-integrity-reader-unavailable',
      message: 'CRDT integrity verification is not available.',
      source: 'crdt-admin-log',
    });
  }
  if (input.integrity && !input.integrity.valid) {
    warnings.push({
      code: 'crdt-integrity-invalid',
      message: 'CRDT integrity verification reported validation issues.',
      source: 'crdt-admin-log',
    });
  }
  if (input.requestedDebugBundle && !input.hasDebugBundleReader) {
    warnings.push({
      code: 'crdt-debug-export-unavailable',
      message: 'CRDT debug export is not available.',
      source: 'crdt-admin-log',
    });
  }
  return warnings;
}

function crdtLikelyCauses(
  metadata: RallarCrdtDocumentMetadata | undefined,
  integrity: RallarCrdtIntegrityReport | undefined,
): readonly string[] {
  const causes = [];
  if (!metadata) {
    causes.push('CRDT document has no durable metadata.');
  }
  if (integrity && !integrity.valid) {
    causes.push('CRDT durable log integrity check found validation issues.');
  }
  return causes;
}

function crdtSuggestedActions(
  metadata: RallarCrdtDocumentMetadata | undefined,
  integrity: RallarCrdtIntegrityReport | undefined,
): readonly AdminSupportSuggestedAction[] {
  const actions: AdminSupportSuggestedAction[] = [];
  if (!metadata) {
    actions.push({
      code: 'verify-crdt-document-ref',
      label: 'Verify CRDT document scope, type, and id',
      severity: 'info',
    });
  }
  if (integrity && !integrity.valid) {
    actions.push({
      code: 'inspect-crdt-debug-export',
      label: 'Inspect a redacted CRDT debug export before repair',
      severity: 'warning',
      operationRef: 'admin-operations.crdt.debug-export',
    });
  }
  return actions;
}

function entryFacts(
  prefix: 'inbox' | 'result',
  entry: AdminSupportQueueEntryRead | undefined,
): readonly AdminSupportFact[] {
  if (!entry) {
    return [{
      label: `${prefix}.status`,
      source: prefix === 'inbox' ? 'resource_inbox' : 'resource_inbox_results',
      value: 'missing',
      certainty: 'unavailable',
    }];
  }

  return [
    {
      label: `${prefix}.status`,
      source: entry.source,
      value: entry.status,
      certainty: 'exact',
    },
    {
      label: `${prefix}.typeId`,
      source: entry.source,
      value: entry.typeId,
      certainty: 'exact',
    },
    {
      label: `${prefix}.attempts`,
      source: entry.source,
      value: entry.attempts,
      certainty: 'exact',
    },
    {
      label: `${prefix}.payload`,
      source: entry.source,
      value: readPayloadMetadata(entry.payload),
      certainty: 'exact',
      redacted: true,
    },
  ];
}

function entryTimeline(
  prefix: 'inbox' | 'result',
  entry: AdminSupportQueueEntryRead | undefined,
): readonly AdminSupportTimelineItem[] {
  if (!entry) {
    return [];
  }
  return [
    toTimeline(entry.createdAtEpochMs, entry.source, `${prefix}.created`, 'Queue row was created.'),
    toTimeline(
      entry.startedAtEpochMs,
      entry.source,
      `${prefix}.started`,
      'Queue row processing started.',
    ),
    toTimeline(
      entry.endedAtEpochMs,
      entry.source,
      `${prefix}.ended`,
      'Queue row processing ended.',
    ),
    toTimeline(
      entry.nextRetryAtEpochMs,
      entry.source,
      `${prefix}.next-retry`,
      'Queue row is scheduled for retry.',
    ),
    toTimeline(entry.expiresAtEpochMs, entry.source, `${prefix}.expires`, 'Queue row expires.'),
  ].filter((item): item is AdminSupportTimelineItem => item !== undefined);
}

function toTimeline(
  atEpochMs: number | undefined,
  source: string,
  eventType: string,
  summary: string,
): AdminSupportTimelineItem | undefined {
  return atEpochMs === undefined ? undefined : {
    atEpochMs,
    source,
    eventType,
    summary,
  };
}

function queueLikelyCauses(
  inbox: AdminSupportQueueEntryRead | undefined,
  result: AdminSupportQueueEntryRead | undefined,
): readonly string[] {
  const causes = [];
  if (inbox?.status === 'RETRY') {
    causes.push('Queue item is waiting for retry.');
  }
  if (inbox?.status === 'RESERVED') {
    causes.push('Queue item is reserved by a worker.');
  }
  if (result?.status === 'FAILED') {
    causes.push('Durable result row recorded a failed operation.');
  }
  if (!inbox && result) {
    causes.push('Queue inbox row is missing but a durable result exists.');
  }
  return causes;
}

function queueSuggestedActions(
  inbox: AdminSupportQueueEntryRead | undefined,
  result: AdminSupportQueueEntryRead | undefined,
): readonly AdminSupportSuggestedAction[] {
  const actions: AdminSupportSuggestedAction[] = [];
  if (inbox?.status === 'RETRY' || inbox?.status === 'RESERVED') {
    actions.push({
      code: 'wait-or-inspect-worker',
      label: 'Check worker health before retry intervention',
      severity: 'warning',
    });
  }
  if (result) {
    actions.push({
      code: 'inspect-result-row',
      label: 'Inspect the durable result row',
      severity: 'info',
    });
  }
  return actions;
}

function readPayloadMetadata(payload: string): Readonly<Record<string, unknown>> {
  const byteLength = new TextEncoder().encode(payload).length;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (Array.isArray(parsed)) {
      return {
        byteLength,
        jsonKind: 'array',
        itemCount: parsed.length,
      };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        byteLength,
        jsonKind: 'object',
        topLevelKeys: Object.keys(parsed).sort(),
      };
    }
    return {
      byteLength,
      jsonKind: typeof parsed,
    };
  } catch {
    return {
      byteLength,
      jsonKind: 'invalid-json',
    };
  }
}

function readRecentEventLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    return 10;
  }
  return Math.min(value, 50);
}

function findClientSession(
  snapshot: ClientSnapshot | undefined,
  clientInstanceId: string | undefined,
  sessionId: string | undefined,
): ClientSession | undefined {
  if (!snapshot) {
    return undefined;
  }
  return snapshot.activeSessions.find((session) =>
    (clientInstanceId === undefined || session.clientInstanceId === clientInstanceId) &&
    (sessionId === undefined || session.sessionId === sessionId)
  );
}

function findGroupSession(
  snapshot: GroupSnapshot | undefined,
  principalId: string | undefined,
  sessionId: string | undefined,
): GroupPresenceSession | undefined {
  if (!snapshot) {
    return undefined;
  }
  return snapshot.activeSessions.find((session) =>
    (principalId === undefined || session.principalId === principalId) &&
    (sessionId === undefined || session.sessionId === sessionId)
  );
}

function summarizeTopologyView(input: unknown): Readonly<Record<string, unknown>> {
  const view = readRecord(input);
  const snapshot = readRecord(view?.snapshot);
  const config = readRecord(view?.config);
  const effective = readRecord(config?.effective);
  const activeSessionIds = Array.isArray(snapshot?.activeSessionIds)
    ? snapshot.activeSessionIds
    : undefined;
  const participantCount = typeof snapshot?.participantCount === 'number'
    ? snapshot.participantCount
    : activeSessionIds?.length;
  return {
    present: Boolean(view),
    topologyKind: readTimingString(effective?.topologyKind) ??
      readTimingString(snapshot?.topology) ??
      readTimingString(snapshot?.kind),
    ...(participantCount !== undefined ? { participantCount } : {}),
  };
}

function toClientRef(ref: ClientPrincipalRef): string {
  return `${ref.applicationId}/${ref.workspaceId}/${ref.principalId}`;
}

function toGroupRef(ref: GroupRef): string {
  return `${ref.applicationId}/${ref.workspaceId}/${ref.groupId}`;
}

function toDocumentRef(document: RallarCrdtDocumentRef): string {
  return [
    document.applicationId,
    document.workspaceId ?? '_',
    document.scope,
    document.documentType,
    document.documentId,
  ].join('/');
}

function unavailableFact(label: string, source: string): AdminSupportFact {
  return {
    label,
    source,
    value: 'unavailable',
    certainty: 'unavailable',
  };
}

function requireQueueKey(value: Key | undefined): Key {
  if (!value || !value.topicId || !value.resourceId || !value.contextId) {
    throw new Error('Admin support queue explanation requires queueKey.');
  }
  return value;
}

function toQueueKeyRef(key: Key): string {
  return `${key.topicId}/${key.resourceId}/${key.contextId}`;
}

function readObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined;
}

function readTimingString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function compactTimingDetails(details: RallarTimingDetails): RallarTimingDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  ) as RallarTimingDetails;
}
