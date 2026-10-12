import { spawnSync } from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { toSafeApiTimingRecord } from '../../../apps/rallar-black-box/scripts/to-safe-api-timing-record.ts';
import { toSafeApiWsReceiptObservation } from '../../../apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts';
import type { ApiJsonObject } from '../../shared/api/api-json-value.ts';
import { toError } from '../../shared/resilience/to-error.ts';

import type { ReceiptOwnerScenario, ReceiptOwnerSink } from './full-stack-api-receipt-owner-fixture.ts';

interface ReceiptCaptureSummaryDto extends ApiJsonObject {
    readonly retainedRecords: number;
    readonly rejectedLines: number;
    readonly oversizedLines: number;
    readonly trailingPartial: boolean;
    readonly stdoutEof: boolean;
    readonly cleanup: string;
    readonly observation: string;
    readonly durableRequestCompletion: string;
    readonly effectiveFlags: { readonly timingLogs: boolean; readonly appInboxPhaseTiming: boolean; };
}

interface CapturedOwnerReceiptEvidence {
    readonly status: number | null;
    readonly text: string;
    readonly mode: number;
    readonly summary: ReceiptCaptureSummaryDto;
}

interface PendingReceiptCaptureRequestDto {
    readonly scenario: ReceiptOwnerScenario;
    readonly sink: ReceiptOwnerSink;
    readonly appInboxPhaseTiming: boolean;
}

interface PendingReceiptCaptureEffectsDto extends ApiJsonObject {
    readonly conflicted: boolean;
    readonly receiptControlMsgId: string;
    readonly nativeCalls: number;
    readonly publications: number;
    readonly clockReads: number;
    readonly releases: number;
    readonly lastReceiptReleaseAtMs: number;
    readonly receiptReleaseStatuses: readonly string[];
    readonly mutationResults: readonly boolean[];
}

interface PendingReceiptCapture {
    readonly records: readonly ApiJsonObject[];
    readonly text: string;
    readonly mode: number;
    readonly summaryMode: number;
    readonly summary: ReceiptCaptureSummaryDto;
    readonly effects: PendingReceiptCaptureEffectsDto;
}

const captureScript = 'apps/rallar-black-box/scripts/run-full-stack-api-with-timing.ts';
const BUSINESS_SOCKET_DECISION = {
    kind: 'business-socket-decision',
    serverPeerId: 'server',
    msgId: 'subject',
    senderId: 'origin',
    typeId: 'message.v1',
    topicId: 'room.notification',
    connectionId: 'origin',
    fromPeerId: 'origin',
    authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' },
    scopeDisposition: 'authorized',
    outcome: 'admitted'
};

const ACK_REJECTION = {
    kind: 'ack-rejection',
    serverPeerId: 'server',
    controlMsgId: 'ack-A',
    controlSenderId: 'recipient',
    controlCreatedAtEpochMs: 900,
    rejectionCode: 'unauthorized',
    owner: 'receipt-aggregation',
    stage: 'runtime-protocol',
    failedGuards: ['already-confirmed', 'deadline-expired'],
    validationAtEpochMs: 30000,
    deadlineAtMs: 30000
};

const CURRENTNESS_ACK_REJECTION = {
    kind: 'ack-rejection',
    serverPeerId: 'server',
    controlMsgId: 'ack-A',
    controlSenderId: 'recipient',
    controlCreatedAtEpochMs: 900,
    rejectionCode: 'unauthorized',
    owner: 'inbound-authority',
    stage: 'admission-currentness',
    connectionId: 'recipient',
    failedGuards: ['connection-closed']
};

const RELAY_ACK_REJECTION = {
    kind: 'ack-rejection',
    serverPeerId: 'server',
    controlMsgId: 'ack-A',
    controlSenderId: 'recipient',
    controlCreatedAtEpochMs: 900,
    rejectionCode: 'unauthorized',
    owner: 'ack-relay',
    stage: 'ingress-protocol',
    failedGuards: ['origin-addressee-mismatch']
};

function toReceiptOwnerChildSource(expectedRecipientPeerIds: readonly string[]): string {
    const source = (file: string) => JSON.stringify(path.resolve(file));
    return `
        import { WsQueueBoxServerReceiptAggregation } from ${source('packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts')};
        import { InboxOutboxEngine } from ${source('packages/shared/services/inbox-outbox-engine.ts')};
        import { newALAckControlMessage } from ${source('packages/shared/al-contracts/al-control.ts')};
        import { createApiV1WsReceiptObserver } from ${source('apps/api-v1/src/composition/create-api-v1-ws-receipt-observer.ts')};
        import { createConsoleRallarTimingSink } from ${source('packages/shared-server/rallar-system/observability/timing.ts')};
        const timing = createConsoleRallarTimingSink({
            enabled: true,
            logger: (line) => {
                const event = JSON.parse(line);
                console.log(JSON.stringify({
                    ...event,
                    headers: { authorization: 'AUTH_SENTINEL' },
                    error: { message: 'ERROR_SENTINEL' }
                }));
            }
        });
        const owner = new WsQueueBoxServerReceiptAggregation({
            serverPeerId: 'server', clock: { nowMs: () => 1000 }, newControlId: () => 'receipt-1',
            qosProvider: undefined, queueEngine: new InboxOutboxEngine(),
            enqueueOutbox: async (message) => ({
                message, verdict: { kind: 'admitted', durable: true, queuedAttempts: 0 },
                entries: [], trackedReceiptAlgo: 'none'
            }),
            acceptServerControl: async () => ({ kind: 'not-handled' }),
            acceptServerReceipt: async () => ({ kind: 'not-handled' }),
            receiptObserver: createApiV1WsReceiptObserver({
                enabled: true, timing, serviceId: 'api-process', publisherId: 'publisher-1'
            })
        });
        try {
            owner.recordAdmission({
                msgId: 'subject', originPeerId: 'origin',
                expectedRecipientPeerIds: ${JSON.stringify(expectedRecipientPeerIds)},
                snapshotVersion: 7, deadlineAtMs: 30000
            });
            await owner.acceptControlMessage(newALAckControlMessage(
                { v: 3, msgId: 'ack-1', senderId: 'recipient', ts: 900 },
                {
                    ackedMsgId: 'subject', fromPeerId: 'recipient', toPeerId: 'origin', originPeerId: 'origin',
                    logicalRecipientPeerId: 'recipient', carrier: 'ws', status: 'delivered', observedAtEpochMs: 901
                }
            ));
        }
        finally {
            owner.dispose();
        }
    `;
}

async function captureOwnerReceiptEvidence(expectedRecipientPeerIds: readonly string[]): Promise<CapturedOwnerReceiptEvidence> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-receipt-capture-'));
    let bodyFailed = false;
    try {
        const fixture = path.join(directory, 'owner-child.mts');
        await writeFile(fixture, toReceiptOwnerChildSource(expectedRecipientPeerIds));
        const result = spawnSync(process.execPath, ['--import', 'tsx', captureScript, directory, '--', process.execPath, '--import', 'tsx', fixture], {
            encoding: 'utf8',
            timeout: 15000,
            env: {
                ...process.env,
                RALLAR_TIMING_LOGS: 'true',
                RALLAR_APP_INBOX_PHASE_TIMING: 'true',
                TSX_TSCONFIG_PATH: path.resolve('packages/tests/tsconfig.json')
            }
        });
        const recordsPath = path.join(directory, 'api-setup-timing.jsonl');
        return {
            status: result.status,
            text: await readFile(recordsPath, 'utf8'),
            mode: (await stat(recordsPath)).mode & 0o777,
            summary: await readReceiptCaptureSummary(directory)
        };
    }
    catch (caught) {
        bodyFailed = true;
        throw toError(caught);
    }
    finally {
        await removeReceiptCaptureDirectory(directory, bodyFailed);
    }
}

async function capturePendingReceipt(captureRequest: PendingReceiptCaptureRequestDto): Promise<PendingReceiptCapture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-pending-receipt-'));
    let bodyFailed = false;
    try {
        const evidencePath = path.join(directory, 'independent-effects.json');
        const fixture = path.join(directory, 'pending-owner.mts');
        await writeFile(
            fixture,
            `import { writePendingReceiptOwnerEvidence } from ${
                JSON.stringify(path.resolve('packages/tests/rallar-black-box/full-stack-api-receipt-owner-fixture.ts'))
            }; await writePendingReceiptOwnerEvidence(${JSON.stringify(evidencePath)}, ${JSON.stringify(captureRequest.scenario)}, ${
                JSON.stringify(captureRequest.sink)
            });`
        );
        const child = spawnSync(process.execPath, ['--import', 'tsx', captureScript, directory, '--', process.execPath, '--import', 'tsx', fixture], {
            encoding: 'utf8',
            timeout: 15000,
            env: {
                ...process.env,
                RALLAR_TIMING_LOGS: 'true',
                RALLAR_APP_INBOX_PHASE_TIMING: String(captureRequest.appInboxPhaseTiming),
                TSX_TSCONFIG_PATH: path.resolve('packages/tests/tsconfig.json')
            }
        });
        const startupDiagnostic = child.stderr === 'API timing capture failed: configuration\n'
            ? 'API timing capture failed: configuration'
            : 'The recorder must admit the selected configuration and start its owner child.';
        expect(child.status, startupDiagnostic).toBe(0);
        const effects = await readPendingReceiptCaptureEffects(evidencePath);
        expect(effects.conflicted).toBe(true);
        const recordsPath = path.join(directory, 'api-setup-timing.jsonl');
        const text = await readFile(recordsPath, 'utf8');
        return {
            effects,
            text,
            records: toReceiptCaptureRecords(text),
            mode: (await stat(recordsPath)).mode & 0o777,
            summaryMode: (await stat(path.join(directory, 'api-setup-timing-summary.json'))).mode & 0o777,
            summary: await readReceiptCaptureSummary(directory)
        };
    }
    catch (caught) {
        bodyFailed = true;
        throw toError(caught);
    }
    finally {
        await removeReceiptCaptureDirectory(directory, bodyFailed);
    }
}

function isReceiptCaptureObject(value: unknown): value is ApiJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toReceiptCaptureObject(serialized: string): ApiJsonObject {
    const value: unknown = JSON.parse(serialized);
    if (!isReceiptCaptureObject(value)) {
        throw new Error('Receipt capture artifact must be a JSON object.');
    }
    return value;
}

function toReceiptCaptureRecords(text: string): readonly ApiJsonObject[] {
    return text.trim().split('\n').filter(Boolean).map((line) => {
        const record = toReceiptCaptureObject(line);
        if (!isReceiptCaptureObject(record.wsReceipt)) {
            throw new Error('Receipt capture record must contain an observation object.');
        }
        return record.wsReceipt;
    });
}

async function readReceiptCaptureSummary(directory: string): Promise<ReceiptCaptureSummaryDto> {
    const summary = toReceiptCaptureObject(await readFile(path.join(directory, 'api-setup-timing-summary.json'), 'utf8'));
    expect(summary).toMatchObject({
        retainedRecords: expect.any(Number),
        rejectedLines: expect.any(Number),
        oversizedLines: expect.any(Number),
        trailingPartial: expect.any(Boolean),
        stdoutEof: expect.any(Boolean),
        cleanup: expect.any(String),
        observation: expect.any(String),
        durableRequestCompletion: expect.any(String),
        effectiveFlags: { timingLogs: expect.any(Boolean), appInboxPhaseTiming: expect.any(Boolean) }
    });
    return summary as ReceiptCaptureSummaryDto;
}

async function readPendingReceiptCaptureEffects(evidencePath: string): Promise<PendingReceiptCaptureEffectsDto> {
    const effects = toReceiptCaptureObject(await readFile(evidencePath, 'utf8'));
    expect(effects).toMatchObject({
        conflicted: expect.any(Boolean),
        receiptControlMsgId: expect.any(String),
        nativeCalls: expect.any(Number),
        publications: expect.any(Number),
        clockReads: expect.any(Number),
        releases: expect.any(Number),
        lastReceiptReleaseAtMs: expect.any(Number)
    });
    expect(Array.isArray(effects.receiptReleaseStatuses) && effects.receiptReleaseStatuses.every((status) => typeof status === 'string')).toBe(true);
    expect(Array.isArray(effects.mutationResults) && effects.mutationResults.every((result) => typeof result === 'boolean')).toBe(true);
    return effects as PendingReceiptCaptureEffectsDto;
}

/** Owns temporary recorder cleanup without replacing the failure that produced its evidence. */
async function removeReceiptCaptureDirectory(directory: string, bodyFailed: boolean): Promise<void> {
    try {
        await rm(directory, { recursive: true, force: true });
    }
    catch (caught) {
        const error = toError(caught);
        if (!bodyFailed) {
            throw error;
        }
        try {
            console.error('Receipt capture cleanup failed after body failure:', error);
        }
        catch { /* Keep the primary failure even when its cleanup diagnostic fails. */ }
    }
}

describe('full-stack private upstream receipt capture', () => {
    it('retains closed terminal aggregate, currentness and relay refusals with their actual owner and stage', () => {
        expect(toSafeApiWsReceiptObservation(ACK_REJECTION)).toEqual(ACK_REJECTION);
        const absent = { ...ACK_REJECTION, stage: 'ingress-protocol', failedGuards: ['aggregate-absent'], deadlineAtMs: undefined };
        expect(toSafeApiWsReceiptObservation(absent)).toEqual({
            kind: 'ack-rejection',
            serverPeerId: 'server',
            controlMsgId: 'ack-A',
            controlSenderId: 'recipient',
            controlCreatedAtEpochMs: 900,
            rejectionCode: 'unauthorized',
            owner: 'receipt-aggregation',
            stage: 'ingress-protocol',
            failedGuards: ['aggregate-absent'],
            validationAtEpochMs: 30000
        });
        for (const stage of ['post-authorizer-currentness', 'admission-currentness']) {
            for (const guard of ['connection-replaced', 'connection-closed']) {
                const current = {
                    kind: 'ack-rejection',
                    serverPeerId: 'server',
                    controlMsgId: 'ack-A',
                    controlSenderId: 'recipient',
                    controlCreatedAtEpochMs: 900,
                    rejectionCode: 'unauthorized',
                    owner: 'inbound-authority',
                    stage,
                    connectionId: 'recipient',
                    failedGuards: [guard]
                };
                expect(toSafeApiWsReceiptObservation(current)).toEqual(current);
            }
        }
        const relay = {
            kind: 'ack-rejection',
            serverPeerId: 'server',
            controlMsgId: 'ack-A',
            controlSenderId: 'recipient',
            controlCreatedAtEpochMs: 900,
            rejectionCode: 'unauthorized',
            owner: 'ack-relay',
            stage: 'ingress-protocol',
            failedGuards: ['origin-addressee-mismatch']
        };
        expect(toSafeApiWsReceiptObservation(relay)).toEqual(relay);
    });

    it.each([
        { serverPeerId: undefined },
        { serverPeerId: 'unsafe identity' },
        { controlMsgId: undefined },
        { controlMsgId: 'unsafe identity' },
        { controlSenderId: undefined },
        { controlSenderId: 'unsafe identity' },
        { controlCreatedAtEpochMs: undefined },
        { controlCreatedAtEpochMs: -1 },
        { controlCreatedAtEpochMs: NaN },
        { controlCreatedAtEpochMs: Infinity },
        { rejectionCode: 'malformed' },
        { rejectionCode: undefined },
        { owner: undefined },
        { owner: 'unknown' },
        { stage: undefined },
        { stage: 'unknown' },
        { stage: 'admission-currentness' },
        { failedGuards: undefined },
        { failedGuards: [] },
        { failedGuards: 'deadline-expired' },
        { failedGuards: ['deadline-expired', 'deadline-expired'] },
        { failedGuards: ['unknown'] },
        { failedGuards: ['connection-replaced'] },
        { failedGuards: ['aggregate-absent', 'deadline-expired'] },
        { failedGuards: ['aggregate-absent'] },
        { failedGuards: Array.from({ length: 7 }, () => 'deadline-expired') },
        { validationAtEpochMs: undefined },
        { validationAtEpochMs: -1 },
        { validationAtEpochMs: NaN },
        { validationAtEpochMs: Infinity },
        { deadlineAtMs: undefined },
        { deadlineAtMs: null },
        { deadlineAtMs: -1 },
        { deadlineAtMs: Infinity }
    ])('refuses the whole terminal ACK record for an invalid owner/stage/guard/identity/clock combination %j', (corruption) => {
        expect(toSafeApiWsReceiptObservation(ACK_REJECTION)).toEqual(ACK_REJECTION);
        expect(toSafeApiWsReceiptObservation({ ...ACK_REJECTION, ...corruption })).toBeUndefined();
    });

    it.each([
        { stage: 'runtime-protocol' },
        { connectionId: undefined },
        { connectionId: 'unsafe identity' },
        { failedGuards: ['connection-closed', 'connection-replaced'] },
        { failedGuards: ['deadline-expired'] }
    ])('refuses an invalid currentness requirement independently of aggregate clocks %j', (corruption) => {
        expect(toSafeApiWsReceiptObservation(CURRENTNESS_ACK_REJECTION)).toEqual(CURRENTNESS_ACK_REJECTION);
        expect(toSafeApiWsReceiptObservation({ ...CURRENTNESS_ACK_REJECTION, ...corruption })).toBeUndefined();
    });

    it.each([
        { stage: 'admission-currentness' },
        { failedGuards: ['origin-addressee-mismatch', 'origin-addressee-mismatch'] },
        { failedGuards: ['aggregate-absent'] }
    ])('refuses an invalid relay requirement independently of aggregate clocks %j', (corruption) => {
        expect(toSafeApiWsReceiptObservation(RELAY_ACK_REJECTION)).toEqual(RELAY_ACK_REJECTION);
        expect(toSafeApiWsReceiptObservation({ ...RELAY_ACK_REJECTION, ...corruption })).toBeUndefined();
    });

    it.each([
        { baseline: CURRENTNESS_ACK_REJECTION, clock: 'validationAtEpochMs' },
        { baseline: CURRENTNESS_ACK_REJECTION, clock: 'deadlineAtMs' },
        { baseline: RELAY_ACK_REJECTION, clock: 'validationAtEpochMs' },
        { baseline: RELAY_ACK_REJECTION, clock: 'deadlineAtMs' }
    ])('refuses supplied $clock at the non-aggregate owner $baseline.owner', ({ baseline, clock }) => {
        expect(toSafeApiWsReceiptObservation(baseline)).toEqual(baseline);
        expect(toSafeApiWsReceiptObservation({ ...baseline, [clock]: 30000 })).toBeUndefined();
    });

    it('drops raw, auth, configuration and error extras from terminal ACK timing and preserves operation-kind equality', () => {
        const wire = {
            type: 'rallar.timing',
            component: 'ws-receipt',
            operation: 'ack-rejection',
            status: 'ok',
            durationMs: 0,
            atEpochMs: 30000,
            wsReceipt: {
                ...ACK_REJECTION,
                raw: 'RAW_SENTINEL',
                payload: 'PAYLOAD_SENTINEL',
                authorization: 'AUTH_SENTINEL',
                configuration: 'CONFIG_SENTINEL',
                error: 'ERROR_SENTINEL'
            }
        };
        expect(toSafeApiTimingRecord(JSON.stringify(wire))).toEqual({ ...wire, wsReceipt: ACK_REJECTION });
        expect(toSafeApiTimingRecord(JSON.stringify({ ...wire, operation: 'ack-count' }))).toBeUndefined();
    });

    it.each(['admitted', 'pending-admission', 'duplicate', 'not-admitted', 'resync-required', 'disposed'])(
        'retains the closed ordinary business outcome %s',
        (outcome) => {
            const actual = { ...BUSINESS_SOCKET_DECISION, outcome };
            expect(toSafeApiWsReceiptObservation(actual)).toEqual(actual);
        }
    );

    it('retains an actual closed rejection and truthful absent socket scope without inventing identities', () => {
        const rejected = { ...BUSINESS_SOCKET_DECISION, outcome: 'rejected', rejectionCode: 'unauthorized' };
        expect(toSafeApiWsReceiptObservation(rejected)).toEqual(rejected);
        const absent = { ...rejected, fromPeerId: undefined, authenticatedScope: undefined, scopeDisposition: 'unobserved' };
        expect(toSafeApiWsReceiptObservation(absent)).toEqual({
            kind: 'business-socket-decision',
            serverPeerId: 'server',
            msgId: 'subject',
            senderId: 'origin',
            typeId: 'message.v1',
            topicId: 'room.notification',
            connectionId: 'origin',
            scopeDisposition: 'unobserved',
            outcome: 'rejected',
            rejectionCode: 'unauthorized'
        });
    });

    it.each(['malformed', 'unsupported', 'unauthorized', 'oversized', 'capacity'])('retains the closed ordinary rejection code %s', (rejectionCode) => {
        const rejected = { ...BUSINESS_SOCKET_DECISION, outcome: 'rejected', rejectionCode };
        expect(toSafeApiWsReceiptObservation(rejected)).toEqual(rejected);
    });

    it('retains real business and receipt observations with AppInbox phase timing off', async () => {
        const captured = await capturePendingReceipt({ scenario: 'native-return', sink: 'collecting', appInboxPhaseTiming: false });
        const { records, effects } = captured;
        expect(effects.conflicted).toBe(true);
        expect(effects.nativeCalls).toBeGreaterThan(0);
        expect(effects.releases).toBeGreaterThan(0);
        expect(effects.receiptReleaseStatuses).toContain('COMPLETED');
        expect(records).toContainEqual({
            kind: 'business-socket-decision',
            serverPeerId: 'server',
            msgId: 'subject',
            senderId: 'origin',
            typeId: 'message.v1',
            topicId: 'room.notification',
            connectionId: 'origin',
            fromPeerId: 'origin',
            authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' },
            scopeDisposition: 'authorized',
            outcome: 'admitted'
        });
        expect(records.filter((record) => record.kind === 'ack-count')).toEqual([
            expect.objectContaining({
                serverPeerId: 'server',
                controlMsgId: 'ack-1',
                source: 'local',
                outcome: 'complete',
                ack: expect.objectContaining({ ackedMsgId: 'subject', logicalRecipientPeerId: 'recipient', carrier: 'ws', status: 'delivered' }),
                before: expect.objectContaining({ expectedRecipientPeerIds: ['recipient'], confirmedRecipientPeerIds: [], snapshotVersion: 7 }),
                after: expect.objectContaining({ expectedRecipientPeerIds: ['recipient'], confirmedRecipientPeerIds: ['recipient'], snapshotVersion: 7 })
            })
        ]);
        expect(records).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'receipt-work',
                receiptControlMsgId: effects.receiptControlMsgId,
                effectKind: 'dequeue-message',
                callbackOutcome: 'completed'
            }),
            expect.objectContaining({
                kind: 'receipt-transport',
                receiptControlMsgId: effects.receiptControlMsgId,
                serverPeerId: 'server',
                transport: 'recipient',
                nativeCall: 'returned',
                outcome: 'sent',
                connectionId: 'origin',
                receipt: expect.objectContaining({
                    msgId: 'subject',
                    originPeerId: 'origin',
                    expectedRecipientPeerIds: ['recipient'],
                    confirmedRecipientPeerIds: ['recipient'],
                    phase: 'complete',
                    snapshotVersion: 7
                })
            })
        ]));
        expect(captured.mode).toBe(0o600);
        expect(captured.summaryMode).toBe(0o600);
        expect(captured.summary.retainedRecords).toBe(records.length);
        expect(captured.summary.rejectedLines).toBeGreaterThan(0);
        expect(captured.summary).toMatchObject({
            effectiveFlags: { timingLogs: true, appInboxPhaseTiming: false },
            oversizedLines: 0,
            trailingPartial: false,
            stdoutEof: true,
            childExitCode: 0,
            childSignal: null,
            childFailure: null,
            captureFailure: null,
            cleanup: 'reaped',
            observation: 'partial',
            durableRequestCompletion: 'unverified'
        });
        expect(captured.text).not.toMatch(/AUTH_SENTINEL|PAYLOAD_SENTINEL|ERROR_SENTINEL|CONFIG_SENTINEL|authorization|headers/);
        console.log(
            'Phase-off recorder witness:',
            JSON.stringify({
                effects: {
                    conflicted: effects.conflicted,
                    receiptControlMsgId: effects.receiptControlMsgId,
                    nativeCalls: effects.nativeCalls,
                    publications: effects.publications,
                    clockReads: effects.clockReads,
                    releases: effects.releases,
                    receiptReleaseStatuses: effects.receiptReleaseStatuses
                },
                records,
                permissions: { records: captured.mode, summary: captured.summaryMode },
                summary: captured.summary
            })
        );
    });

    it.each([
        { serverPeerId: 'unsafe identity sentinel' },
        { serverPeerId: undefined },
        { msgId: 'unsafe identity sentinel' },
        { senderId: 'unsafe identity sentinel' },
        { typeId: 'unsafe identity sentinel' },
        { topicId: 'unsafe identity sentinel' },
        { connectionId: 'unsafe identity sentinel' },
        { msgId: undefined },
        { senderId: undefined },
        { typeId: undefined },
        { topicId: undefined },
        { connectionId: undefined },
        { fromPeerId: 'unsafe identity sentinel' },
        { fromPeerId: null },
        { authenticatedScope: null },
        { authenticatedScope: { applicationId: 'unsafe identity sentinel', workspaceId: 'workspace' } },
        { authenticatedScope: { applicationId: 'app', workspaceId: 'unsafe identity sentinel' } },
        { authenticatedScope: { applicationId: 'app' } },
        { scopeDisposition: 'forged' },
        { scopeDisposition: undefined },
        { outcome: 'control' },
        { outcome: 'delivered' },
        { outcome: undefined },
        { outcome: 'rejected', rejectionCode: undefined },
        { outcome: 'rejected', rejectionCode: 'ERROR_SENTINEL' },
        { rejectionCode: 'ERROR_SENTINEL' }
    ])('rejects the entire new record with unsafe supplied business fields %j', (corruption) => {
        expect(toSafeApiWsReceiptObservation(BUSINESS_SOCKET_DECISION)).toEqual(BUSINESS_SOCKET_DECISION);
        expect(toSafeApiWsReceiptObservation({ ...BUSINESS_SOCKET_DECISION, ...corruption })).toBeUndefined();
    });

    it('drops payload, auth, error and configuration extras and requires the existing operation-kind match', () => {
        const wire = {
            type: 'rallar.timing',
            component: 'ws-receipt',
            operation: 'business-socket-decision',
            status: 'ok',
            durationMs: 0,
            atEpochMs: 1000,
            serviceId: 'api-process',
            details: { publisherId: 'publisher-1', configuration: 'CONFIG_SENTINEL' },
            headers: { authorization: 'AUTH_SENTINEL' },
            error: { message: 'ERROR_SENTINEL' },
            wsReceipt: {
                ...BUSINESS_SOCKET_DECISION,
                payload: 'PAYLOAD_SENTINEL',
                authorization: 'AUTH_SENTINEL',
                error: 'ERROR_SENTINEL',
                configuration: 'CONFIG_SENTINEL',
                authenticatedScope: { ...BUSINESS_SOCKET_DECISION.authenticatedScope, authorization: 'AUTH_SENTINEL' }
            }
        };
        const safe = toSafeApiTimingRecord(JSON.stringify(wire));
        expect(safe).toEqual({
            type: 'rallar.timing',
            component: 'ws-receipt',
            operation: 'business-socket-decision',
            status: 'ok',
            durationMs: 0,
            atEpochMs: 1000,
            serviceId: 'api-process',
            details: { publisherId: 'publisher-1' },
            wsReceipt: BUSINESS_SOCKET_DECISION
        });
        expect(JSON.stringify(safe)).not.toMatch(/PAYLOAD_SENTINEL|AUTH_SENTINEL|ERROR_SENTINEL|CONFIG_SENTINEL/);
        expect(toSafeApiTimingRecord(JSON.stringify({ ...wire, operation: 'socket-decision' }))).toBeUndefined();
    });

    it.each(
        [
            ['native-return', { transport: 'recipient', nativeCall: 'returned', outcome: 'sent' }],
            ['later-throw', { transport: 'recipient', nativeCall: 'returned', outcome: 'threw' }],
            ['closed', { transport: 'recipient', nativeCall: 'not-called', outcome: 'not-ready' }],
            ['native-throw', { transport: 'recipient', nativeCall: 'invoked', outcome: 'threw' }],
            ['publish-return', { transport: 'cluster-receipt', publisherCall: 'returned', outcome: 'not-ready', submissionAttempted: false }],
            ['publish-throw', { transport: 'cluster-receipt', publisherCall: 'invoked', outcome: 'threw' }],
            ['direct-failure', { transport: 'cluster-receipt', publisherCall: 'invoked', outcome: 'threw' }]
        ] as const
    )('retains real pending receipt %s through the child recorder', async (scenario, transport) => {
        const captured = await capturePendingReceipt({ scenario, sink: 'collecting', appInboxPhaseTiming: true });
        const { records, effects } = captured;
        expect(records).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'receipt-outbox',
                receiptControlMsgId: effects.receiptControlMsgId,
                verdict: expect.objectContaining({ kind: 'pending' })
            }),
            expect.objectContaining({
                kind: 'receipt-work',
                receiptControlMsgId: effects.receiptControlMsgId,
                effectKind: 'admit-message',
                callbackOutcome: 'completed'
            }),
            expect.objectContaining({
                kind: 'receipt-work',
                receiptControlMsgId: effects.receiptControlMsgId,
                effectKind: 'dequeue-message',
                callbackOutcome: 'completed'
            }),
            expect.objectContaining({ kind: 'receipt-transport', receiptControlMsgId: effects.receiptControlMsgId, ...transport })
        ]));
        expect(effects.receiptReleaseStatuses).toContain(scenario === 'native-return' ? 'COMPLETED' : 'RETRY');
        if (scenario === 'native-return') {
            expect(effects.nativeCalls).toBeGreaterThan(0);
            expect(effects.releases).toBeGreaterThan(0);
            expect(captured.mode).toBe(0o600);
            expect(records).toContainEqual(expect.objectContaining({
                kind: 'business-socket-decision',
                serverPeerId: 'server',
                msgId: 'subject',
                senderId: 'origin',
                typeId: 'message.v1',
                topicId: 'room.notification',
                connectionId: 'origin',
                fromPeerId: 'origin',
                authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' },
                scopeDisposition: 'authorized',
                outcome: 'admitted'
            }));
        }
        if (scenario === 'publish-return') {
            expect(records).toContainEqual(
                expect.objectContaining({
                    kind: 'receipt-publication',
                    receiptControlMsgId: effects.receiptControlMsgId,
                    publishCall: 'returned',
                    directCall: 'returned',
                    outcome: 'returned',
                    directStatus: 'no-recipients',
                    sentCount: 0
                })
            );
        }
        if (scenario === 'publish-throw') {
            expect(records).toContainEqual(
                expect.objectContaining({
                    kind: 'receipt-publication',
                    receiptControlMsgId: effects.receiptControlMsgId,
                    publishCall: 'invoked',
                    directCall: 'not-called',
                    outcome: 'threw'
                })
            );
        }
        if (scenario === 'direct-failure') {
            expect(records).toContainEqual(
                expect.objectContaining({
                    kind: 'receipt-publication',
                    receiptControlMsgId: effects.receiptControlMsgId,
                    publishCall: 'returned',
                    directCall: 'returned',
                    outcome: 'threw',
                    directStatus: 'failed',
                    failedCount: 1
                })
            );
        }
    });

    it('preserves actual effects, work release and owned clock reads with absent, mutating or throwing sinks', async () => {
        const baseline = await capturePendingReceipt({ scenario: 'native-return', sink: 'collecting', appInboxPhaseTiming: true });
        for (const sink of ['disabled', 'mutating', 'throwing'] as const) {
            const captured = await capturePendingReceipt({ scenario: 'native-return', sink, appInboxPhaseTiming: true });
            expect(captured.effects).toMatchObject({
                nativeCalls: baseline.effects.nativeCalls,
                publications: baseline.effects.publications,
                clockReads: baseline.effects.clockReads,
                releases: baseline.effects.releases,
                receiptReleaseStatuses: baseline.effects.receiptReleaseStatuses,
                conflicted: true
            });
            expect(captured.effects.nativeCalls).toBeGreaterThan(0);
            expect(captured.effects.releases).toBeGreaterThan(0);
            if (sink === 'mutating') {
                expect(captured.effects.mutationResults.length).toBeGreaterThan(0);
                expect(captured.effects.mutationResults.every((result) => result === false)).toBe(true);
            }
            if (sink === 'disabled') {
                expect(captured.records).toEqual([]);
            }
        }
    });

    it('publishes transport evidence after the actual work release clock', async () => {
        const baseline = await capturePendingReceipt({ scenario: 'native-return', sink: 'collecting', appInboxPhaseTiming: true });
        const captured = await capturePendingReceipt({ scenario: 'native-return', sink: 'clock-mutating', appInboxPhaseTiming: true });
        expect(captured.effects.lastReceiptReleaseAtMs).toBe(baseline.effects.lastReceiptReleaseAtMs);
        expect(captured.effects.lastReceiptReleaseAtMs).toBe(1700000000000);
    });

    it('rejects unsafe new work records entirely while retaining the transport evidence', async () => {
        const captured = await capturePendingReceipt({ scenario: 'native-return', sink: 'unsafe', appInboxPhaseTiming: true });
        expect(captured.text).not.toContain('unsafe identity sentinel');
        expect(captured.records).not.toContainEqual(expect.objectContaining({ kind: 'receipt-work' }));
        expect(captured.records).toContainEqual(expect.objectContaining({ kind: 'receipt-transport' }));
        expect(captured.summary.rejectedLines).toBeGreaterThan(0);
        expect(captured.mode).toBe(0o600);
    });

    it.each(
        [
            { sink: 'unsafe-transport', kind: 'receipt-transport', scenario: 'native-return' },
            { sink: 'unsafe-publication', kind: 'receipt-publication', scenario: 'publish-return' }
        ] as const
    )('rejects an unsafe $kind at the actual recorder boundary', async ({ sink, kind, scenario }) => {
        const captured = await capturePendingReceipt({ scenario, sink, appInboxPhaseTiming: true });
        expect(captured.text).not.toContain('unsafe identity sentinel');
        expect(captured.records).not.toContainEqual(expect.objectContaining({ kind }));
        expect(captured.records).toContainEqual(expect.objectContaining({ kind: 'receipt-work' }));
        expect(captured.summary.rejectedLines).toBeGreaterThan(0);
        expect(captured.mode).toBe(0o600);
    });

    it('retains actual owner-produced count and outbox fields through the real child recorder', async () => {
        const captured = await captureOwnerReceiptEvidence(['recipient']);
        expect(captured.status).toBe(0);
        const records = captured.text.trim().split('\n').filter(Boolean).map(toReceiptCaptureObject);
        expect(records).toMatchObject([
            {
                component: 'ws-receipt',
                serviceId: 'api-process',
                details: { publisherId: 'publisher-1' },
                wsReceipt: {
                    kind: 'receipt-outbox',
                    receiptControlMsgId: 'receipt-1',
                    trackedReceiptAlgo: 'none',
                    verdict: { kind: 'admitted', durable: true, queuedAttempts: 0 },
                    receipt: {
                        msgId: 'subject',
                        originPeerId: 'origin',
                        expectedRecipientPeerIds: ['recipient'],
                        confirmedRecipientPeerIds: ['recipient'],
                        phase: 'complete',
                        snapshotVersion: 7,
                        observedAtEpochMs: 1000
                    }
                }
            },
            {
                component: 'ws-receipt',
                serviceId: 'api-process',
                details: { publisherId: 'publisher-1' },
                wsReceipt: {
                    kind: 'ack-count',
                    controlMsgId: 'ack-1',
                    source: 'local',
                    countAtEpochMs: 1000,
                    outcome: 'complete',
                    ack: { ackedMsgId: 'subject', observedAtEpochMs: 901 },
                    before: { expectedRecipientPeerIds: ['recipient'], confirmedRecipientPeerIds: [], snapshotVersion: 7, deadlineAtMs: 30000 },
                    after: { expectedRecipientPeerIds: ['recipient'], confirmedRecipientPeerIds: ['recipient'] }
                }
            }
        ]);
        expect(captured.text).not.toMatch(/AUTH_SENTINEL|ERROR_SENTINEL|authorization|headers/);
        expect(captured.mode).toBe(0o600);
        expect(captured.summary).toMatchObject({
            retainedRecords: 2,
            rejectedLines: 0,
            stdoutEof: true,
            trailingPartial: false,
            cleanup: 'reaped',
            observation: 'stream-complete',
            durableRequestCompletion: 'unverified'
        });
    });

    it('reports a rejected exact set instead of retaining a partial audience', async () => {
        const captured = await captureOwnerReceiptEvidence(['recipient', 'unsafe recipient']);
        expect(captured.status).toBe(0);
        expect(captured.text).toBe('');
        expect(captured.summary).toMatchObject({ retainedRecords: 0, rejectedLines: 1, observation: 'partial', durableRequestCompletion: 'unverified' });
    });

    it('keeps the existing 64KiB bound and loss summary for a large actual owner record', async () => {
        const audience = ['recipient', ...Array.from({ length: 4000 }, (_, index) => `peer-${index}-long-session-identity`)];
        const captured = await captureOwnerReceiptEvidence(audience);
        expect(captured.status).toBe(0);
        expect(captured.text).toBe('');
        expect(captured.summary).toMatchObject({
            retainedRecords: 0,
            oversizedLines: 1,
            observation: 'partial',
            cleanup: 'reaped',
            durableRequestCompletion: 'unverified'
        });
    });
});
