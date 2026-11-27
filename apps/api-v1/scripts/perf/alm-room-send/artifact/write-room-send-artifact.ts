import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RoomSendArtifactDestination } from '../decode-room-send-cell-options.ts';
import type { RoomSendArtifact } from './to-room-send-artifact.ts';

/** Where a run that names no file leaves its artifact, from the directory it was started in. `tmp/` is git-ignored. */
const ROOM_SEND_ARTIFACT_FOLDER = 'tmp/perf/alm-room-send';

/**
 * The file a run's artifact goes to: the one its invocation named, or one named after the run's start and every
 * field of its shape, so two runs of a set never share a file and a file says what it holds.
 */
export function resolveRoomSendArtifactPath(
    destination: RoomSendArtifactDestination,
    run: Pick<RoomSendArtifact, 'createdAt' | 'shape'>
): string {
    if (destination.kind === 'file') {
        return destination.path;
    }
    const { shape } = run;
    const startedAt = run.createdAt.replaceAll(/[:.]/g, '-');
    return `${ROOM_SEND_ARTIFACT_FOLDER}/${startedAt}-p${shape.publishers}-${shape.sendsPerSecond}hz-` +
        `d${shape.delayMs}ms-${shape.durationS}s-${shape.senderRecovery}-pool${shape.applicationPoolMaxConnections}.json`;
}

export async function writeRoomSendArtifact(artifact: RoomSendArtifact, path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
