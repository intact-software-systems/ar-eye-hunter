import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { readClientStateRevision, readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateSnapshotReadSource } from '@shared/api/state-snapshot-read.ts';

interface HeaderWriter {
    header(name: string, value: string): void;
}

export function writeClientSnapshotHeaders(
    context: HeaderWriter,
    source: StateSnapshotReadSource,
    snapshot: ClientSnapshot
): void {
    writeCommonHeaders(context, source);
    context.header('Rallar-State-Revision', String(readClientStateRevision(snapshot)));
}

export function writeGroupSnapshotHeaders(
    context: HeaderWriter,
    source: StateSnapshotReadSource,
    snapshot: GroupSnapshot
): void {
    writeCommonHeaders(context, source);
    const revision = readGroupCausalRevision(snapshot);
    context.header('Rallar-Group-Revision', String(revision.groupRevision));
    context.header('Rallar-Presence-Revision', String(revision.presenceRevision));
}

function writeCommonHeaders(
    context: HeaderWriter,
    source: StateSnapshotReadSource
): void {
    context.header('Cache-Control', 'no-store');
    context.header('Rallar-State-Source', source);
}
