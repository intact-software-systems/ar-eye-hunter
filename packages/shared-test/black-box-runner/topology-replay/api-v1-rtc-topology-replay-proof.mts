import type {
  ManagedApiServerLifecycleControls,
  ManagedApiServerPlan,
} from '../managed-api/with-managed-api-server-plans.mts';
import {
  ApiV1RtcTopologyProofApi,
  type ProofGroupInput,
  type ProofSession,
} from './api-v1-rtc-topology-proof-api.mts';
import {
  assertCheckpointMatchesMutation,
  assertCompleteSessionTopology,
  assertPollDrivenReplayMetricDelta,
  exactPublicationExpectation,
  exactTopologyExpectation,
  waitForDurableState,
  waitForPassivePair,
  waitForStablePassiveState,
} from './api-v1-rtc-topology-proof-evidence.mts';
import {
  assertLivePassiveConsumerState,
  assertPublisherHeadsAdvanced,
  assertReplacementConsumerSeeded,
  assertSinglePublisherHeadAdvanced,
} from './api-v1-rtc-topology-proof-postgres.mts';
import { ApiV1RtcTopologyProofSocket } from './api-v1-rtc-topology-proof-websocket.mts';
import {
  removePriorProofArtifacts,
  writeFailureArtifact,
  writeProofArtifact,
} from './api-v1-rtc-topology-proof-artifacts.mts';

export type ApiV1RtcTopologyReplayProofInput = Readonly<{
  env: Record<string, string>;
  databaseUrl: string;
  executionToken: string;
  artifactDir: string;
  primaryPlan: ManagedApiServerPlan;
  secondaryPlan: ManagedApiServerPlan;
  tertiaryPlan: ManagedApiServerPlan;
  controls: ManagedApiServerLifecycleControls;
}>;

export async function runApiV1RtcTopologyReplayProof(
  input: ApiV1RtcTopologyReplayProofInput,
): Promise<void> {
  const proofId = `rtc-replay-${requireExecutionToken(input.executionToken)}`;
  const group: ProofGroupInput = {
    proofId,
    applicationId: `api-v1-${proofId}`,
    workspaceId: `workspace-${proofId}`,
    groupId: `group-${proofId}`,
  };
  const api = new ApiV1RtcTopologyProofApi({
    alice: {
      username: input.env.RALLAR_ALICE_USERNAME ?? 'alice',
      password: input.env.RALLAR_ALICE_PASSWORD ?? 'secret',
    },
    bob: {
      username: input.env.RALLAR_BOB_USERNAME ?? 'bob',
      password: input.env.RALLAR_BOB_PASSWORD ?? 'secret',
    },
    admin: {
      username: input.env.RALLAR_ADMIN_USERNAME ?? 'admin',
      password: input.env.RALLAR_ADMIN_PASSWORD ?? 'admin',
    },
  });
  const sockets: ApiV1RtcTopologyProofSocket[] = [];
  let phase = 'remove-prior-proof-artifacts';
  try {
    await removePriorProofArtifacts(input.artifactDir);
    phase = 'login-proof-sessions';
    const sessions = await loginProofSessions(api, input);
    assertPrincipalSessionContract(sessions);
    phase = 'prepare-proof-group';
    await prepareGroup(api, group, sessions);
    phase = 'establish-baseline-topology';
    await api.establishBaseline({ ...group, actor: sessions[0]! });
    const baselineTopology = await api.readCurrentTopology({ ...group, actor: sessions[0]! });
    phase = 'attach-baseline-sessions';
    const attached = await attachAllSessions(api, sessions);
    sockets.push(...attached);
    const baselineObservations = await waitForPassivePair(
      attached,
      exactTopologyExpectation(baselineTopology, 'hydration'),
    );
    assertCompleteSessionTopology(baselineObservations, sessions);
    phase = 'stabilize-baseline-durable-state';
    const baselineDurable = await waitForStablePassiveState(input.databaseUrl);
    const baselineEvidence = assertLivePassiveConsumerState(baselineDurable);
    const baselineMetrics = await api.readReplayMetrics(input.tertiaryPlan.baseUrl);

    phase = 'live-a-passive-replay';
    const liveARevision = await api.updateMemberRole({
      ...group,
      actor: sessions[0]!,
      memberClientId: sessions[1]!.clientId,
      role: 'admin',
      phase: 'live-a',
    });
    const liveAObservations = await waitForPassivePair(
      attached,
      exactPublicationExpectation(
        group,
        `${proofId}-live-a-role`,
        liveARevision,
      ),
    );
    assertCompleteSessionTopology(liveAObservations, sessions);
    const durableAfterLiveA = await waitForDurableState(input.databaseUrl, (state) =>
      assertSinglePublisherHeadAdvanced({
        state,
        consumerStreamId: baselineEvidence.passiveConsumerStreamId,
        priorHeads: baselineEvidence.publisherHeads,
      }),
    );
    const liveAEvidence = assertSinglePublisherHeadAdvanced({
      state: durableAfterLiveA,
      consumerStreamId: baselineEvidence.passiveConsumerStreamId,
      priorHeads: baselineEvidence.publisherHeads,
    });

    phase = 'live-b-passive-replay';
    const liveBRevision = await api.updateDescription({
      ...group,
      actor: sessions[2]!,
      phase: 'live-b',
    });
    const liveBObservations = await waitForPassivePair(
      attached,
      exactPublicationExpectation(
        group,
        `${proofId}-live-b-description`,
        liveBRevision,
      ),
    );
    assertCompleteSessionTopology(liveBObservations, sessions);
    attached[4]!.assertNoRegressionOrDuplicateLane();
    attached[5]!.assertNoRegressionOrDuplicateLane();
    const durableAfterLiveB = await waitForDurableState(input.databaseUrl, (state) =>
      assertSinglePublisherHeadAdvanced({
        state,
        consumerStreamId: baselineEvidence.passiveConsumerStreamId,
        priorHeads: liveAEvidence.publisherHeads,
      }),
    );
    const liveBEvidence = assertSinglePublisherHeadAdvanced({
      state: durableAfterLiveB,
      consumerStreamId: baselineEvidence.passiveConsumerStreamId,
      priorHeads: liveAEvidence.publisherHeads,
    });
    if (liveBEvidence.advancedPublisherStreamId === liveAEvidence.advancedPublisherStreamId) {
      throw new Error('Live A and B mutations did not append through distinct publisher streams.');
    }
    const replayMetrics = await api.readReplayMetrics(input.tertiaryPlan.baseUrl);
    const metricEvidence = assertPollDrivenReplayMetricDelta(baselineMetrics, replayMetrics);
    const priorStreamIds = new Set(
      durableAfterLiveB.streams.map((stream) => stream.streamId),
    );

    phase = 'stop-passive-c';
    await input.controls.stop(input.tertiaryPlan.port);
    phase = 'restart-a-while-c-stopped';
    const laterARevision = await api.updateMemberRole({
      ...group,
      actor: sessions[0]!,
      memberClientId: sessions[1]!.clientId,
      role: 'member',
      phase: 'restart-a',
    });
    const durableAfterLaterA = await waitForDurableState(input.databaseUrl, (state) =>
      assertSinglePublisherHeadAdvanced({
        state,
        priorHeads: liveBEvidence.publisherHeads,
      }),
    );
    const laterAEvidence = assertSinglePublisherHeadAdvanced({
      state: durableAfterLaterA,
      priorHeads: liveBEvidence.publisherHeads,
    });
    if (laterAEvidence.advancedPublisherStreamId !== liveAEvidence.advancedPublisherStreamId) {
      throw new Error('Restart A mutation appended through the wrong publisher stream.');
    }
    phase = 'restart-b-while-c-stopped';
    const laterBRevision = await api.updateDescription({
      ...group,
      actor: sessions[2]!,
      phase: 'restart-b',
    });
    const durableBeforeRestart = await waitForDurableState(input.databaseUrl, (state) =>
      assertSinglePublisherHeadAdvanced({
        state,
        priorHeads: laterAEvidence.publisherHeads,
      }),
    );
    const laterBEvidence = assertSinglePublisherHeadAdvanced({
      state: durableBeforeRestart,
      priorHeads: laterAEvidence.publisherHeads,
    });
    if (laterBEvidence.advancedPublisherStreamId !== liveBEvidence.advancedPublisherStreamId) {
      throw new Error('Restart B mutation appended through the wrong publisher stream.');
    }
    const advancedPublisherHeads = assertPublisherHeadsAdvanced(
      durableBeforeRestart,
      liveBEvidence.publisherHeads,
    );
    const topologyBeforeReplacement = await api.readCurrentTopology({
      ...group,
      actor: sessions[0]!,
    });
    assertCheckpointMatchesMutation(topologyBeforeReplacement, laterBRevision);

    phase = 'restart-passive-c-prime';
    const replacementPlan = toReplacementPlan(input.tertiaryPlan, input.artifactDir);
    await input.controls.restart(input.tertiaryPlan.port, replacementPlan);
    const replacementSessions = sessions.slice(4).map((session) => ({
      ...session,
      apiBaseUrl: replacementPlan.baseUrl,
      wsBaseUrl: replacementPlan.baseUrl.replace(/^http/, 'ws'),
    }));
    const replacementSockets = await attachAllSessions(api, replacementSessions);
    sockets.push(...replacementSockets);
    const replacementObservations = await Promise.all(
      replacementSockets.map((socket) =>
        socket.waitForTopology(exactTopologyExpectation(topologyBeforeReplacement, 'hydration')),
      ),
    );
    assertCompleteSessionTopology(replacementObservations, sessions);
    replacementSockets.forEach((socket) => socket.assertNoRegressionOrDuplicateLane());

    phase = 'verify-replacement-durable-cursors';
    const replacementDurable = await waitForDurableState(input.databaseUrl, (state) =>
      assertReplacementConsumerSeeded({
        state,
        priorStreamIds,
        publisherHeads: advancedPublisherHeads,
      }),
    );
    const replacementStreamId = assertReplacementConsumerSeeded({
      state: replacementDurable,
      priorStreamIds,
      publisherHeads: advancedPublisherHeads,
    });

    phase = 'write-success-proof-artifact';
    await writeProofArtifact(input.artifactDir, {
      schema: 'rallar.rtc-topology.durable-replay-proof.v1',
      topology: {
        processes: {
          A: ['N1', 'N2'],
          B: ['N3', 'N4'],
          C: ['N5', 'N6'],
          "C'": ['N5', 'N6'],
        },
        samePrincipalSessions: {
          alice: ['N1', 'N3', 'N5'],
          bob: ['N2', 'N4', 'N6'],
        },
      },
      liveReplay: {
        mutations: { A: liveARevision, B: liveBRevision },
        baselinePublisherHeads: baselineEvidence.publisherHeads,
        passiveConsumerStreamId: baselineEvidence.passiveConsumerStreamId,
        publisherStreams: {
          A: liveAEvidence.advancedPublisherStreamId,
          B: liveBEvidence.advancedPublisherStreamId,
        },
        publisherHeads: liveBEvidence.publisherHeads,
        publicationMessageIds: {
          A: liveAObservations[0]!.messageId,
          B: liveBObservations[0]!.messageId,
        },
        metrics: metricEvidence,
        notificationsDisabled: true,
        queueWorkersDisabled: true,
      },
      reconnectHydration: {
        mutationsWhileCStopped: { A: laterARevision, B: laterBRevision },
        publisherHeadsAtRestart: advancedPublisherHeads,
        replacementConsumerStreamId: replacementStreamId,
        hydrationMessageIds: replacementObservations.map((observation) =>
          observation.messageId
        ),
        sameAuthenticatedSessionIdentities: true,
        mutationAfterReplacementStart: false,
      },
      serverLogs: [
        input.primaryPlan.logPath,
        input.secondaryPlan.logPath,
        input.tertiaryPlan.logPath,
        replacementPlan.logPath,
      ].map((path) => path.split('/').at(-1)),
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await writeFailureArtifact({ input, api, sockets, phase, error: failure }).catch(
      () => undefined,
    );
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
  }
}

async function loginProofSessions(
  api: ApiV1RtcTopologyProofApi,
  input: ApiV1RtcTopologyReplayProofInput,
): Promise<readonly ProofSession[]> {
  const nodes = [
    { label: 'N1', principal: 'alice' as const, plan: input.primaryPlan },
    { label: 'N2', principal: 'bob' as const, plan: input.primaryPlan },
    { label: 'N3', principal: 'alice' as const, plan: input.secondaryPlan },
    { label: 'N4', principal: 'bob' as const, plan: input.secondaryPlan },
    { label: 'N5', principal: 'alice' as const, plan: input.tertiaryPlan },
    { label: 'N6', principal: 'bob' as const, plan: input.tertiaryPlan },
  ];
  const sessions: ProofSession[] = [];
  for (const node of nodes) {
    sessions.push(
      await api.login({
        label: node.label,
        principal: node.principal,
        apiBaseUrl: node.plan.baseUrl,
        wsBaseUrl: node.plan.baseUrl.replace(/^http/, 'ws'),
      }),
    );
  }
  return sessions;
}

function assertPrincipalSessionContract(sessions: readonly ProofSession[]): void {
  const alice = sessions.filter((session) => session.principal === 'alice');
  const bob = sessions.filter((session) => session.principal === 'bob');
  for (const principalSessions of [alice, bob]) {
    if (principalSessions.length !== 3)
      throw new Error('Proof principal session count is invalid.');
    if (new Set(principalSessions.map((session) => session.clientId)).size !== 1) {
      throw new Error('Proof sessions for one principal did not share one client identity.');
    }
    if (new Set(principalSessions.map((session) => session.sessionId)).size !== 3) {
      throw new Error('Proof sessions for one principal were not distinct.');
    }
  }
}

async function prepareGroup(
  api: ApiV1RtcTopologyProofApi,
  group: ProofGroupInput,
  sessions: readonly ProofSession[],
): Promise<void> {
  await api.createGroup({ ...group, owner: sessions[0]! });
  await api.activateMember({
    ...group,
    actor: sessions[0]!,
    memberClientId: sessions[0]!.clientId,
  });
  await api.activateMember({
    ...group,
    actor: sessions[1]!,
    memberClientId: sessions[1]!.clientId,
  });
  for (const session of sessions) await api.connectPresence({ ...group, actor: session });
}

async function attachAllSessions(
  api: ApiV1RtcTopologyProofApi,
  sessions: readonly ProofSession[],
): Promise<readonly ApiV1RtcTopologyProofSocket[]> {
  const sockets: ApiV1RtcTopologyProofSocket[] = [];
  try {
    for (const session of sessions) {
      const ticket = await api.issueWebSocketTicket(session);
      sockets.push(await ApiV1RtcTopologyProofSocket.open(session, ticket));
    }
    return sockets;
  } catch (error) {
    sockets.forEach((socket) => socket.close());
    throw error;
  }
}

function toReplacementPlan(
  tertiaryPlan: ManagedApiServerPlan,
  artifactDir: string,
): ManagedApiServerPlan {
  return {
    ...tertiaryPlan,
    logPath: `${artifactDir.replace(/\/+$/, '')}/api-v1-server-tertiary-restart.log`,
  };
}

function requireExecutionToken(value: string): string {
  if (!/^[a-f0-9]{24}$/.test(value)) {
    throw new TypeError('RTC topology replay proof execution token is invalid.');
  }
  return value;
}
