import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeViewInvalidationMessage, hasViewInvalidatedTopic } from '@shared/api/views/view-invalidation.ts';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
    requestJson,
    requireRecord,
    type ApiV1RtcTopologyProofApi,
    type ProofJsonObject,
    type ProofSession
} from '../topology-replay/api-v1-rtc-topology-proof-api.mts';
import type { ManagedClusterProof } from './run-managed-cluster-proof.mts';
import { withExpiryWorkerStopped } from './seat-deadline-qualification.mts';
import { ViewPushProofSocket } from './view-push/view-push-proof-socket.mts';

interface AutomaticTimelineProof extends Pick<ManagedClusterProof.ScenarioInput, 'plans' | 'controls'> {
    readonly api: ApiV1RtcTopologyProofApi;
    readonly director: ProofSession;
    readonly observer: ProofSession;
}

function clocks(snapshot: ProofJsonObject) {
    const metadata = requireRecord(requireRecord(snapshot.group, 'group').metadata, 'metadata');
    assert.ok(Array.isArray(metadata.rallarRoomClocks));
    return metadata.rallarRoomClocks.map((record) => requireRecord(record, 'timeline'));
}

export async function proveAutomaticRoomTimeline({ api, director, observer, plans, controls }: AutomaticTimelineProof) {
    const [worker, writer, reader] = plans;
    assert.ok(worker && writer && reader);
    const scope = { applicationId: 'automatic-timeline', workspaceId: crypto.randomUUID() };
    const court = { ...scope, proofId: crypto.randomUUID(), groupId: 'court' };
    const lounge = { ...scope, proofId: crypto.randomUUID(), groupId: 'lounge' };
    const path = '/api/state/apps/' + scope.applicationId + '/workspaces/' + scope.workspaceId + '/groups/court';
    await api.createGroup({ ...court, owner: director });
    await api.createGroup({ ...lounge, owner: observer });
    await requestJson(reader.baseUrl, toApiMutationRequestPath(path + '/join', crypto.randomUUID()), {
        method: 'POST',
        session: observer,
        body: {}
    });
    await api.connectPresence({ ...lounge, actor: observer });
    await api.connectPresence({ ...court, actor: director });
    await requestJson(writer.baseUrl, toApiMutationRequestPath(path + '/director/appoint', crypto.randomUUID()), {
        method: 'POST',
        session: director,
        body: {}
    });
    const change = (name: string, command: object) =>
        requestJson(writer.baseUrl, toApiMutationRequestPath(path, crypto.randomUUID()), {
            method: 'PUT',
            session: director,
            body: { roomClock: { name, expectedDirectorEpoch: 1, ...command } }
        });
    const advance = {
        operation: 'advance-phase',
        phase: 'warmup',
        durationMs: 5000,
        successor: { phase: 'play', durationMs: 600_000 },
        expectedRevision: 0
    };
    await change('frozen', advance);
    const frozen = clocks(await change('frozen', { operation: 'pause', expectedRevision: 1 }))[0]!;
    assert.equal(frozen.status, 'paused');
    assert.ok(Number(frozen.remainingMs) > 0);
    const started = clocks(await change('match', advance)).find((record) => record.name === 'match')!;
    const firstEnd = started.endsAtEpochMs;
    assert.ok(typeof firstEnd === 'number');
    const extended = clocks(await change('match', { operation: 'extend-phase', durationMs: 5000, expectedRevision: 1 }))
        .find((record) => record.name === 'match')!;
    const revisedEnd = extended.endsAtEpochMs;
    assert.ok(typeof revisedEnd === 'number');
    assert.equal(revisedEnd, firstEnd + 5000);
    await requestJson(
        writer.baseUrl,
        toApiMutationRequestPath(path + '/sessions/' + director.sessionId + '/disconnect', crypto.randomUUID()),
        {
            method: 'POST',
            session: director,
            body: { generationId: court.proofId + '-generation-' + director.label, principalId: director.clientId }
        }
    );
    const read = async (origin: string) =>
        clocks(await requestJson(origin, path, { method: 'GET', session: observer }));
    await delay(Math.max(0, firstEnd + 100 - Date.now()));
    assert.deepEqual(
        (await read(writer.baseUrl)).find((record) => record.name === 'match'),
        extended,
        'Old wake cannot start play'
    );
    const socket = await ViewPushProofSocket.open({ api, session: observer, scope });
    try {
        const afterSetup = socket.frames.length;
        await withExpiryWorkerStopped({
            stopExpiry: () => controls.stop(worker.port, 'crash'),
            startExpiry: () =>
                controls.restart(worker.port, { ...worker, logPath: worker.logPath + '.timeline-restart' })
        }, async () => {
            assert.ok(Date.now() < revisedEnd, 'Worker stopped before the revised boundary');
            await delay(revisedEnd + 100 - Date.now());
            assert.deepEqual(
                (await read(reader.baseUrl)).find((record) => record.name === 'match'),
                extended,
                'Delayed wake still pending'
            );
        });
        await socket.waitForFrame((frame) => {
            if (!hasViewInvalidatedTopic(frame)) {
                return false;
            }
            const notice = decodeViewInvalidationMessage(frame);
            return notice.resource === 'room-program' && notice.groupId === court.groupId && notice.name === 'match';
        }, afterSetup);
        const expected = {
            ...extended,
            revision: 3,
            phase: 'play',
            startedBy: 'automatic',
            startedAtRevision: 3,
            startedAtEpochMs: revisedEnd,
            endsAtEpochMs: revisedEnd + 600_000,
            successor: null
        };
        for (const origin of [writer.baseUrl, reader.baseUrl]) {
            const records = await read(origin);
            assert.deepEqual(records.find((record) => record.name === 'match'), expected);
            assert.deepEqual(records.find((record) => record.name === 'frozen'), frozen);
        }
    }
    finally {
        socket.close();
    }
}
