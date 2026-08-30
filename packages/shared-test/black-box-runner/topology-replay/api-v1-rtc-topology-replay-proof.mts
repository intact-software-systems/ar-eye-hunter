import type {
    ManagedApiServerLifecycleControls,
    ManagedApiServerPlan
} from '../managed-api/with-managed-api-server-plans.mts';
import { ApiV1RtcTopologyProofApi, type ProofGroupInput } from './api-v1-rtc-topology-proof-api.mts';
import {
    removePriorProofArtifacts,
    writeFailureArtifact,
    writeProofArtifact
} from './api-v1-rtc-topology-proof-artifacts.mts';
import {
    assertCheckpointMatchesMutation,
    assertCompleteSessionTopology,
    assertPollDrivenReplayMetricDelta,
    assertSharedPublicationIdentity,
    exactPublicationExpectation,
    exactTopologyExpectation,
    waitForDurableState,
    waitForPassivePair,
    waitForStablePassiveState,
    waitForStableRegisteredState
} from './api-v1-rtc-topology-proof-evidence.mts';
import {
    assertPrincipalSessionContract,
    attachAllSessions,
    loginProofSessions,
    prepareGroup,
    requireExecutionToken,
    toReplacementPlan
} from './api-v1-rtc-topology-proof-fixture.mts';
import {
    assertLivePassiveConsumerState,
    assertPublisherHeadsAdvanced,
    assertPublisherHeadsUnchanged,
    assertReplacementConsumerSeeded,
    assertSinglePublisherHeadAdvanced
} from './api-v1-rtc-topology-proof-postgres.mts';
import { ApiV1RtcTopologyProofSocket } from './api-v1-rtc-topology-proof-websocket.mts';
import { withManagedApiServerSuspended } from './with-managed-api-server-suspended.mts';

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
    input: ApiV1RtcTopologyReplayProofInput
): Promise<void> {
    const proofId = `rtc-replay-${requireExecutionToken(input.executionToken)}`;
    const group: ProofGroupInput = {
        proofId,
        applicationId: `api-v1-${proofId}`,
        workspaceId: `workspace-${proofId}`,
        groupId: `group-${proofId}`
    };
    const api = new ApiV1RtcTopologyProofApi({
        alice: {
            username: input.env.RALLAR_ALICE_USERNAME ?? 'alice',
            password: input.env.RALLAR_ALICE_PASSWORD ?? 'secret'
        },
        bob: {
            username: input.env.RALLAR_BOB_USERNAME ?? 'bob',
            password: input.env.RALLAR_BOB_PASSWORD ?? 'secret'
        },
        admin: {
            username: input.env.RALLAR_ADMIN_USERNAME ?? 'admin',
            password: input.env.RALLAR_ADMIN_PASSWORD ?? 'admin'
        }
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
        const preparedDurable = await waitForStableRegisteredState(input.databaseUrl);
        const preparedHeads = Object.fromEntries(
            preparedDurable.streams.map((stream) => [stream.streamId, stream.headSequence])
        );
        phase = 'seed-baseline-publisher-a';
        const baselineA = await withManagedApiServerSuspended(
            input.controls,
            input.secondaryPlan.port,
            async () => {
                await api.updateDisplayName({
                    ...group,
                    actor: sessions[0]!,
                    phase: 'baseline-a'
                });
                const durable = await waitForDurableState(
                    input.databaseUrl,
                    (state) => assertSinglePublisherHeadAdvanced({ state, priorHeads: preparedHeads }),
                    'stable'
                );
                return assertSinglePublisherHeadAdvanced({ state: durable, priorHeads: preparedHeads });
            }
        );
        phase = 'seed-baseline-publisher-b';
        const baselineB = await withManagedApiServerSuspended(
            input.controls,
            input.primaryPlan.port,
            async () => {
                await api.updateDisplayName({
                    ...group,
                    actor: sessions[2]!,
                    phase: 'baseline-b'
                });
                const durable = await waitForDurableState(
                    input.databaseUrl,
                    (state) =>
                        assertSinglePublisherHeadAdvanced({
                            state,
                            priorHeads: baselineA.publisherHeads
                        }),
                    'stable'
                );
                return assertSinglePublisherHeadAdvanced({
                    state: durable,
                    priorHeads: baselineA.publisherHeads
                });
            }
        );
        if (baselineA.advancedPublisherStreamId === baselineB.advancedPublisherStreamId) {
            throw new Error('Baseline A and B did not seed distinct publisher streams.');
        }
        phase = 'establish-baseline-topology';
        await api.establishBaseline({ ...group, actor: sessions[0]! });
        const baselineTopology = await api.readCurrentTopology({ ...group, actor: sessions[0]! });
        phase = 'attach-baseline-sessions';
        const attached = await attachAllSessions(api, sessions);
        sockets.push(...attached);
        const baselineObservations = await waitForPassivePair(
            attached,
            exactTopologyExpectation(baselineTopology, 'hydration')
        );
        assertCompleteSessionTopology(baselineObservations, sessions);
        phase = 'stabilize-baseline-durable-state';
        const baselineDurable = await waitForStablePassiveState(input.databaseUrl);
        const baselineEvidence = assertLivePassiveConsumerState(baselineDurable);
        const baselineMetrics = await api.readReplayMetrics(input.tertiaryPlan.baseUrl);

        phase = 'live-a-passive-replay';
        const liveA = await withManagedApiServerSuspended(
            input.controls,
            input.secondaryPlan.port,
            async () => {
                const revision = await api.updateDisplayName({
                    ...group,
                    actor: sessions[0]!,
                    phase: 'live-a'
                });
                const observations = await waitForPassivePair(
                    attached,
                    exactPublicationExpectation(revision)
                );
                assertCompleteSessionTopology(observations, sessions);
                const durable = await waitForDurableState(
                    input.databaseUrl,
                    (state) =>
                        assertSinglePublisherHeadAdvanced({
                            state,
                            consumerStreamId: baselineEvidence.passiveConsumerStreamId,
                            priorHeads: baselineEvidence.publisherHeads
                        }),
                    'stable'
                );
                const evidence = assertSinglePublisherHeadAdvanced({
                    state: durable,
                    consumerStreamId: baselineEvidence.passiveConsumerStreamId,
                    priorHeads: baselineEvidence.publisherHeads
                });
                return { revision, observations, evidence };
            }
        );
        const liveARevision = liveA.revision;
        const liveAObservations = liveA.observations;
        const liveAEvidence = liveA.evidence;
        if (liveAEvidence.advancedPublisherStreamId !== baselineA.advancedPublisherStreamId) {
            throw new Error('Live A mutation did not append through the seeded A publisher stream.');
        }

        phase = 'live-b-passive-replay';
        const liveB = await withManagedApiServerSuspended(
            input.controls,
            input.primaryPlan.port,
            async () => {
                const revision = await api.updateDisplayName({
                    ...group,
                    actor: sessions[2]!,
                    phase: 'live-b'
                });
                const observations = await waitForPassivePair(
                    attached,
                    exactPublicationExpectation(revision)
                );
                assertCompleteSessionTopology(observations, sessions);
                attached[4]!.assertNoRegressionOrDuplicateLane();
                attached[5]!.assertNoRegressionOrDuplicateLane();
                const durable = await waitForDurableState(
                    input.databaseUrl,
                    (state) =>
                        assertSinglePublisherHeadAdvanced({
                            state,
                            consumerStreamId: baselineEvidence.passiveConsumerStreamId,
                            priorHeads: liveAEvidence.publisherHeads
                        }),
                    'stable'
                );
                const evidence = assertSinglePublisherHeadAdvanced({
                    state: durable,
                    consumerStreamId: baselineEvidence.passiveConsumerStreamId,
                    priorHeads: liveAEvidence.publisherHeads
                });
                return { revision, observations, evidence, durable };
            }
        );
        const liveBRevision = liveB.revision;
        const liveBObservations = liveB.observations;
        const liveBEvidence = liveB.evidence;
        const durableAfterLiveB = liveB.durable;
        if (liveBEvidence.advancedPublisherStreamId !== baselineB.advancedPublisherStreamId) {
            throw new Error('Live B mutation did not append through the seeded B publisher stream.');
        }
        if (liveBEvidence.advancedPublisherStreamId === liveAEvidence.advancedPublisherStreamId) {
            throw new Error('Live A and B mutations did not append through distinct publisher streams.');
        }
        const replayMetrics = await api.readReplayMetrics(input.tertiaryPlan.baseUrl);
        const metricEvidence = assertPollDrivenReplayMetricDelta(baselineMetrics, replayMetrics);
        const priorStreamIds = new Set(
            durableAfterLiveB.streams.map((stream) => stream.streamId)
        );

        phase = 'stop-passive-c';
        await input.controls.stop(input.tertiaryPlan.port);
        phase = 'restart-a-while-c-stopped';
        const laterA = await withManagedApiServerSuspended(
            input.controls,
            input.secondaryPlan.port,
            async () => {
                const revision = await api.updateDisplayName({
                    ...group,
                    actor: sessions[0]!,
                    phase: 'restart-a'
                });
                const durable = await waitForDurableState(
                    input.databaseUrl,
                    (state) =>
                        assertSinglePublisherHeadAdvanced({
                            state,
                            priorHeads: liveBEvidence.publisherHeads
                        }),
                    'stable'
                );
                const evidence = assertSinglePublisherHeadAdvanced({
                    state: durable,
                    priorHeads: liveBEvidence.publisherHeads
                });
                return { revision, evidence };
            }
        );
        const laterARevision = laterA.revision;
        const laterAEvidence = laterA.evidence;
        if (laterAEvidence.advancedPublisherStreamId !== liveAEvidence.advancedPublisherStreamId) {
            throw new Error('Restart A mutation appended through the wrong publisher stream.');
        }
        phase = 'restart-b-while-c-stopped';
        const laterB = await withManagedApiServerSuspended(
            input.controls,
            input.primaryPlan.port,
            async () => {
                const revision = await api.updateDisplayName({
                    ...group,
                    actor: sessions[2]!,
                    phase: 'restart-b'
                });
                const durable = await waitForDurableState(
                    input.databaseUrl,
                    (state) =>
                        assertSinglePublisherHeadAdvanced({
                            state,
                            priorHeads: laterAEvidence.publisherHeads
                        }),
                    'stable'
                );
                const evidence = assertSinglePublisherHeadAdvanced({
                    state: durable,
                    priorHeads: laterAEvidence.publisherHeads
                });
                return { revision, evidence, durable };
            }
        );
        const laterBRevision = laterB.revision;
        const laterBEvidence = laterB.evidence;
        const durableBeforeRestart = laterB.durable;
        if (laterBEvidence.advancedPublisherStreamId !== liveBEvidence.advancedPublisherStreamId) {
            throw new Error('Restart B mutation appended through the wrong publisher stream.');
        }
        const advancedPublisherHeads = assertPublisherHeadsAdvanced(
            durableBeforeRestart,
            liveBEvidence.publisherHeads
        );
        const topologyBeforeReplacement = await api.readCurrentTopology({
            ...group,
            actor: sessions[0]!
        });
        assertCheckpointMatchesMutation(topologyBeforeReplacement, laterBRevision);

        phase = 'restart-passive-c-prime';
        const replacementPlan = toReplacementPlan(input.tertiaryPlan, input.artifactDir);
        await input.controls.restart(input.tertiaryPlan.port, replacementPlan);
        const replacementSessions = sessions.slice(4).map((session) => ({
            ...session,
            apiBaseUrl: replacementPlan.baseUrl,
            wsBaseUrl: replacementPlan.baseUrl.replace(/^http/, 'ws')
        }));
        const replacementSockets = await attachAllSessions(api, replacementSessions);
        sockets.push(...replacementSockets);
        const replacementObservations = await Promise.all(
            replacementSockets.map((socket) =>
                socket.waitForTopology(exactTopologyExpectation(topologyBeforeReplacement, 'hydration'))
            )
        );
        assertCompleteSessionTopology(replacementObservations, sessions);
        replacementSockets.forEach((socket) => socket.assertNoRegressionOrDuplicateLane());

        phase = 'verify-replacement-durable-cursors';
        const replacementDurable = await waitForDurableState(
            input.databaseUrl,
            (state) =>
                assertReplacementConsumerSeeded({
                    state,
                    priorStreamIds,
                    publisherHeads: advancedPublisherHeads
                })
        );
        const replacementStreamId = assertReplacementConsumerSeeded({
            state: replacementDurable,
            priorStreamIds,
            publisherHeads: advancedPublisherHeads
        });

        phase = 'replay-baseline-topology-after-restart';
        await api.establishBaseline({ ...group, actor: replacementSessions[0]! });
        await waitForDurableState(input.databaseUrl, (state) => {
            assertPublisherHeadsUnchanged(state, advancedPublisherHeads);
            assertReplacementConsumerSeeded({
                state,
                priorStreamIds,
                publisherHeads: advancedPublisherHeads
            });
        });

        phase = 'write-success-proof-artifact';
        await writeProofArtifact(input.artifactDir, {
            schema: 'rallar.rtc-topology.durable-replay-proof.v1',
            topology: {
                processes: {
                    A: ['N1', 'N2'],
                    B: ['N3', 'N4'],
                    C: ['N5', 'N6'],
                    'C\'': ['N5', 'N6']
                },
                samePrincipalSessions: {
                    alice: ['N1', 'N3', 'N5'],
                    bob: ['N2', 'N4', 'N6']
                }
            },
            liveReplay: {
                mutations: { A: liveARevision, B: liveBRevision },
                baselinePublisherHeads: baselineEvidence.publisherHeads,
                passiveConsumerStreamId: baselineEvidence.passiveConsumerStreamId,
                publisherStreams: {
                    A: liveAEvidence.advancedPublisherStreamId,
                    B: liveBEvidence.advancedPublisherStreamId
                },
                publisherHeads: liveBEvidence.publisherHeads,
                publicationMessageIds: {
                    A: assertSharedPublicationIdentity(liveAObservations),
                    B: assertSharedPublicationIdentity(liveBObservations)
                },
                metrics: metricEvidence,
                publisherClaimScheduling: 'non-target-process-suspended',
                notificationsDisabled: true,
                queueWorkersDisabled: true
            },
            reconnectHydration: {
                mutationsWhileCStopped: { A: laterARevision, B: laterBRevision },
                publisherHeadsAtRestart: advancedPublisherHeads,
                replacementConsumerStreamId: replacementStreamId,
                hydrationMessageIds: replacementObservations.map((observation) => observation.messageId),
                sameAuthenticatedSessionIdentities: true,
                mutationAfterReplacementStart: false,
                topologyMutationReplayAfterReplacement: true
            },
            serverLogs: [
                input.primaryPlan.logPath,
                input.secondaryPlan.logPath,
                input.tertiaryPlan.logPath,
                replacementPlan.logPath
            ].map((path) => path.split('/').at(-1))
        });
    }
    catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        await writeFailureArtifact({ input, api, sockets, phase, error: failure }).catch(
            () => undefined
        );
        throw error;
    }
    finally {
        for (const socket of sockets) {
            socket.close();
        }
    }
}
