import assert from 'node:assert/strict';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
  AppTopics,
  ConnectionContext,
  InMemoryQueueBox,
  JsonWebSocketServer,
  newALBroadcastMessage,
  newALEventRoute,
  WsQueueBoxServerService,
} from '@shared/mod.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';
import { configureSharedGraphRepositories } from '@shared-graph/repository/\
configure-shared-graph-repositories.ts';
import {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/\
PSqlRuntimeStateRepository.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
  AuthSessionRepository,
  type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/\
GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/\
persistence/group-topology-config-repository.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-topology/persistence/\
rtc-rtt-repository.ts';
import {
  createGroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/topology/\
group-topology-management-service.ts';
import {
  type JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/\
rallar-rtc-topology-service.ts';
import { createGroupStateEventRepository } from '@shared-server/postgres/rallar-system/\
createStateRepositories.ts';
import {
  AppGroupInboxService,
  type TopologyAppInboxCommand,
  type TopologyAppInboxRequestPayload,
  toTopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { toResilienceDto } from '../../src/middleware-resilience.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';
import {
  PGliteTestSocket,
  readPGliteDatabaseEpochMs,
  submitPGliteTopologyCommand,
  topologyGroupSnapshot,
  topologyGroupSnapshotWithSessions,
  waitForPGliteQueueRow,
} from './pglite-sql-adapter-test-runtime.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

interface ResourceInboxStatusRow {
  readonly ri_type_id: string;
  readonly ri_status: string;
}

interface NumericCountRow {
  readonly count: string | number;
}

interface StringCountRow {
  readonly count: string;
}

interface ResourceInboxLifecycleRow {
  readonly ri_resource_id: string;
  readonly ri_topic_id: string;
  readonly ri_type_id: string;
  readonly ri_status: string;
  readonly ri_resource: string;
}

interface ResourceInboxForeignKeyRow {
  readonly ri_topic_id: string;
  readonly ri_resource_id: string;
  readonly fk_ext_bank_id: string;
}

interface ResourceInboxTopicTypeRow {
  readonly ri_topic_id: string;
  readonly ri_type_id: string;
}

interface NumericValueRow {
  readonly value: number;
}

interface StringValueRow {
  readonly value: string;
}

interface RuntimeStateExpiryRow {
  readonly store_key: string;
  readonly expire_at_ts: string;
}

interface ResourceInboxAttemptStatusRow {
  readonly ri_attempts: string | number;
  readonly ri_status: string;
}

interface ResourceInboxPayloadRow {
  readonly ri_resource: string;
}

interface EpochMillisecondsRow {
  readonly epoch_ms: string | number;
}

interface GroupEventWorkspaceRow {
  readonly workspace_key: string;
}

interface CreatedTimestampRow {
  readonly created_ts: string;
}

interface ExpireTimestampRow {
  readonly expire_ts: string;
}

interface StartTimestampRow {
  readonly start_ts: string;
}

interface EndTimestampRow {
  readonly end_ts: string;
}

interface TopologyCommandPayload {
  readonly data: TopologyAppInboxCommand;
}

interface AcceptedTopologyHttpCommand {
  readonly command: TopologyAppInboxCommand;
  readonly requestPayload: TopologyAppInboxRequestPayload;
  readonly divergentPayload: TopologyAppInboxRequestPayload;
  readonly result: JsonWireValue;
}

interface DurableTopologyAuthorityProof {
  readonly principalId: string;
  readonly sessionId: string;
  readonly sessionIssuedAtEpochMs: number;
}

interface DurableTopologyAuthorityValue {
  readonly proof: DurableTopologyAuthorityProof;
}

interface DurableTopologyAuthority {
  readonly authority: DurableTopologyAuthorityValue;
}

interface ResourceInboxKeyFields {
  readonly topicId: string;
  readonly resourceId: string;
  readonly contextId: string;
}

interface RtcTopologyDeliveryState {
  readonly headSequence: number;
  readonly sequences: readonly number[];
}

interface RtcTopologyDeliveryStreamRow {
  readonly head_sequence: number;
}

interface RtcTopologyDeliveryEntryRow {
  readonly sequence: number;
}

Deno.test(
  'PGlite AppGroup reuses the first durable topology command and rejects divergent stable identity',
  async () => {
    await withPGliteSql(async (sql) => {
      const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
      const runtime = new PSqlRuntimeStateRepository(sql);
      const resourceInbox = new ResourceInboxRepository(sql);
      const resourceResults = new ResourceInboxResultsRepository(sql);
      const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
      const authSessions = new AuthSessionRepository(runtime);
      const authority: IssuedAuthSession = {
        clientId: 'owner',
        sessionId: 'owner-session',
        accessToken: 'owner-token',
        username: 'owner',
        issuedAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: FUTURE_MS,
      };
      await authSessions.putSession(authority);
      const groupRef = {
        applicationId: 'pglite-app-inbox-topology',
        workspaceId: 'replay',
        groupId: 'room',
      };
      const snapshot = topologyGroupSnapshot(groupRef);
      const groupRepository = new GroupStateRepository(runtime);
      assert.equal((await groupRepository.insertGroup(snapshot.group)).status, 'applied');
      for (const member of snapshot.members) {
        await groupRepository.putMember(member);
      }
      const groupState = createGroupStateService({
        runtimeRepository: runtime,
        formationDamping: 'damped',
        createGroupStateEventStore: createGroupStateEventRepository,
        authSessionRepository: authSessions,
        serviceId: 'pglite-app-inbox-topology',
        now: () => nowEpochMs,
      });
      const topology = new GroupTopologyManagementService({
        findGroupSnapshotByRef: (ref) => groupRepository.readSnapshot(ref),
        groupStateRepository: groupRepository,
        configRepository: new GroupTopologyConfigRepository(runtime),
        topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
        processRttReader: () => [],
        now: () => nowEpochMs,
      });
      const appGroup = new AppGroupInboxService(
        inboxReader,
        resourceInbox,
        resourceResults,
        sql,
        groupState,
        'pglite-app-inbox-topology',
        undefined,
        {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 4,
          waitJitterRatio: 0,
          nowEpochMs: () => nowEpochMs,
        },
      );
      appGroup.setTopologyManagementService(topology);

      const first = await toTopologyAppInboxCommand({
        actor: { principalId: authority.clientId, sessionId: authority.sessionId },
        groupRef,
        requestId: 'stable-topology-request',
        capturedAtEpochMs: 1_000,
        payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
      });
      const firstPending = submitPGliteTopologyCommand(
        appGroup,
        authority,
        first,
      );
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      const firstResult = await firstPending;
      assert.ok(firstResult.right);
      const acceptedHttpCommands: AcceptedTopologyHttpCommand[] = [{
        command: first,
        requestPayload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
        divergentPayload: { operation: 'putConfig', config: { topologyKind: 'mesh' } },
        result: firstResult.right,
      }];

      const replay = await toTopologyAppInboxCommand({
        actor: first.actor,
        groupRef,
        requestId: first.requestId,
        capturedAtEpochMs: 9_000,
        payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
      });
      assert.equal(replay.commandHash, first.commandHash);
      const replayResult = await submitPGliteTopologyCommand(
        appGroup,
        authority,
        replay,
      );
      assert.deepEqual(replayResult.right, firstResult.right);

      const [persisted] = await sql<ResourceInboxPayloadRow[]>`
      select ri_resource from resource_inbox
      where ri_type_id = 'APP_INBOX'
        and ri_resource_id = ${first.requestId}
    `;
      assert.ok(persisted);
      const message = JSON.parse(persisted.ri_resource) as ALMessage;
      const envelope = JSON.parse(message.payload.resource) as TopologyCommandPayload;
      assert.equal(envelope.data.capturedAtEpochMs, 1_000);
      assert.equal(
        Number(
          (await sql<NumericCountRow[]>`
        select count(*) as count from resource_inbox
        where ri_type_id = 'APP_INBOX'
          and ri_resource_id = ${first.requestId}
      `)[0]?.count,
        ),
        1,
      );

      for (
        const [requestId, payload, divergentPayload] of [
          [
            'stable-topology-override-put',
            {
              operation: 'putOverride',
              config: { degreeLimit: 4 },
              ttlMs: 60_000,
              expiresAtEpochMs: null,
            },
            {
              operation: 'putOverride',
              config: { degreeLimit: 5 },
              ttlMs: 60_000,
              expiresAtEpochMs: null,
            },
          ],
          [
            'stable-topology-override-delete',
            { operation: 'deleteOverride', target: 'override' },
            {
              operation: 'putOverride',
              config: { degreeLimit: 3 },
              ttlMs: 60_000,
              expiresAtEpochMs: null,
            },
          ],
          [
            'stable-topology-config-delete',
            { operation: 'deleteConfig', target: 'config' },
            { operation: 'putConfig', config: { topologyKind: 'mesh' } },
          ],
          [
            'stable-topology-reconfigure',
            { operation: 'reconfigureTopology', requestOptions: {}, publish: false },
            { operation: 'reconfigureTopology', requestOptions: {}, publish: true },
          ],
        ] as const
      ) {
        const command = await toTopologyAppInboxCommand({
          actor: first.actor,
          groupRef,
          requestId,
          capturedAtEpochMs: nowEpochMs,
          payload,
        });
        const pending = submitPGliteTopologyCommand(appGroup, authority, command);
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await inboxReader.dequeueInbox(
          InboxQueueReader.INBOX_DEQUEUE_TYPES,
          toResilienceDto(),
        );
        const result = await pending;
        assert.ok(result.right, `${payload.operation} did not complete`);
        acceptedHttpCommands.push({
          command,
          requestPayload: payload,
          divergentPayload,
          result: result.right,
        });
      }

      const [outboxCountBeforeReplay] = await sql<NumericCountRow[]>`
      select count(*) as count from resource_inbox where ri_type_id = 'APP_OUTBOX'
    `;
      let freshProofRevision = 0;
      for (const accepted of acceptedHttpCommands) {
        freshProofRevision += 1;
        const freshAuthority: IssuedAuthSession = {
          ...authority,
          accessToken: `owner-replay-token-${freshProofRevision}`,
          issuedAtEpochMs: authority.issuedAtEpochMs + freshProofRevision,
        };
        await authSessions.putSession(freshAuthority);
        const replayAfterCurrentStateChanged = await toTopologyAppInboxCommand({
          actor: accepted.command.actor,
          groupRef,
          requestId: accepted.command.requestId,
          capturedAtEpochMs: accepted.command.capturedAtEpochMs + 30_000,
          payload: accepted.requestPayload,
        });
        assert.equal(
          replayAfterCurrentStateChanged.commandHash,
          accepted.command.commandHash,
        );
        const replayAfterChange = await submitPGliteTopologyCommand(
          appGroup,
          freshAuthority,
          replayAfterCurrentStateChanged,
        );
        assert.deepEqual(replayAfterChange.right, accepted.result);
        assert.equal(
          Number(
            (await sql<NumericCountRow[]>`
            select count(*) as count from resource_inbox
            where ri_type_id = 'APP_INBOX'
              and ri_resource_id = ${accepted.command.requestId}
          `)[0]?.count,
          ),
          1,
        );

        const divergent = await toTopologyAppInboxCommand({
          actor: accepted.command.actor,
          groupRef,
          requestId: accepted.command.requestId,
          capturedAtEpochMs: accepted.command.capturedAtEpochMs + 60_000,
          payload: accepted.divergentPayload,
        });
        await assert.rejects(
          () => submitPGliteTopologyCommand(appGroup, freshAuthority, divergent),
          (error) =>
            error instanceof Error &&
            'code' in error && error.code === 'app-inbox-idempotency-conflict',
        );
      }
      assert.equal(freshProofRevision, 5);
      for (const accepted of acceptedHttpCommands) {
        const [durable] = await sql<ResourceInboxPayloadRow[]>`
        select ri_resource from resource_inbox
        where ri_type_id = 'APP_INBOX'
          and ri_resource_id = ${accepted.command.requestId}
      `;
        assert.ok(durable);
        const durableMessage = JSON.parse(durable.ri_resource) as ALMessage;
        const durableEnvelope = JSON.parse(
          durableMessage.payload.resource,
        ) as DurableTopologyAuthority;
        assert.equal(
          durableEnvelope.authority.proof.principalId,
          authority.clientId,
        );
        assert.equal(
          durableEnvelope.authority.proof.sessionId,
          authority.sessionId,
        );
        assert.equal(
          durableEnvelope.authority.proof.sessionIssuedAtEpochMs,
          authority.issuedAtEpochMs,
        );
      }
      await authSessions.putSession(authority);
      assert.equal(
        Number(
          (await sql<NumericCountRow[]>`
          select count(*) as count from resource_inbox where ri_type_id = 'APP_OUTBOX'
        `)[0]?.count,
        ),
        Number(outboxCountBeforeReplay?.count),
      );

      const processCommand = async (
        requestId: string,
        payload: TopologyAppInboxRequestPayload,
      ) => {
        const command = await toTopologyAppInboxCommand({
          actor: first.actor,
          groupRef,
          requestId,
          capturedAtEpochMs: nowEpochMs,
          payload,
        });
        const pending = submitPGliteTopologyCommand(appGroup, authority, command);
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await inboxReader.dequeueInbox(
          InboxQueueReader.INBOX_DEQUEUE_TYPES,
          toResilienceDto(),
        );
        return { command, result: await pending };
      };
      assert.ok(
        (await processCommand(
          'topology-clear-durable-base',
          { operation: 'putConfig', config: { degreeLimit: 4 } },
        )).result.right,
      );
      assert.ok(
        (await processCommand(
          'topology-clear-override-base',
          {
            operation: 'putOverride',
            config: { meshParamK: 4 },
            ttlMs: 60_000,
            expiresAtEpochMs: null,
          },
        )).result.right,
      );
      const durableUpdateUnderOverride = await processCommand(
        'topology-durable-under-full-override',
        { operation: 'putConfig', config: { degreeLimit: 3 } },
      );
      assert.ok(durableUpdateUnderOverride.result.right);
      const underOverride = await topology.readConfig(groupRef);
      assert.equal(underOverride.durable?.config.degreeLimit, 3);
      assert.equal(underOverride.temporary?.config.degreeLimit, 4);
      assert.equal(underOverride.temporary?.expiresAtEpochMs, nowEpochMs + 60_000);
      assert.equal(underOverride.effective.degreeLimit, 4);

      const cleared = await processCommand(
        'topology-clear-durable-field',
        { operation: 'putConfig', config: { degreeLimit: null } },
      );
      assert.ok(cleared.result.right);
      const afterClear = await topology.readConfig(groupRef);
      assert.equal(afterClear.durable?.config.degreeLimit, 5);
      assert.equal(afterClear.effective.degreeLimit, 4);
      assert.equal(afterClear.effective.meshParamK, 4);

      assert.ok(
        (await processCommand(
          'topology-clear-override-field',
          {
            operation: 'putOverride',
            config: { degreeLimit: null },
            ttlMs: 60_000,
            expiresAtEpochMs: null,
          },
        )).result.right,
      );
      assert.equal((await topology.readConfig(groupRef)).effective.degreeLimit, 5);

      assert.ok(
        (await processCommand(
          'topology-overwrite-after-clear',
          { operation: 'putConfig', config: { degreeLimit: 7 } },
        )).result.right,
      );
      const clearReplay = await toTopologyAppInboxCommand({
        actor: first.actor,
        groupRef,
        requestId: cleared.command.requestId,
        capturedAtEpochMs: nowEpochMs + 90_000,
        payload: { operation: 'putConfig', config: { degreeLimit: null } },
      });
      assert.deepEqual(
        (await submitPGliteTopologyCommand(appGroup, authority, clearReplay)).right,
        cleared.result.right,
      );
      assert.equal((await topology.readConfig(groupRef)).durable?.config.degreeLimit, 7);
      const clearDivergent = await toTopologyAppInboxCommand({
        actor: first.actor,
        groupRef,
        requestId: cleared.command.requestId,
        capturedAtEpochMs: nowEpochMs + 120_000,
        payload: { operation: 'putConfig', config: { degreeLimit: 5 } },
      });
      await assert.rejects(
        () => submitPGliteTopologyCommand(appGroup, authority, clearDivergent),
        (error) =>
          error instanceof Error &&
          'code' in error && error.code === 'app-inbox-idempotency-conflict',
      );

      const rttGroup = topologyGroupSnapshotWithSessions({
        groupRef,
        ownerSessionId: authority.sessionId,
        peerSessionId: 'peer-session',
        nowEpochMs,
      });
      appGroup.setRtcRttAppInboxDependencies({
        repository: new RtcRttRepository(runtime, { now: () => nowEpochMs }),
        readPolicyInputs: () =>
          Promise.resolve({
            candidateGroups: [rttGroup],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 5,
          }),
      });
      configureRttRepository({ ttlMs: 60_000 });
      configureSharedGraphRepositories({
        graphs: { ttlMs: 60_000 },
        vivaldi: { ttlMs: 60_000 },
      });
      const wsServer = new JsonWebSocketServer();
      const wsSocket = new PGliteTestSocket();
      wsServer.addConnection(new ConnectionContext(authority.sessionId, wsSocket));
      const wsService = new WsQueueBoxServerService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        wsServer,
        'pglite-ws-ingress',
      );
      const wsIngressCapturedAt: number[] = [];
      const wsTopics = initRallarSystemWsTopics(wsService, {
        rtcTopologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
        rtcTopologyRuntimeState: { repository: runtime },
        enqueueRtcRttMutation: async (input) => {
          wsIngressCapturedAt.push(input.capturedAtEpochMs);
          return await appGroup.enqueueRtcRtt(input);
        },
      });
      const rtt = {
        sessionIdFrom: authority.sessionId,
        sessionIdTo: 'peer-session',
        rttMs: 12,
        createdAtEpochMs: nowEpochMs,
        version: 1,
      };
      const dispatchRtt = () =>
        wsSocket.dispatchMessage(newALBroadcastMessage(
          authority.sessionId,
          newALEventRoute(AppTopics.rtt, groupRef.groupId, 'pglite-rtt-replay'),
          'room',
          AppTopics.rtt,
          rtt,
          { groupRef },
        ));
      const rttPending = dispatchRtt();
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      await rttPending;
      await new Promise((resolve) => setTimeout(resolve, 2));
      await dispatchRtt();
      wsTopics.stop();
      assert.equal(wsIngressCapturedAt.length, 2);
      assert.ok(wsIngressCapturedAt[1]! > wsIngressCapturedAt[0]!);

      assert.equal(
        Number(
          (await sql<NumericCountRow[]>`
        select count(*) as count from resource_inbox
        where ri_type_id = 'APP_INBOX' and ri_status = 'COMPLETED'
      `)[0]?.count,
        ),
        12,
      );

      for (
        const collisionAuthority of [
          {
            ...authority,
            clientId: 'other-principal',
            sessionId: 'other-principal-session',
            accessToken: 'other-principal-token',
          },
          {
            ...authority,
            sessionId: 'owner-second-session',
            accessToken: 'owner-second-token',
          },
        ]
      ) {
        await authSessions.putSession(collisionAuthority);
        const actorDivergent = await toTopologyAppInboxCommand({
          actor: {
            principalId: collisionAuthority.clientId,
            sessionId: collisionAuthority.sessionId,
          },
          groupRef,
          requestId: first.requestId,
          capturedAtEpochMs: 15_000,
          payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
        });
        await assert.rejects(
          () =>
            submitPGliteTopologyCommand(
              appGroup,
              collisionAuthority,
              actorDivergent,
            ),
          (error) =>
            error instanceof Error &&
            'code' in error && error.code === 'app-inbox-idempotency-conflict',
        );
      }

      const revokedCommand = await toTopologyAppInboxCommand({
        actor: first.actor,
        groupRef,
        requestId: 'revoked-before-topology-write',
        capturedAtEpochMs: nowEpochMs,
        payload: { operation: 'putConfig', config: { topologyKind: 'mesh' } },
      });
      const revokedPending = submitPGliteTopologyCommand(
        appGroup,
        authority,
        revokedCommand,
      );
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await authSessions.deleteSession(authority);
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      const revokedResult = await revokedPending;
      assert.match(revokedResult.left ?? '', /revoked|authority|session/i);
      await assert.rejects(
        () => submitPGliteTopologyCommand(appGroup, authority, first),
        (error) =>
          error instanceof Error &&
          'code' in error && error.code === 'group-mutation-authority-denied',
      );
      assert.equal(
        await new GroupTopologyConfigRepository(runtime).findMutationRecord(
          groupRef,
          revokedCommand.requestId,
        ),
        undefined,
      );
    });
  },
);
