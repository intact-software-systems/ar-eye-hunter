import { Either } from '@shared/resilience/Either.ts';
import { isAdmissibleControlRtcCaptureResult, toRetainedControlResultEnvelope } from '../control/control-rtc-capture-evidence.ts';

import {
    parseControlClientMessage,
    parseControlServerMessage,
    type ControlClientEnvelope,
    type ControlEventEnvelope,
    type ControlHeartbeatEnvelope,
    type ControlResultEnvelope
} from '../control-protocol.ts';
import type {
    ControlAgentSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from '../control-snapshots.ts';
import { decodeControlAgentIdentity } from '../distributed/decode-control-agent-identity.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    decodeArrayItems,
    isAbsentOrFiniteNumber,
    isAbsentOrNonEmptyText,
    isFiniteNumber,
    isNonEmptyText,
    isTextArray,
    toAlternativesText,
    toFirstDecodeIssue
} from './artifact-json-value-guards.ts';

export const CONTROL_EVENT_ENVELOPE_KINDS = Object.keys(
    { event: true, diagnostic: true, stats: true, report: true } satisfies Record<ControlEventEnvelope['kind'], true>
) as readonly ControlEventEnvelope['kind'][];

interface ControlRunEvidenceCollections {
    readonly results: readonly ControlResultEnvelope[];
    readonly events: readonly ControlEventEnvelope[];
    readonly stats: readonly ControlEventEnvelope[];
    readonly reports: readonly ControlEventEnvelope[];
    readonly heartbeats: readonly ControlHeartbeatEnvelope[];
}

/** Where a queued command sits in control-run.json. */
interface QueuedCommandLocation {
    readonly runId: string;
    readonly path: string;
}

const AGENT_TIMESTAMPS = [
    'registeredAtEpochMs',
    'disconnectedAtEpochMs',
    'lastSeenAtEpochMs',
    'lastHeartbeatAtEpochMs'
] as const;

const AGENT_COUNTERS = [
    'connectionSequence',
    'reconnectCount',
    'receivedResultCount',
    'receivedEventCount'
] as const;

/** Command, result, event and heartbeat entries are decoded by the control protocol owner. */
export function decodeControlRunSnapshot(value: unknown): Either<string, ControlRunSnapshot> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('the snapshot must be a JSON object');
    }
    const runId = value.runId;
    const issue = toFirstDecodeIssue([
        [isNonEmptyText(runId), 'runId must be a non-empty string'],
        [isFiniteNumber(value.createdAtEpochMs), 'createdAtEpochMs must be a finite number'],
        [isFiniteNumber(value.updatedAtEpochMs), 'updatedAtEpochMs must be a finite number']
    ]);
    if (
        issue !== undefined || !isNonEmptyText(runId) || !isFiniteNumber(value.createdAtEpochMs) ||
        !isFiniteNumber(value.updatedAtEpochMs)
    ) {
        return Either.ofLeft(issue ?? 'runId must be a non-empty string');
    }
    const agents = decodeArrayItems(value.agents, 'agents', decodeControlAgentSnapshot);
    const commands = decodeArrayItems(
        value.commands,
        'commands',
        (command, path) => decodeQueuedCommandSnapshot(command, { runId, path })
    );
    const evidence = decodeControlRunEvidenceCollections(value);
    if (agents.right === undefined || commands.right === undefined || evidence.right === undefined) {
        return Either.ofLeft(agents.left ?? commands.left ?? evidence.left ?? 'snapshot entries did not decode');
    }
    const resultEnvelopes = evidence.right.results.map((envelope) => toRetainedControlResultEnvelope(envelope, commands.right ?? []));
    const invalid = resultEnvelopes.find((envelope) =>
        envelope.runId !== runId || (commands.right?.some((command) => command.envelope.commandId === envelope.commandId) && !isAdmissibleControlRtcCaptureResult({
            command: commands.right?.find((command) => command.envelope.commandId === envelope.commandId)?.envelope,
            envelope,
            commands: commands.right ?? [],
            results: resultEnvelopes
        }))
    );
    return invalid === undefined
        ? Either.ofRight({
            runId,
            createdAtEpochMs: value.createdAtEpochMs,
            updatedAtEpochMs: value.updatedAtEpochMs,
            agents: agents.right,
            commands: commands.right,
            ...evidence.right,
            results: resultEnvelopes
        })
        : Either.ofLeft(`results: required application or attribution is invalid for ${invalid.commandId}`);
}

function decodeControlRunEvidenceCollections(
    value: RallarBlackBoxTestRecord
): Either<string, ControlRunEvidenceCollections> {
    const results = decodeClientEnvelopes(value.results, 'results', ['result']);
    const events = decodeClientEnvelopes(value.events, 'events', CONTROL_EVENT_ENVELOPE_KINDS);
    const stats = decodeClientEnvelopes(value.stats, 'stats', CONTROL_EVENT_ENVELOPE_KINDS);
    const reports = decodeClientEnvelopes(value.reports, 'reports', CONTROL_EVENT_ENVELOPE_KINDS);
    const heartbeats = decodeClientEnvelopes(value.heartbeats, 'heartbeats', ['heartbeat']);
    if (
        results.right === undefined || events.right === undefined || stats.right === undefined ||
        reports.right === undefined || heartbeats.right === undefined
    ) {
        return Either.ofLeft(
            results.left ?? events.left ?? stats.left ?? reports.left ?? heartbeats.left ??
                'snapshot evidence did not decode'
        );
    }
    return Either.ofRight({
        results: results.right,
        events: events.right,
        stats: stats.right,
        reports: reports.right,
        heartbeats: heartbeats.right
    });
}

function decodeControlAgentSnapshot(value: unknown, path: string): Either<string, ControlAgentSnapshot> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`${path} must be a JSON object`);
    }
    const identity = value.identity === undefined
        ? Either.ofRight<string, Pick<ControlAgentSnapshot, 'identity'>>({})
        : decodeControlAgentIdentity(value.identity)
            .mapBoth((identityIssue) => `${path}.${identityIssue}`, (decoded) => ({ identity: decoded }));
    const issue = toFirstDecodeIssue([
        [isNonEmptyText(value.runId), `${path}.runId must be a non-empty string`],
        [isNonEmptyText(value.agentId), `${path}.agentId must be a non-empty string`],
        [typeof value.connected === 'boolean', `${path}.connected must be a boolean`],
        ...AGENT_TIMESTAMPS.map((key) =>
            [isAbsentOrFiniteNumber(value[key]), `${path}.${key} must be a finite number when present`] as const
        ),
        [isAbsentOrNonEmptyText(value.status), `${path}.status must be a non-empty string when present`],
        [identity.left === undefined, identity.left ?? ''],
        ...AGENT_COUNTERS.map((key) => [isFiniteNumber(value[key]), `${path}.${key} must be a finite number`] as const),
        [isTextArray(value.completedCommandIds), `${path}.completedCommandIds must be an array of strings`],
        [isTextArray(value.resumeCompletedCommandIds), `${path}.resumeCompletedCommandIds must be an array of strings`]
    ]);
    if (issue !== undefined) {
        return Either.ofLeft(issue);
    }
    return Either.ofRight({ ...value, ...identity.right } as ControlAgentSnapshot);
}

function decodeQueuedCommandSnapshot(
    value: unknown,
    location: QueuedCommandLocation
): Either<string, ControlQueuedCommandSnapshot> {
    const path = location.path;
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`${path} must be a JSON object`);
    }
    const envelope = value.envelope;
    const issue = toFirstDecodeIssue([
        [isJsonRecordValue(envelope), `${path}.envelope must be a JSON object`],
        [
            !isJsonRecordValue(envelope) || isAbsentOrNonEmptyText(envelope.agentId),
            `${path}.envelope.agentId must be a non-empty string when present`
        ],
        [isFiniteNumber(value.queuedAtEpochMs), `${path}.queuedAtEpochMs must be a finite number`],
        [
            isAbsentOrFiniteNumber(value.dispatchedAtEpochMs),
            `${path}.dispatchedAtEpochMs must be a finite number when present`
        ],
        [
            isAbsentOrFiniteNumber(value.completedAtEpochMs),
            `${path}.completedAtEpochMs must be a finite number when present`
        ],
        [isFiniteNumber(value.dispatchCount), `${path}.dispatchCount must be a finite number`]
    ]);
    if (issue !== undefined || !isJsonRecordValue(envelope)) {
        return Either.ofLeft(issue ?? `${path}.envelope must be a JSON object`);
    }
    // The protocol parser compares the expected agent only when the envelope addresses one.
    const parsed = parseControlServerMessage(envelope, {
        runId: location.runId,
        agentId: isNonEmptyText(envelope.agentId) ? envelope.agentId : ''
    });
    return parsed.ok
        ? Either.ofRight(value as ControlQueuedCommandSnapshot)
        : Either.ofLeft(`${path}.envelope is not a control command: ${parsed.error}`);
}

function decodeClientEnvelopes<Kind extends ControlClientEnvelope['kind']>(
    value: unknown,
    path: string,
    kinds: readonly Kind[]
): Either<string, readonly Extract<ControlClientEnvelope, { kind: Kind; }>[]> {
    return decodeArrayItems(value, path, (item, itemPath) => {
        if (!isJsonRecordValue(item)) {
            return Either.ofLeft(`${itemPath} must be a JSON object`);
        }
        const parsed = parseControlClientMessage(item);
        if (!parsed.ok) {
            return Either.ofLeft(`${itemPath} is not a control envelope: ${parsed.error}`);
        }
        return isControlEnvelopeKind(parsed.envelope, kinds)
            ? Either.ofRight(parsed.envelope)
            : Either.ofLeft(`${itemPath}.kind must be ${toAlternativesText(kinds)}`);
    });
}

function isControlEnvelopeKind<Kind extends ControlClientEnvelope['kind']>(
    envelope: ControlClientEnvelope,
    kinds: readonly Kind[]
): envelope is Extract<ControlClientEnvelope, { kind: Kind; }> {
    return kinds.some((kind) => envelope.kind === kind);
}
