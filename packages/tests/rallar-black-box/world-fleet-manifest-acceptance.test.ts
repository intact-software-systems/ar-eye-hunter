import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    expectWorldFleetGroupAssertions,
    expectWorldFleetManifest
} from '../../../tests/playwright/rallar-black-box/expect-world-fleet-manifest.ts';
import { decodeDistributedRunManifest } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../shared-test/rallar-bb-test/distributed-run.ts';
import { computeDistributedGroupAssertionResults } from '../../shared-test/rallar-bb-test/distributed/group-assertions-evaluation.ts';
import type { RallarBlackBoxTestResult } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonValue } from '../../shared/api/api-json-value.ts';

interface ManifestMutation {
    readonly label: string;
    readonly change: Partial<RallarBlackBoxDistributedRunManifest>;
}

const source = await readFile('apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json');
const authored = decodeDistributedRunManifest(JSON.parse(source.toString('utf8'))).fold(
    () => {
        throw new Error('Frozen workload must decode.');
    },
    (manifest) => manifest
);
const senderAssertion = authored.groupAssertions.find((assertion) => assertion.aggregate === 'allMatch' && assertion.scope?.role === 'sender')!;
const receiverAssertion = authored.groupAssertions.find((assertion) => assertion.aggregate === 'allMatch' && assertion.scope?.role === 'receiver')!;
const roleSetAssertion = authored.groupAssertions.find((assertion) => assertion.aggregate === 'sameUniqueStringSetAsRole')!;
const nativeManifest = {
    ...authored,
    groupAssertions: [senderAssertion, receiverAssertion, roleSetAssertion]
};
const receiverAssignments = authored.roleAssignments.filter((assignment) => assignment.role === 'receiver');
const recipientSessions = receiverAssignments.map((assignment) => `session-${assignment.agentId}`);
const nativeParticipants = authored.roleAssignments.map((assignment) => ({
    agentId: assignment.agentId,
    roles: [assignment.role]
}));
const nativeEvidence = authored.roleAssignments.map((assignment) => ({
    agentId: assignment.agentId,
    recipeId: assignment.role === 'sender' ? 'alm-scale-director' : 'alm-scale-player',
    role: assignment.role,
    hasResult: true as const,
    resultValue: {
        results: assignment.role === 'sender'
            ? [
                recordedResult('alm-scale-director-sampler', 'parallel', { groupCount: 7 }),
                recordedResult('alm-scale-director-start-receipt', 'messages.receipts', {
                    expectedRecipientPeerIds: recipientSessions
                })
            ]
            : [
                recordedResult('alm-scale-player-sampler', 'parallel', { groupCount: 7 }),
                recordedResult('alm-scale-player-connect', 'rtc.connect', {
                    sessionId: `session-${assignment.agentId}`
                })
            ]
    }
}));
const nativeResults = computeDistributedGroupAssertionResults({
    manifest: nativeManifest,
    participants: nativeParticipants,
    recipeResults: nativeParticipants.map((participant) => ({
        agentId: participant.agentId,
        recipeKey: participant.agentId,
        state: 'passed'
    })),
    recipeEvidence: nativeEvidence
});
if (nativeResults === undefined) {
    throw new Error('Canonical evaluator did not complete the native fixture.');
}
const senderRows = nativeResults[0].perAgent;
const receiverRows = nativeResults[1].perAgent;

function recordedResult(
    commandId: string,
    kind: RallarBlackBoxTestResult['kind'],
    value: ApiJsonValue
): RallarBlackBoxTestResult {
    return {
        commandId,
        kind,
        value,
        status: 'ok',
        ok: true,
        startedAtEpochMs: 1_000,
        endedAtEpochMs: 1_001,
        durationMs: 1
    };
}

describe('world-fleet native manifest acceptance', () => {
    it('accepts every authored native predicate with its frozen role audience in any row order', () => {
        expect(nativeResults.every((result) => result.ok)).toBe(true);
        expect(nativeResults[2].perAgent.every((row) => row.evidence === 'resolved' && row.verdict === 'agreeing')).toBe(true);
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, [...nativeResults].reverse())).not.toThrow();
    });

    it('rejects a contradictory violating verdict in an otherwise passing evaluator result', () => {
        const contradictory = [nativeResults[0], nativeResults[1], {
            ...nativeResults[2],
            perAgent: nativeResults[2].perAgent.map((row, index) =>
                index === 0 && row.evidence === 'resolved' ? { ...row, verdict: 'violating' as const } : row
            )
        }];
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, contradictory)).toThrow();
    });

    it('rejects a passing allMatch result whose matching count or row verdict contradicts success', () => {
        const wrongCount = [
            {
                ...nativeResults[0],
                participants: { expected: 1, required: 1, withEvidence: 1, matching: 0 }
            },
            nativeResults[1],
            nativeResults[2]
        ];
        const wrongVerdict = [
            {
                ...nativeResults[0],
                perAgent: nativeResults[0].perAgent.map((row) => row.evidence === 'resolved' ? { ...row, verdict: 'not-matching' as const } : row)
            },
            nativeResults[1],
            nativeResults[2]
        ];
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, wrongCount)).toThrow();
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, wrongVerdict)).toThrow();
    });

    it('rejects a duplicate passing predicate row that replaces another authored predicate', () => {
        const replaced = [nativeResults[0], nativeResults[0], nativeResults[2]];
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, replaced)).toThrow();
    });

    it('rejects a missing authored predicate result', () => {
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, nativeResults.slice(0, 2))).toThrow();
    });

    it('rejects an unknown passing predicate in place of one authored predicate', () => {
        const replaced = [nativeResults[0], { ...nativeResults[1], groupAssertionId: 'substituted' }, nativeResults[2]];
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, replaced)).toThrow();
    });

    it('rejects an empty scoped native audience despite a passing result', () => {
        const empty = [nativeResults[0], { ...nativeResults[1], perAgent: [] }, nativeResults[2]];
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, empty)).toThrow();
    });

    it('rejects a duplicate or substituted actor in a scoped audience', () => {
        const duplicate = [nativeResults[0], {
            ...nativeResults[1],
            perAgent: [receiverRows[0], receiverRows[0], ...receiverRows.slice(2)]
        }, nativeResults[2]];
        const substituted = [nativeResults[0], {
            ...nativeResults[1],
            perAgent: [{ ...receiverRows[0], agentId: 'not-frozen' }, ...receiverRows.slice(1)]
        }, nativeResults[2]];
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, duplicate)).toThrow();
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, substituted)).toThrow();
    });

    it('rejects incomplete cross-role evidence and dishonest participant counts', () => {
        const incomplete = [nativeResults[0], nativeResults[1], {
            ...nativeResults[2],
            perAgent: senderRows
        }];
        const dishonest = [nativeResults[0], {
            ...nativeResults[1],
            participants: { expected: 14, required: 14, withEvidence: 0, matching: 14 }
        }, nativeResults[2]];
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, incomplete)).toThrow();
        expect(() => expectWorldFleetGroupAssertions(nativeManifest, dishonest)).toThrow();
    });
    it('keeps the authored workload identity with the ALM diagnostic stream off for both roles', () => {
        const connectCommands = authored.recipes.flatMap((selection) => selection.recipe?.commands.filter((command) => command.kind === 'rtc.connect') ?? []);
        expect(connectCommands.map((command) => command.rallar?.almDiagnostics)).toEqual([false, false]);
        const workload = {
            ...authored,
            recipes: authored.recipes.map((selection) => ({
                ...selection,
                recipe: selection.recipe && {
                    ...selection.recipe,
                    commands: selection.recipe.commands.map((command) =>
                        command.kind === 'rtc.connect'
                            ? { ...command, rallar: { ...command.rallar, almDiagnostics: undefined } }
                            : command
                    )
                }
            }))
        };
        expect(createHash('sha256').update(JSON.stringify(workload)).digest('hex')).toBe('f2b10263fa80b80f60786a9f7e789ad942eb6c4134ef19601f43233a070d3112');
        expect(authored.rtcCaptureMode).toBeUndefined();
        expect(authored.targetPolicy.expectedParticipantCount).toBe(15);
        expect(authored.groupAssertions).toHaveLength(231);
    });

    it.each(
        [
            { input: undefined, effective: undefined },
            { input: '', effective: undefined },
            { input: ' \t ', effective: undefined },
            { input: 'off', effective: 'off' },
            { input: 'signaling', effective: 'signaling' },
            { input: 'native', effective: 'native' }
        ] as const
    )('accepts the exact effective manifest for $input', ({ input, effective }) => {
        const actual = effective === undefined ? structuredClone(authored) : { ...authored, rtcCaptureMode: effective };
        expect(() => expectWorldFleetManifest(actual, authored, input)).not.toThrow();
    });

    it.each(['bogus', 'OFF', ' native '])('rejects invalid selection %s before accepting even an authored snapshot', (input) => {
        expect(() => expectWorldFleetManifest(authored, authored, input)).toThrow('RTC capture mode');
    });

    it('preserves authored capture when blank and rejects a different effective selection', () => {
        const selected = { ...authored, rtcCaptureMode: 'native' as const };
        expect(() => expectWorldFleetManifest(selected, selected, '')).not.toThrow();
        expect(() => expectWorldFleetManifest({ ...selected, rtcCaptureMode: 'off' }, selected, '')).toThrow();
        expect(() => expectWorldFleetManifest(selected, authored, 'off')).toThrow();
        expect(() => expectWorldFleetManifest(authored, authored, 'native')).toThrow();
    });

    it.each(
        [
            { label: 'workload', change: { recipes: [] } },
            { label: 'participants', change: { targetPolicy: { ...authored.targetPolicy, expectedParticipantCount: 14 } } },
            { label: 'assertions', change: { groupAssertions: [] } },
            { label: 'deadline', change: { ackTimeoutMs: 60_000 } },
            { label: 'identity', change: { distributedRunId: 'substituted-run' } }
        ] satisfies readonly ManifestMutation[]
    )(
        'rejects unrelated $label changes even with an authorized capture mode',
        ({ change }) => {
            expect(() => expectWorldFleetManifest({ ...authored, rtcCaptureMode: 'native', ...change }, authored, 'native')).toThrow();
        }
    );
});
