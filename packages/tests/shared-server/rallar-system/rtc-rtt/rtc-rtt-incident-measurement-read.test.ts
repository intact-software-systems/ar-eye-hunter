import { computeRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/compute-rtc-rtt-mutation.ts';
import { readRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/read-rtc-rtt-mutation.ts';
import type { RtcRttMutationRead } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-contracts.ts';
import { validateRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/validate-rtc-rtt-mutation.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { RTC_RTT_LATEST_NAMESPACE } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { toRtcRttMeasurementStorageKey } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-storage-keys.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createRttGroupSnapshot } from './persistence/rtc-rtt-persistence-test-fixtures.ts';

const SESSION_COUNT = 50;
const NOW_EPOCH_MS = 1_000;
const RTT_COMMAND_HASH = `sha256:${'c'.repeat(64)}`;

describe('RTC RTT submission read scope', () => {
    it('reads only the measurements incident to the two endpoints and computes the global-list result', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtime, { now: () => NOW_EPOCH_MS });
        const sessionIds = Array.from({ length: SESSION_COUNT }, (_, index) => toSessionId(index));
        for (const measurement of createRingMeasurements(sessionIds)) {
            expect(await repository.putMeasurementIfNewer(measurement, NOW_EPOCH_MS + 60_000)).toBe(true);
        }
        const submission = {
            sessionIdFrom: toSessionId(0),
            sessionIdTo: toSessionId(1),
            rttMs: 3,
            createdAtEpochMs: NOW_EPOCH_MS,
            version: 2
        };
        const incidentKeys = [
            [toSessionId(48), toSessionId(0)],
            [toSessionId(49), toSessionId(0)],
            [toSessionId(0), toSessionId(1)],
            [toSessionId(0), toSessionId(2)],
            [toSessionId(49), toSessionId(1)],
            [toSessionId(1), toSessionId(2)],
            [toSessionId(1), toSessionId(3)]
        ].map(([left, right]) => toRtcRttMeasurementStorageKey(left!, right!));
        const measurementKeysRead = recordMeasurementKeysRead(runtime);

        const read = await readRtcRttMutation(repository, { rtt: submission, alSenderId: submission.sessionIdFrom });

        expect([...measurementKeysRead].sort()).toEqual([...incidentKeys].sort());
        if (read.receipt !== null) {
            throw new Error('Expected a fresh submission read');
        }
        expect(read.incidentMeasurements.map(({ entry }) => entry.key).sort()).toEqual([...incidentKeys].sort());

        const group = createRttGroupSnapshot('room-scope', sessionIds);
        const overlay: RallarOverlayTopologySnapshot = {
            sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
            state: 'active',
            overlayId: 'overlay-scope',
            groupRef: group.group,
            name: 'room-scope',
            topology: 'mesh',
            activeSessionIds: sessionIds,
            nextHopsBySessionId: { [toSessionId(0)]: [toSessionId(1)] },
            degreeLimit: 4,
            version: 1,
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1
        };
        const command = {
            rtt: submission,
            alSenderId: submission.sessionIdFrom,
            candidateGroups: [group],
            overlaySnapshotsByGroupKey: new Map([[toWebRtcGroupKey(group.group), overlay]]),
            degreeLimit: 4
        };
        const facts = {
            requestedAtEpochMs: NOW_EPOCH_MS,
            purgeAfterEpochMs: NOW_EPOCH_MS + 60_000,
            commandHash: RTT_COMMAND_HASH,
            attemptCount: 1,
            traceId: 'trace-rtc-rtt-incident-measurement-read'
        };
        const globalRead: RtcRttMutationRead = {
            ...read,
            incidentMeasurements: await repository.listMeasurementEntries()
        };

        const computed = computeRtcRttMutation({ command, read, facts });

        expect(computed).toEqual(computeRtcRttMutation({ command, read: globalRead, facts }));
        expect(() => validateRtcRttMutation({ command, read, facts, computed })).not.toThrow();
        expect(computed).toMatchObject({ outcome: 'write', receipt: { measurementVersion: 2 } });
    });
});

function toSessionId(index: number): string {
    return `session-${String(index).padStart(2, '0')}`;
}

function createRingMeasurements(sessionIds: readonly string[]): readonly RttMeasurementInfo[] {
    return sessionIds.flatMap((sessionId, index) =>
        [1, 2].map((distance) => {
            const peerId = sessionIds[(index + distance) % sessionIds.length]!;
            const [sessionIdFrom, sessionIdTo] = sessionId < peerId ? [sessionId, peerId] : [peerId, sessionId];
            return {
                sessionIdFrom,
                sessionIdTo,
                rttMs: 10 + index,
                createdAtEpochMs: NOW_EPOCH_MS - 1,
                version: 1
            };
        })
    );
}

function recordMeasurementKeysRead(runtime: FakeRuntimeStateRepository): ReadonlySet<string> {
    const keys = new Set<string>();
    const record = (namespace: string, entries: readonly RuntimeStateEntry[]): void => {
        if (namespace === RTC_RTT_LATEST_NAMESPACE) {
            for (const entry of entries) {
                keys.add(entry.key);
            }
        }
    };
    const findEntry = runtime.findEntry.bind(runtime);
    vi.spyOn(runtime, 'findEntry').mockImplementation(async (namespace, key) => {
        const entry = await findEntry(namespace, key);
        record(namespace, entry ? [entry] : []);
        return entry;
    });
    const findAllEntries = runtime.findAllEntries.bind(runtime);
    vi.spyOn(runtime, 'findAllEntries').mockImplementation(async (namespace) => {
        const entries = await findAllEntries(namespace);
        record(namespace, entries);
        return entries;
    });
    const findEntriesByPrefix = runtime.findEntriesByPrefix.bind(runtime);
    vi.spyOn(runtime, 'findEntriesByPrefix').mockImplementation(async (namespace, keyPrefix) => {
        const entries = await findEntriesByPrefix(namespace, keyPrefix);
        record(namespace, entries);
        return entries;
    });
    const findEntriesByPrefixPage = runtime.findEntriesByPrefixPage.bind(runtime);
    vi.spyOn(runtime, 'findEntriesByPrefixPage').mockImplementation(async (namespace, keyPrefix, options) => {
        const entries = await findEntriesByPrefixPage(namespace, keyPrefix, options);
        record(namespace, entries);
        return entries;
    });
    const findEntriesByKeys = runtime.findEntriesByKeys.bind(runtime);
    vi.spyOn(runtime, 'findEntriesByKeys').mockImplementation(async (namespace, entryKeys) => {
        const entries = await findEntriesByKeys(namespace, entryKeys);
        record(namespace, entries);
        return entries;
    });
    const readRuntimeStateBatch = runtime.readRuntimeStateBatch.bind(runtime);
    vi.spyOn(runtime, 'readRuntimeStateBatch').mockImplementation(async (selectors) => {
        const selections = await readRuntimeStateBatch(selectors);
        for (const selection of selections) {
            const selector = selectors.find((candidate) => candidate.selectorId === selection.selectorId);
            record(selector?.namespace ?? '', selection.entries);
        }
        return selections;
    });
    return keys;
}
