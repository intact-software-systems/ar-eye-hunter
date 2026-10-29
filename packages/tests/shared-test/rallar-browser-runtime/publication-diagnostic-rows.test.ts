import { beforeEach, expect, it } from 'vitest';

import {
    BlackBoxRallarRuntimeDiagnostics,
    createBlackBoxRallarDiagnosticsPorts
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { blackBoxRallarScopeDiagnosticsOf } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-policy.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarTransport
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-policy.ts';
import { toRallarBrowserEventInput } from '@shared-test/rallar-bb-test/browser/to-rallar-browser-event-input.ts';
import { toControlEventEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { toDistributedRunRuntimeDiagnosticRows } from '@shared-test/rallar-bb-test/distributed-run-observation/distributed-run-runtime-diagnostic-rows.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_PUBLICATION_STAGE_LIMITS } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import { ALOutboundPublicationStage } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { facade, resetFacade } from './browser-rallar-runtime-test-harness.ts';

const START_MS = 1_760_000_000_000;
const LANE_KEY = 'room.pose/room.pose.v1';
const SENTINEL = 'payload must never enter diagnostics';
const POLICY = { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } };

interface RecordedStage {
    readonly clock: { atMs: number; };
    readonly engine: InboxOutboxEngine;
    readonly stage: ALOutboundPublicationStage<string>;
    readonly emitted: BlackBoxRallarEvent[];
}

beforeEach(() => resetFacade());

/** A stage whose diagnostics sink is the harness's own outbound port, recording what the page would publish. */
function createRecordedStage(): RecordedStage {
    const clock = { atMs: START_MS };
    const emitted: BlackBoxRallarEvent[] = [];
    const diagnostics = new BlackBoxRallarRuntimeDiagnostics({
        now: () => clock.atMs,
        publish: (event) => {
            emitted.push(event);
        },
        onPublishError: (error) => {
            throw error;
        },
        transportOf: resolveBlackBoxRallarTransport,
        laneIdOf: resolveBlackBoxRallarLaneId,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf
    });
    const ports = createBlackBoxRallarDiagnosticsPorts(diagnostics, facade.rallar.diagnostics);
    const engine = new InboxOutboxEngine({ nowEpochMs: () => clock.atMs, random: () => 0.5, reportTaskFailure: () => undefined });
    const stage = new ALOutboundPublicationStage<string>({
        taskId: 'al-outbound-publication-stage',
        queueEngine: engine,
        clock: { nowMs: () => clock.atMs },
        submit: async () => {},
        settle: () => {},
        diagnostics: (event) => ports.outboundDiagnostics(event),
        limits: { ...AL_PUBLICATION_STAGE_LIMITS, maxStagedValues: 2 }
    });
    return { clock, engine, stage, emitted };
}

function stagePose(recorded: RecordedStage, resourceId: string, ttlMs = 5_000): { msgId: string; traceId: string; } {
    const message = newALUnicastMessage('self', { topicId: 'room.pose', resourceId, contextId: 'room-1' }, 'peer-1', 'room.pose.v1', {
        secret: SENTINEL
    });
    const msg = { ...message, constraints: { expiresAtMs: recorded.clock.atMs + ttlMs } };
    recorded.stage.stage({ msg, carrier: 'rtc', policy: POLICY, bytes: 96, context: resourceId });
    return { msgId: msg.id.msgId, traceId: msg.id.traceId };
}

/** Each recorded page event as the control client sends it, then the rows the Analyze view reads from them. */
function toRows(emitted: readonly BlackBoxRallarEvent[]) {
    return toDistributedRunRuntimeDiagnosticRows(emitted.map(({ kind, topic, severity, atEpochMs, data }, index) =>
        toControlEventEnvelope(
            { ...toRallarBrowserEventInput({ kind, topic, severity, atEpochMs, data }), eventId: `event-${index}`, atEpochMs },
            'run-1',
            'agent-1'
        )
    ));
}

it('turns each staging outcome and each opportunity into a readable row, a refusal the one warning', async () => {
    const recorded = createRecordedStage();
    const first = stagePose(recorded, 'entity-1');
    const second = stagePose(recorded, 'entity-1');
    const third = stagePose(recorded, 'entity-2');
    const refused = stagePose(recorded, 'entity-3');
    recorded.stage.cancel(third.msgId);
    const expiring = stagePose(recorded, 'entity-4', 0);
    recorded.clock.atMs += 1;
    await recorded.engine.executeOnce();
    await recorded.engine.stop();

    const rows = toRows(recorded.emitted);

    expect(rows.map((row) => [row.message, row.severity])).toEqual([
        [`Publication staged on ${LANE_KEY}. ${first.msgId}`, 'info'],
        [`Publication staged on ${LANE_KEY}. ${second.msgId}`, 'info'],
        [`Publication superseded on ${LANE_KEY}. ${first.msgId}`, 'info'],
        [`Publication staged on ${LANE_KEY}. ${third.msgId}`, 'info'],
        [`Publication refused on ${LANE_KEY}. ${refused.msgId}`, 'warning'],
        [`Publication cancelled on ${LANE_KEY}. ${third.msgId}`, 'info'],
        [`Publication staged on ${LANE_KEY}. ${expiring.msgId}`, 'info'],
        [`Publication expired on ${LANE_KEY}. ${expiring.msgId}`, 'info'],
        [`Publication opportunity on ${LANE_KEY}: 1 selected, 0 deferred, 1 expired.`, 'info']
    ]);
    expect(rows[2]?.identitySummary).toContain(`msgId=${first.msgId} traceId=${first.traceId}`);
    expect(rows[4]?.identitySummary).toContain(`msgId=${refused.msgId} traceId=${refused.traceId}`);
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
});

it('keeps the producer\'s message for an outbound diagnostic of another kind, and for a publication one it cannot read', () => {
    const rows = toRows([
        { kind: 'diagnostic', topic: 'rallar.browser.alm.outbound_diagnostics', atEpochMs: START_MS, data: { kind: 'congestion' } },
        {
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.outbound_diagnostics',
            atEpochMs: START_MS,
            data: { kind: 'publication-staging', laneKey: LANE_KEY, outcome: 'staged' }
        }
    ]);

    expect(rows.map((row) => row.message)).toEqual([
        'rallar.browser.alm.outbound_diagnostics',
        'rallar.browser.alm.outbound_diagnostics'
    ]);
});
