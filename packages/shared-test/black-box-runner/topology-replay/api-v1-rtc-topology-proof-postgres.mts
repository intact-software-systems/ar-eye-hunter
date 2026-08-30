import postgres from 'postgres';

export type ProofStreamRow = Readonly<{
    streamId: string;
    headSequence: number;
}>;

export type ProofCursorRow = Readonly<{
    consumerStreamId: string;
    publisherStreamId: string;
    lastProcessedSequence: number;
}>;

export type ProofDurableState = Readonly<{
    streams: readonly ProofStreamRow[];
    cursors: readonly ProofCursorRow[];
    unresolvedAppInboxCount: number;
    unresolvedAppOutboxCount: number;
}>;

type ProofDatabaseScalar = string | number | bigint | null | undefined;

interface ProofStreamDatabaseRow {
    readonly stream_id: ProofDatabaseScalar;
    readonly head_sequence: ProofDatabaseScalar;
}

interface ProofCursorDatabaseRow {
    readonly consumer_stream_id: ProofDatabaseScalar;
    readonly publisher_stream_id: ProofDatabaseScalar;
    readonly last_processed_sequence: ProofDatabaseScalar;
}

interface ProofCountDatabaseRow {
    readonly unresolved_count: ProofDatabaseScalar;
}

export async function readRtcTopologyProofDurableState(
    databaseUrl: string
): Promise<ProofDurableState> {
    const sql = postgres(databaseUrl, {
        max: 1,
        connection: { application_name: 'rtc_topology_replay_proof' }
    });
    try {
        return await sql.begin('isolation level repeatable read read only', async (transaction) => {
            const unresolvedAppInboxRows = await transaction<ProofCountDatabaseRow[]>`
      select count(*)::bigint as unresolved_count
      from resource_inbox
      where ri_type_id = 'APP_INBOX'
        and ri_status in ('NEW', 'RETRY', 'RESERVED', 'FAILED', 'ABORTED', 'NON_RETRYABLE')
        and expire_ts > now()
    `;
            const unresolvedAppOutboxRows = await transaction<ProofCountDatabaseRow[]>`
      select count(*)::bigint as unresolved_count
      from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
        and ri_status in ('NEW', 'RETRY', 'RESERVED', 'FAILED', 'ABORTED', 'NON_RETRYABLE')
        and expire_ts > now()
    `;
            const streams = await transaction<ProofStreamDatabaseRow[]>`
      select stream_id::text as stream_id, head_sequence
      from rtc_topology_delivery_stream
      order by created_at, stream_id
    `;
            const cursors = await transaction<ProofCursorDatabaseRow[]>`
      select
        consumer_stream_id::text as consumer_stream_id,
        publisher_stream_id::text as publisher_stream_id,
        last_processed_sequence
      from rtc_topology_replay_cursor
      order by consumer_stream_id, publisher_stream_id
    `;
            return {
                streams: streams.map((row) => ({
                    streamId: requireString(row.stream_id, 'stream ID'),
                    headSequence: toSafeSequence(row.head_sequence, 'stream HEAD')
                })),
                cursors: cursors.map((row) => ({
                    consumerStreamId: requireString(row.consumer_stream_id, 'consumer stream ID'),
                    publisherStreamId: requireString(row.publisher_stream_id, 'publisher stream ID'),
                    lastProcessedSequence: toSafeSequence(row.last_processed_sequence, 'cursor sequence')
                })),
                unresolvedAppInboxCount: toSafeSequence(
                    unresolvedAppInboxRows[0]?.unresolved_count,
                    'unresolved APP_INBOX count'
                ),
                unresolvedAppOutboxCount: toSafeSequence(
                    unresolvedAppOutboxRows[0]?.unresolved_count,
                    'unresolved APP_OUTBOX count'
                )
            };
        });
    }
    finally {
        await sql.end({ timeout: 5 });
    }
}

export function assertLivePassiveConsumerState(state: ProofDurableState): Readonly<{
    passiveConsumerStreamId: string;
    publisherHeads: Readonly<Record<string, number>>;
}> {
    assertProofDurableQuiescence(state);
    if (state.streams.length !== 3) {
        throw new Error(`Expected exactly three live proof streams; found ${state.streams.length}.`);
    }
    const publishers = state.streams.filter((stream) => stream.headSequence > 0);
    const passive = state.streams.filter((stream) => stream.headSequence === 0);
    if (publishers.length !== 2 || passive.length !== 1) {
        throw new Error('The live proof did not produce two publisher streams and one passive stream.');
    }
    assertConsumerCaughtUp(state, passive[0]!.streamId, publishers);
    return {
        passiveConsumerStreamId: passive[0]!.streamId,
        publisherHeads: Object.fromEntries(
            publishers.map((publisher) => [publisher.streamId, publisher.headSequence])
        )
    };
}

export function assertPublisherHeadsAdvanced(
    state: ProofDurableState,
    priorHeads: Readonly<Record<string, number>>
): Readonly<Record<string, number>> {
    const advanced: Record<string, number> = {};
    for (const [streamId, priorHead] of Object.entries(priorHeads)) {
        const stream = state.streams.find((candidate) => candidate.streamId === streamId);
        if (!stream || stream.headSequence <= priorHead) {
            throw new Error(`Publisher ${streamId} did not advance after its later mutation.`);
        }
        advanced[streamId] = stream.headSequence;
    }
    return advanced;
}

export function assertPublisherHeadsUnchanged(
    state: ProofDurableState,
    priorHeads: Readonly<Record<string, number>>
): Readonly<Record<string, number>> {
    assertProofDurableQuiescence(state);
    for (const [streamId, priorHead] of Object.entries(priorHeads)) {
        const stream = state.streams.find((candidate) => candidate.streamId === streamId);
        if (!stream || stream.headSequence !== priorHead) {
            throw new Error(`Publisher ${streamId} changed during topology mutation replay.`);
        }
    }
    return priorHeads;
}

export function assertSinglePublisherHeadAdvanced(
    input: Readonly<{
        state: ProofDurableState;
        consumerStreamId?: string;
        priorHeads: Readonly<Record<string, number>>;
    }>
): Readonly<{
    advancedPublisherStreamId: string;
    publisherHeads: Readonly<Record<string, number>>;
}> {
    assertProofDurableQuiescence(input.state);
    const publisherHeads: Record<string, number> = {};
    const advancedPublisherStreamIds: string[] = [];
    for (const [streamId, priorHead] of Object.entries(input.priorHeads)) {
        const stream = input.state.streams.find((candidate) => candidate.streamId === streamId);
        if (!stream) {
            throw new Error(`Publisher ${streamId} disappeared during the live proof.`);
        }
        const delta = stream.headSequence - priorHead;
        if (delta !== 0 && delta !== 1) {
            throw new Error(`Publisher ${streamId} appended an unexpected live-proof entry count.`);
        }
        if (delta === 1) {
            advancedPublisherStreamIds.push(streamId);
        }
        publisherHeads[streamId] = stream.headSequence;
    }
    if (advancedPublisherStreamIds.length !== 1) {
        throw new Error('The live proof did not advance exactly one publisher by one entry.');
    }
    const publishers = Object.entries(publisherHeads).map(([streamId, headSequence]) => ({
        streamId,
        headSequence
    }));
    if (input.consumerStreamId) {
        assertConsumerCaughtUp(input.state, input.consumerStreamId, publishers);
    }
    return {
        advancedPublisherStreamId: advancedPublisherStreamIds[0]!,
        publisherHeads
    };
}

export function assertReplacementConsumerSeeded(
    input: Readonly<{
        state: ProofDurableState;
        priorStreamIds: ReadonlySet<string>;
        publisherHeads: Readonly<Record<string, number>>;
    }>
): string {
    assertProofDurableQuiescence(input.state);
    if (input.state.streams.length !== input.priorStreamIds.size + 1) {
        throw new Error('Replacement C did not register exactly one new durable stream.');
    }
    const replacement = input.state.streams.filter(
        (stream) => !input.priorStreamIds.has(stream.streamId)
    );
    if (replacement.length !== 1 || replacement[0]!.headSequence !== 0) {
        throw new Error('Replacement C stream is missing or unexpectedly published delivery entries.');
    }
    const publishers = Object.entries(input.publisherHeads).map(([streamId, headSequence]) => ({
        streamId,
        headSequence
    }));
    assertConsumerCaughtUp(input.state, replacement[0]!.streamId, publishers);
    return replacement[0]!.streamId;
}

export function assertProofDurableQuiescence(state: ProofDurableState): void {
    if (state.unresolvedAppInboxCount !== 0) {
        throw new Error(
            `RTC topology proof still has ${state.unresolvedAppInboxCount} unresolved APP_INBOX rows.`
        );
    }
    if (state.unresolvedAppOutboxCount !== 0) {
        throw new Error(
            `RTC topology proof still has ${state.unresolvedAppOutboxCount} unresolved APP_OUTBOX rows.`
        );
    }
}

function assertConsumerCaughtUp(
    state: ProofDurableState,
    consumerStreamId: string,
    publishers: readonly ProofStreamRow[]
): void {
    for (const publisher of publishers) {
        const cursor = state.cursors.find(
            (candidate) =>
                candidate.consumerStreamId === consumerStreamId &&
                candidate.publisherStreamId === publisher.streamId
        );
        if (!cursor || cursor.lastProcessedSequence !== publisher.headSequence) {
            throw new Error(
                `Consumer ${consumerStreamId} is not caught up to publisher ${publisher.streamId}.`
            );
        }
    }
}

function toSafeSequence(value: ProofDatabaseScalar, label: string): number {
    const number = typeof value === 'bigint'
        ? Number(value)
        : typeof value === 'string' && /^[0-9]+$/.test(value)
        ? Number(value)
        : value;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
        throw new TypeError(`${label} is not a non-negative safe integer.`);
    }
    return number;
}

function requireString(value: ProofDatabaseScalar, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    return value;
}
