import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findMutationBoundaryViolations } from './mutation-boundary-analysis.ts';

const serviceRoot = 'packages/shared-server/rallar-system/services';
const repositoryRoot = 'packages/shared-server/rallar-system/repositories';

const sources = {
    appAdmin: read(`${serviceRoot}/AppAdminInboxService.ts`),
    appAuth: read(`${serviceRoot}/AppAuthInboxService.ts`),
    appClient: read(`${serviceRoot}/AppClientInboxService.ts`),
    appCrdt: read(`${serviceRoot}/AppCrdtInboxService.ts`),
    appGroup: read(`${serviceRoot}/AppGroupInboxService.ts`),
    client: read(`${serviceRoot}/client-state-service.ts`),
    group: read(`${serviceRoot}/group-state-guarded-batch.ts`),
    topologyConfig: read(`${serviceRoot}/group-topology-management-service.ts`),
    topologyWorker: read(`${serviceRoot}/RtcTopologyOutboxWork.ts`),
    topologyRepository: read(
        `${repositoryRoot}/RtcTopologyExecutionRepository.ts`,
    ),
    rtt: read(`${serviceRoot}/rtc-rtt-mutation-service.ts`),
};

const trackedRuntimeSource = [
    `${serviceRoot}/AppInboxService.ts`,
    `${serviceRoot}/client-state-service.ts`,
    `${serviceRoot}/group-state-service.ts`,
    `${serviceRoot}/group-state-mutations.ts`,
    `${serviceRoot}/group-topology-config-mutations.ts`,
    `${serviceRoot}/group-topology-management-service.ts`,
    `${serviceRoot}/GroupPresenceSummaryWork.ts`,
    `${serviceRoot}/rtc-rtt-mutation-service.ts`,
    `${serviceRoot}/canonical-command-hash.ts`,
    `${repositoryRoot}/RtcTopologyPublicationRepository.ts`,
    `${repositoryRoot}/RtcTopologyScalarAuthorityMigration.ts`,
    'packages/shared-server/rallar-system/middleware/RallarMiddleware.ts',
    'packages/shared-server/mod.ts',
    'apps/api-v1/src/middleware.ts',
].map(read).join('\n');

const removedIntermediateOutboxSymbols = [
    'state-mutation:' + 'outbox',
    'StateMutation' + 'OutboxRepository',
    'StateMutation' + 'OutboxWork',
] as const;

describe('read/compute/validate/write implementation contract', { timeout: 30_000 }, () => {
    it('contains no intermediate state-mutation outbox runtime wiring', () => {
        for (const forbidden of removedIntermediateOutboxSymbols) {
            expect(trackedRuntimeSource).not.toContain(forbidden);
        }
    });

    it.each([
        {
            name: 'auth AppInbox',
            source: sources.appAuth,
            owner: 'processCommand',
            calls: [
                'this.authMutationService.read(command)',
                'this.authMutationService.compute(command, read, facts)',
                'this.authMutationService.validate(command, read, computed)',
                'this.authMutationService.write(transaction, computed)',
            ],
        },
        {
            name: 'CRDT AppInbox',
            source: sources.appCrdt,
            owner: 'processCommand',
            calls: [
                'this.mutationService.read(command)',
                'this.mutationService.compute(command, read)',
                'this.mutationService.validate(command, read, computed)',
                'this.mutationService.write(transaction, computed)',
            ],
        },
        {
            name: 'admin AppInbox',
            source: sources.appAdmin,
            owner: 'processCommand',
            calls: [
                'this.read(command)',
                'this.compute(command, read)',
                'this.validate(command, read, computed)',
                'this.writeMutation(context',
            ],
        },
        {
            name: 'client AppInbox',
            source: sources.appClient,
            owner: 'processCommand',
            calls: [
                'this.clientStateService.read(command)',
                'this.clientStateService.compute(command, read)',
                'this.clientStateService.validate(command, read, computed)',
                'this.commitComputed(context, computed)',
            ],
        },
        {
            name: 'group AppInbox',
            source: sources.appGroup,
            owner: 'processMutation',
            calls: [
                'this.groupStateService.read(command)',
                'this.groupStateService.compute(command, read)',
                'this.groupStateService.validate(command, read, computed)',
                'this.commitMutation(context, command, computed)',
            ],
        },
        {
            name: 'topology config AppInbox',
            source: sources.appGroup,
            owner: 'processTopologyConfigMutation',
            calls: [
                'service.readTopologyConfigMutation(',
                'service.computeTopologyConfigMutation(',
                'service.validateTopologyConfigMutation(',
                'this.writeMutation(',
                'service.writeTopologyConfigMutation(',
            ],
        },
        {
            name: 'topology reconfigure AppInbox',
            source: sources.appGroup,
            owner: 'processTopologyReconfigureMutation',
            calls: [
                'service.readTopologyMutation(command)',
                'service.computeTopologyMutation(command, read)',
                'service.validateTopologyMutation(command, read, computed)',
                'this.writeMutation(',
                'service.writeTopologyMutation(transaction, computed)',
            ],
        },
        {
            name: 'RTC RTT AppInbox',
            source: sources.appGroup,
            owner: 'processRtcRttMutation',
            calls: [
                'readRttMutation(',
                'computeRttMutation(',
                'validateRttMutation(',
                'this.writeMutation(',
                'writeRttMutation(',
            ],
        },
    ])('$name keeps one visible read/compute/validate/write path', ({
        source,
        owner,
        calls,
    }) => {
        const body = methodBody(source, owner);
        expectInOrder(body, calls);
    });

    it('keeps every authoritative service write bound to the caller transaction', () => {
        const seams = [
            functionBody(sources.client, 'writeClientMutation'),
            functionBody(sources.group, 'writeGroupMutation'),
            functionBody(sources.topologyConfig, 'writeTopologyConfigMutation'),
            methodBody(sources.topologyConfig, 'writeTopologyMutation'),
            functionBody(sources.rtt, 'writeRttMutation'),
            methodBody(sources.topologyRepository, 'writeTopologyMutation'),
        ];
        for (const seam of seams) {
            expect(seam).toMatch(/transaction:\s*PSqlTransactionSql/);
            expect(seam).not.toMatch(/\.begin\s*\(/);
            expect(seam).not.toMatch(/waitForRuntimeStateWriteRetry/);
        }
    });

    it('keeps AppInbox as the only retry and transaction owner for HTTP and WS mutations', () => {
        for (const source of [
            sources.topologyConfig,
            sources.topologyRepository,
            sources.rtt,
            sources.topologyWorker,
        ]) {
            expect(source).not.toMatch(/waitForRuntimeStateWriteRetry/);
            expect(source).not.toMatch(/for\s*\([^)]*attempt/);
        }
        expect(sources.appGroup).toContain('this.writeMutation(');
        expect(sources.appGroup).toContain('AppInboxType.RTC_RTT_SUBMIT');
        expect(sources.appGroup).toContain('AppInboxType.TOPOLOGY_RECONFIGURE');
    });

    it('keeps transport boundaries free of direct mutators and persistence owners', () => {
        expect(findMutationBoundaryViolations()).toEqual([]);
    });

    it('writes topology config state, receipt, authority fence, and APP_OUTBOX atomically', () => {
        const seam = functionBody(
            sources.topologyConfig,
            'writeTopologyConfigMutation',
        );
        expectInOrder(seam, [
            'advanceAuthorityFence(',
            'requireAcceptedTopologyConfigWrite(',
            'insertMutationRecord(',
            'writeRtcTopologyOutbox(transaction, computed.outbox)',
        ]);
        expect(seam).not.toContain('StateMutation' + 'Outbox');
    });

    it('fences explicit reconfigure authority before inserting APP_OUTBOX', () => {
        const seam = methodBody(
            sources.topologyConfig,
            'writeTopologyMutation',
        );
        expectInOrder(seam, [
            'advanceAuthorityFence(computed.authorityGuard)',
            'throw new RuntimeStateWriteConflictError()',
            'writeRtcTopologyOutbox(transaction, computed)',
        ]);
    });

    it('writes RTT admission, measurement, receipt, and direct APP_OUTBOX rows atomically', () => {
        const seam = functionBody(sources.rtt, 'writeRttMutation');
        expectInOrder(seam, [
            'commitEndpointAdmission(',
            'commitMeasurement(',
            'insertMutationReceipt(',
            'writeRtcTopologyOutbox(transaction,',
        ]);
        expect(seam).not.toContain('insertRecomputeIntent');
        expect(seam).not.toContain('StateMutation' + 'Outbox');
    });

    it('keeps the RTC APP_OUTBOX worker to one attempt with atomic WS_OUTBOX and reservation completion', () => {
        const handler = functionBody(
            sources.topologyWorker,
            'createRtcTopologyWorkHandler',
        );
        expect(handler).toContain('readTopologyMutation(');
        const claimMiss = handler.slice(handler.indexOf('const authority'));
        expectInOrder(claimMiss, [
            'computeTopologyMutation(',
            'validateTopologyMutation(',
            'runInTransaction(',
            'writeTopologyMutation(',
            'writeRtcTopologyPublicationOutbox(',
            'finishRtcTopologyReservation(',
        ]);
        expect(handler).not.toMatch(/publicationFanout\.publish/);
        expect(handler).not.toMatch(/waitForRuntimeStateWriteRetry/);
        expect(handler).not.toMatch(/for\s*\([^)]*attempt/);
    });

    it('validates exact replay before reasserting WS_OUTBOX and completing the reservation', () => {
        const handler = functionBody(
            sources.topologyWorker,
            'createRtcTopologyWorkHandler',
        );
        const replay = branchBody(handler, 'if (read.publicationClaim)');
        expectInOrder(replay, [
            'computeTopologyMutation(replayInput)',
            'validateTopologyMutation({ ...replayInput, computed })',
            'writeRtcTopologyPublicationOutbox(',
            'finishRtcTopologyReservation(',
        ]);
        expect(replay).not.toMatch(/publicationFanout\.publish/);
    });

    it('keeps all topology and RTT computed effects direct and mandatory', () => {
        const topologyEntry = read(`${serviceRoot}/rtc-topology-outbox-entry.ts`);
        const topologyWsEntry = read(
            `${serviceRoot}/rtc-topology-ws-outbox-entry.ts`,
        );
        for (const field of [
            'commandId',
            'resourceId',
            'aggregateRef',
            'acceptedCausalRevision',
            'groupSnapshot',
            'createdAtEpochMs',
            'expireAtEpochMs',
            'senderId',
            'requestOptions',
            'publish',
        ]) {
            expect(topologyEntry).toMatch(
                new RegExp(`readonly\\s+${field}(?!\\?)`),
            );
        }
        expect(topologyWsEntry).toContain('EnqueuedType.WS_OUTBOX');
        expect(topologyEntry).toContain('EnqueuedType.APP_OUTBOX');
    });

    it('does not reintroduce intermediate state-mutation intents on Task 7 paths', () => {
        for (const source of [
            sources.appGroup,
            sources.topologyConfig,
            sources.rtt,
            sources.topologyWorker,
        ]) {
            expect(source).not.toContain('StateMutation' + 'OutboxWork');
        }
        expect(sources.topologyConfig).not.toContain(
            'StateMutation' + 'OutboxRepository',
        );
        expect(sources.rtt).not.toContain('insertRecomputeIntent');
    });
});

function read(file: string): string {
    return readFileSync(file, 'utf8');
}

function methodBody(source: string, name: string): string {
    return extractBody(
        source,
        new RegExp(
            `^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?${name}\\s*\\(`,
            'm',
        ),
        name,
    );
}

function functionBody(source: string, name: string): string {
    return extractBody(
        source,
        new RegExp(
            `^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
            'm',
        ),
        name,
    );
}

function branchBody(source: string, marker: string): string {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing branch: ${marker}`);
    return balancedBody(source, source.indexOf('{', start), marker);
}

function extractBody(
    source: string,
    signature: RegExp,
    label: string,
): string {
    const match = signature.exec(source);
    if (!match) throw new Error(`Missing function or method: ${label}`);
    const parametersStart = source.indexOf('(', match.index);
    const parametersEnd = matchingDelimiter(
        source,
        parametersStart,
        '(',
        ')',
        label,
    );
    const bodyStart = source.indexOf('{', parametersEnd + 1);
    const body = balancedBody(source, bodyStart, label);
    return source.slice(match.index, bodyStart) + body;
}

function matchingDelimiter(
    source: string,
    start: number,
    open: string,
    close: string,
    label: string,
): number {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === open) depth += 1;
        if (source[index] === close) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    throw new Error(`Unclosed signature: ${label}`);
}

function balancedBody(source: string, bodyStart: number, label: string): string {
    if (bodyStart < 0) throw new Error(`Missing body: ${label}`);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(bodyStart, index + 1);
        }
    }
    throw new Error(`Unclosed body: ${label}`);
}

function expectInOrder(source: string, expected: readonly string[]): void {
    let cursor = -1;
    for (const marker of expected) {
        const index = source.indexOf(marker, cursor + 1);
        expect(index, `Missing or reordered marker: ${marker}`).toBeGreaterThan(
            cursor,
        );
        cursor = index;
    }
}
