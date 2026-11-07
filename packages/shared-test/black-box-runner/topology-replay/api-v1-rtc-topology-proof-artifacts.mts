import { rm, writeFile } from 'node:fs/promises';

import type { ApiV1RtcTopologyProofApi } from './api-v1-rtc-topology-proof-api.mts';
import { readRtcTopologyProofDurableState } from './api-v1-rtc-topology-proof-postgres.mts';
import type { ApiV1RtcTopologyProofSocket } from './api-v1-rtc-topology-proof-websocket.mts';
import type { ApiV1RtcTopologyReplayProofInput } from './api-v1-rtc-topology-replay-proof.mts';

interface WriteFailureArtifactInput {
    input: ApiV1RtcTopologyReplayProofInput;
    api: ApiV1RtcTopologyProofApi;
    sockets: readonly ApiV1RtcTopologyProofSocket[];
    phase: string;
    error: Error;
}

export async function writeProofArtifact(artifactDir: string, proof: object): Promise<void> {
    await writeFile(
        `${artifactDir.replace(/\/+$/, '')}/rtc-topology-replay-proof.json`,
        `${JSON.stringify(proof, null, 2)}\n`,
        'utf8'
    );
}

export async function writeFailureArtifact(
    options: Readonly<WriteFailureArtifactInput>
): Promise<void> {
    const { input, api, sockets, phase, error } = options;
    const [metrics, durable] = await Promise.all([
        api.readReplayMetrics(input.tertiaryPlan.baseUrl).catch((metricError) => ({
            unavailable: metricError instanceof Error ? metricError.message : String(metricError)
        })),
        readRtcTopologyProofDurableState(input.databaseUrl).catch((databaseError) => ({
            unavailable: databaseError instanceof Error ? databaseError.message : String(databaseError)
        }))
    ]);
    await writeFile(
        `${input.artifactDir.replace(/\/+$/, '')}/rtc-topology-replay-proof-failure.json`,
        `${
            JSON.stringify(
                {
                    schema: 'rallar.rtc-topology.durable-replay-proof-failure.v1',
                    phase,
                    error: error.message,
                    sockets: sockets.map((socket) => socket.readDiagnostics()),
                    metrics,
                    durable
                },
                null,
                2
            )
        }\n`,
        'utf8'
    );
}

export async function removePriorProofArtifacts(artifactDir: string): Promise<void> {
    const root = artifactDir.replace(/\/+$/, '');
    await Promise.all([
        rm(`${root}/rtc-topology-replay-proof.json`).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            throw error;
        }),
        rm(`${root}/rtc-topology-replay-proof-failure.json`).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            throw error;
        })
    ]);
}
