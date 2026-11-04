import { isSameGroupRef, isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { GroupSessionPage, GroupSessionPreview } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { RallarScheduledSessions } from './rallar-scheduled-sessions.ts';

export namespace ScheduledSessionViewReader {
    export interface ReadInput {
        readonly attempt: RallarScheduledSessions.Attempt;
        readonly isCurrent: () => boolean;
    }
    export interface PagesInput extends ReadInput {
        readonly pageCount: number;
    }
    export interface PreviewInput extends ReadInput {
        readonly ref: GroupRef;
    }
    export interface Page extends GroupSessionPage {
        readonly deadlineAtEpochMs: number | null;
    }
    export interface Preview {
        readonly preview: GroupSessionPreview | null;
        readonly deadlineAtEpochMs: number | null;
    }
}

/** Reads canonical page ranges and watched previews, anchoring phase deadlines at each response receipt. */
export class ScheduledSessionViewReader {
    private readonly dependencies: Pick<
        RallarScheduledSessions.Dependencies,
        'api' | 'timers' | 'watch' | 'readConnectionGeneration'
    >;
    private readonly scope: StateScope;

    constructor(
        dependencies: Pick<
            RallarScheduledSessions.Dependencies,
            'api' | 'timers' | 'watch' | 'readConnectionGeneration'
        >,
        scope: StateScope
    ) {
        this.dependencies = dependencies;
        this.scope = scope;
    }

    async readPreview(input: ScheduledSessionViewReader.PreviewInput): Promise<ScheduledSessionViewReader.Preview> {
        const { ref, attempt } = input;
        const connectionGenerationId = await this.dependencies.readConnectionGeneration(attempt.signal);
        if (!input.isCurrent()) {
            return { preview: null, deadlineAtEpochMs: null };
        }
        await this.dependencies.watch.select({
            session: attempt.session,
            resourceId: ref.groupId,
            connectionGenerationId,
            signal: attempt.signal
        });
        if (!input.isCurrent()) {
            return { preview: null, deadlineAtEpochMs: null };
        }
        const selected = await this.dependencies.api.read(ref, attempt.session, attempt.signal);
        if (selected !== null && !isSameGroupRef(selected.roomRef, ref)) {
            throw new TypeError('Session preview names a different room');
        }
        return {
            preview: selected,
            deadlineAtEpochMs: selected === null
                ? null
                : observeSessionDeadline(selected, this.dependencies.timers.nowMs())
        };
    }

    /** Replaces the loaded range as one projection, preserving pagination and rejecting repeated cursors. */
    async readPages(input: ScheduledSessionViewReader.PagesInput): Promise<ScheduledSessionViewReader.Page | null> {
        const { attempt } = input;
        const sessions: GroupSessionPreview[] = [];
        let cursor: string | null = null;
        let deadlineAtEpochMs: number | null = null;
        const visited = new Set<string>();
        for (let page = 0; page < input.pageCount; page++) {
            const result = await this.dependencies.api.list({
                scope: this.scope,
                after: cursor,
                session: attempt.session,
                signal: attempt.signal
            });
            if (!input.isCurrent()) {
                return null;
            }
            const receivedAtEpochMs = this.dependencies.timers.nowMs();
            for (const session of result.sessions) {
                if (!isSameGroupScope(session.roomRef, this.scope)) {
                    throw new TypeError('Session room belongs to another application or workspace scope');
                }
                deadlineAtEpochMs = earliestSessionDeadline(
                    deadlineAtEpochMs,
                    observeSessionDeadline(session, receivedAtEpochMs)
                );
                if (!sessions.some((existing) => isSameGroupRef(existing.roomRef, session.roomRef))) {
                    sessions.push(session);
                }
            }
            cursor = result.nextKey;
            if (cursor === null) {
                break;
            }
            if (visited.has(cursor)) {
                throw new TypeError('Session directory repeated its pagination cursor');
            }
            visited.add(cursor);
        }
        return { sessions, nextKey: cursor, deadlineAtEpochMs };
    }
}

/** Anchor a server-observed phase when its response arrives, before waiting for other views. */
function observeSessionDeadline(preview: GroupSessionPreview, receivedAtEpochMs: number): number | null {
    const timing = preview.timing;
    const deadline = timing.phase === 'upcoming'
        ? timing.lobbyOpensAtEpochMs
        : timing.phase === 'lobby'
        ? timing.startsAtEpochMs
        : timing.phase === 'start-ready'
        ? timing.reservationsExpireAtEpochMs
        : null;
    return deadline === null ? null : receivedAtEpochMs + deadline - preview.serverNowEpochMs;
}

export function earliestSessionDeadline(left: number | null, right: number | null): number | null {
    if (left === null) {
        return right;
    }
    return right === null ? left : Math.min(left, right);
}
