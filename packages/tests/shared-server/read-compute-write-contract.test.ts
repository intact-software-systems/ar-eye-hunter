import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

type EffectfulVariantContract = Readonly<{
    name: string;
    sourceFile: string;
    sourceStart: string;
    sourceEnd: string;
    variantMarkers: readonly string[];
    writeMarkers: readonly string[];
}>;

type OperationContract = Readonly<{
    name: string;
    orchestrationFile: string;
    orchestrationMarker: string;
    phaseCalls: readonly [string, string, string, string];
    transactionOwnerFile: string;
    writeMarker: string;
    orderedWriteMarkers: readonly string[];
    effectfulVariants: readonly EffectfulVariantContract[];
}>;

const operationContracts: readonly OperationContract[] = [
    {
        name: 'client mutation',
        orchestrationFile:
            'packages/shared-server/rallar-system/services/client-state-service.ts',
        orchestrationMarker: 'const executeReceipt = async (',
        phaseCalls: [
            'readClientMutation(',
            'computeClientMutation(',
            'validateClientMutation(',
            'writeClientMutation(',
        ],
        transactionOwnerFile:
            'packages/shared-server/rallar-system/services/client-state-service.ts',
        writeMarker: 'async function writeClientMutation(',
        orderedWriteMarkers: [
            'requireConditionalWrite(computed.principal.operation',
            'writeChildCandidate(repository, computed.instance',
            'writeChildCandidate(repository, computed.session',
            'insertIdempotentClientStateWritten(',
            'insertForAuthoritativeWrite(',
            'appendEvent(',
        ],
        effectfulVariants: [{
            name: "outcome 'write' with client-state-sync outbox",
            sourceFile:
                'packages/shared-server/rallar-system/services/client-state-mutations.ts',
            sourceStart: 'export type ClientMutationOutboxCandidate =',
            sourceEnd: 'export class ClientMutationIdempotencyConflictError',
            variantMarkers: [
                "outcome: 'write'",
                'outbox: ClientMutationOutboxCandidate',
                "effects: readonly ['client-state-sync']",
            ],
            writeMarkers: ['insertForAuthoritativeWrite('],
        }],
    },
    {
        name: 'group mutation',
        orchestrationFile:
            'packages/shared-server/rallar-system/services/group-state-service.ts',
        orchestrationMarker: 'const executeReceipt = async (',
        phaseCalls: [
            'readGroupMutation(',
            'computeGroupMutation(',
            'validateGroupMutation(',
            'writeGroupMutation(',
        ],
        transactionOwnerFile:
            'packages/shared-server/rallar-system/services/group-state-service.ts',
        writeMarker: 'async function writeGroupMutation(',
        orderedWriteMarkers: [
            "if (computed.guard.kind === 'group')",
            'if (computed.presenceAdmission)',
            'for (const member of computed.members)',
            'insertIdempotentGroupMutationReceipt(',
            'insertForAuthoritativeWrite(',
            'appendEvent(',
        ],
        effectfulVariants: [{
            name: "outcome 'write' with state-sync and summary outbox",
            sourceFile:
                'packages/shared-server/rallar-system/services/group-state-mutations.ts',
            sourceStart: 'export type GroupMutationOutboxCandidate =',
            sourceEnd: 'export type GroupMutationIdempotencyProbe =',
            variantMarkers: [
                "outcome: 'write'",
                'outbox: GroupMutationOutboxCandidate',
                "effects: readonly ['group-state-sync', 'group-presence-summary']",
            ],
            writeMarkers: ['insertForAuthoritativeWrite('],
        }],
    },
    {
        name: 'topology config mutation',
        orchestrationFile:
            'packages/shared-server/rallar-system/services/group-topology-management-service.ts',
        orchestrationMarker: 'private async executeTopologyConfigMutation(',
        phaseCalls: [
            'readTopologyConfigMutation(',
            'computeTopologyConfigMutation(',
            'validateTopologyConfigMutation({',
            'writeTopologyConfigMutation(',
        ],
        transactionOwnerFile:
            'packages/shared-server/rallar-system/services/group-topology-management-service.ts',
        writeMarker: 'async function writeTopologyConfigMutation(',
        orderedWriteMarkers: [
            'advanceAuthorityFence(',
            'const state = guard.operation',
            'commitInvariantGeneration(',
            'commitGeneration(',
            'insertMutationRecord(',
            'insertForAuthoritativeWrite(',
        ],
        effectfulVariants: [{
            name: "outcome 'write' with rtc-topology-recompute outbox",
            sourceFile:
                'packages/shared-server/rallar-system/services/group-topology-config-mutations.ts',
            sourceStart: 'export type GroupTopologyConfigMutationComputed =',
            sourceEnd: 'export function computeTopologyConfigMutation(',
            variantMarkers: [
                "outcome: 'write'",
                'outbox: GroupTopologyConfigOutboxInput',
            ],
            writeMarkers: ['insertForAuthoritativeWrite('],
        }],
    },
    {
        name: 'RTC topology mutation',
        orchestrationFile:
            'packages/shared-server/rallar-system/services/group-topology-management-service.ts',
        orchestrationMarker: 'private async commitTopologyWithRetry(',
        phaseCalls: [
            'readTopologyMutation(',
            'computeTopologyMutation(',
            'validateTopologyMutation(',
            'writeTopologyMutation(',
        ],
        transactionOwnerFile:
            'packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts',
        writeMarker: 'async writeTopologyMutation(',
        orderedWriteMarkers: [
            'commitSnapshotGuard(',
            'insertWorkClaim(',
            'insertPublication(',
        ],
        effectfulVariants: [{
            name: "outcome 'write' with immutable topology publication",
            sourceFile:
                'packages/shared-server/rallar-system/services/rtc-topology-mutations.ts',
            sourceStart: 'export type RtcTopologyMutationComputed =',
            sourceEnd: 'export function computeTopologyMutation(',
            variantMarkers: [
                "outcome: 'write'",
                'publication: RtcTopologyPublication',
                'publication: null',
            ],
            writeMarkers: [
                'if (publicationWrite)',
                'insertWorkClaim(',
                'insertPublication(',
            ],
        }],
    },
    {
        name: 'RTC RTT mutation',
        orchestrationFile:
            'packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts',
        orchestrationMarker: 'export async function executeRttMutation(',
        phaseCalls: [
            'readRttMutation(',
            'computeRttMutation(',
            'validateRttMutation(',
            'writeRttMutation(',
        ],
        transactionOwnerFile:
            'packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts',
        writeMarker: 'export async function writeRttMutation(',
        orderedWriteMarkers: [
            'for (let index = 0; index < computed.endpointGuards.length;',
            'commitMeasurement(',
            'insertMutationReceipt(',
            'for (const intent of computed.recomputeIntents)',
            'insertRecomputeIntent(',
        ],
        effectfulVariants: [{
            name: "outcome 'write' with one recompute intent per affected group",
            sourceFile:
                'packages/shared-server/rallar-system/services/rtc-topology-mutations.ts',
            sourceStart: 'export type RtcRttMutationComputed =',
            sourceEnd: 'export type RtcRttMutationReceipt =',
            variantMarkers: [
                "outcome: 'write'",
                'recomputeIntents: readonly RtcRttRecomputeIntent[]',
            ],
            writeMarkers: [
                'for (const intent of computed.recomputeIntents)',
                'insertRecomputeIntent(',
            ],
        }],
    },
] as const;

const pureMutationModules = [
    'packages/shared-server/rallar-system/services/client-state-mutations.ts',
    'packages/shared-server/rallar-system/services/group-state-mutations.ts',
    'packages/shared-server/rallar-system/services/group-topology-config-mutations.ts',
    'packages/shared-server/rallar-system/services/rtc-topology-mutations.ts',
] as const;

const forbiddenPureModulePatterns = [
    ['ambient Date clock', /\bDate\.now\s*\(/],
    ['ambient Temporal clock', /\bTemporal\.Now\b/],
    ['ambient randomness', /\bMath\.random\s*\(|\brandomUUID\s*\(/],
    ['transaction ownership', /\.begin\s*\(/],
    ['async execution', /\basync\b|\bawait\b/],
    ['environment access', /\b(?:process|Deno|Bun)\.env\b/],
    ['timing access', /\bperformance\s*\./],
    ['repository invocation', /\b(?:repository|runtimeRepository)\s*\./],
] as const;

describe('read/compute/validate/write implementation contract', () => {
    it.each(operationContracts)(
        '$name keeps one shallow read/compute/validate/write sequence',
        (contract) => {
            const source = readRepo(contract.orchestrationFile);
            const orchestration = extractBlock(
                source,
                contract.orchestrationMarker,
                `${contract.name} orchestration`,
            );

            for (const phaseCall of contract.phaseCalls) {
                expect(
                    countOccurrences(orchestration, phaseCall),
                    `${contract.name}: ${phaseCall}`,
                ).toBe(1);
            }
            expectInSourceOrder(
                orchestration,
                contract.phaseCalls,
                `${contract.name} phase sequence`,
            );
        },
    );

    it.each(operationContracts)(
        '$name lets only its write seam own the transaction',
        (contract) => {
            const source = readRepo(contract.transactionOwnerFile);
            const write = extractBlock(
                source,
                contract.writeMarker,
                `${contract.name} write seam`,
            );

            expect(countOccurrences(write, '.begin('), contract.name).toBe(1);
            expect(countOccurrences(source, '.begin('), contract.name).toBe(1);
        },
    );

    it.each(operationContracts)(
        '$name writes its conditional guard before dependent effects',
        (contract) => {
            const write = extractBlock(
                readRepo(contract.transactionOwnerFile),
                contract.writeMarker,
                `${contract.name} write seam`,
            );

            expectInSourceOrder(
                write,
                contract.orderedWriteMarkers,
                `${contract.name} guard/dependent write order`,
            );
        },
    );

    it.each(operationContracts.flatMap((contract) =>
        contract.effectfulVariants.map((variant) => ({ contract, variant }))))(
        '$contract.name maps $variant.name exhaustively to its outbox insert',
        ({ contract, variant }) => {
            const variantSource = sliceBetween(
                readRepo(variant.sourceFile),
                variant.sourceStart,
                variant.sourceEnd,
                `${contract.name} ${variant.name}`,
            );
            const write = extractBlock(
                readRepo(contract.transactionOwnerFile),
                contract.writeMarker,
                `${contract.name} write seam`,
            );

            for (const marker of variant.variantMarkers) {
                expect(variantSource, `${contract.name}: ${marker}`).toContain(marker);
            }
            for (const marker of variant.writeMarkers) {
                expect(write, `${contract.name}: ${marker}`).toContain(marker);
            }
        },
    );

    it.each(pureMutationModules)('%s keeps compute and validate pure', (filePath) => {
        const source = readRepo(filePath);
        for (const [name, pattern] of forbiddenPureModulePatterns) {
            expect(source, `${filePath}: forbidden ${name}`).not.toMatch(pattern);
        }
    });

    it('keeps the architecture inventory synchronized with the guarded operations', () => {
        const architecture = readRepo('packages/shared-server/architecture.md');
        for (const contract of operationContracts) {
            for (const phaseCall of contract.phaseCalls) {
                const symbol = phaseCall.replace(/\(\{$|\($/, '');
                expect(architecture, `${contract.name}: ${symbol}`).toContain(
                    `\`${symbol}\``,
                );
            }
        }
    });
});

function readRepo(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function extractBlock(source: string, marker: string, label: string): string {
    const markerIndex = source.indexOf(marker);
    expect(markerIndex, `${label}: missing ${marker}`).toBeGreaterThanOrEqual(0);
    const openIndex = findBodyOpen(source, markerIndex + marker.length);
    expect(openIndex, `${label}: missing opening brace`).toBeGreaterThan(markerIndex);

    let depth = 0;
    let quote: "'" | '"' | '`' | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openIndex; index < source.length; index += 1) {
        const character = source[index]!;
        const next = source[index + 1];
        if (lineComment) {
            if (character === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === quote) {
                quote = null;
            }
            continue;
        }
        if (character === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (character === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (character === "'" || character === '"' || character === '`') {
            quote = character;
            continue;
        }
        if (character === '{') depth += 1;
        if (character === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(markerIndex, index + 1);
        }
    }
    throw new Error(`${label}: missing closing brace`);
}

function findBodyOpen(source: string, start: number): number {
    let parentheses = 0;
    let brackets = 0;
    let angles = 0;
    let quote: "'" | '"' | '`' | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = start; index < source.length; index += 1) {
        const character = source[index]!;
        const next = source[index + 1];
        if (lineComment) {
            if (character === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (character === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (character === "'" || character === '"' || character === '`') {
            quote = character;
            continue;
        }
        if (character === '(') parentheses += 1;
        else if (character === ')') parentheses -= 1;
        else if (character === '[') brackets += 1;
        else if (character === ']') brackets -= 1;
        else if (character === '<') angles += 1;
        else if (character === '>' && angles > 0) angles -= 1;
        else if (
            character === '{' &&
            parentheses === 0 &&
            brackets === 0 &&
            angles === 0
        ) return index;
    }
    return -1;
}

function sliceBetween(
    source: string,
    startMarker: string,
    endMarker: string,
    label: string,
): string {
    const start = source.indexOf(startMarker);
    expect(start, `${label}: missing ${startMarker}`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(end, `${label}: missing ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end);
}

function expectInSourceOrder(
    source: string,
    markers: readonly string[],
    label: string,
): void {
    let previous = -1;
    for (const marker of markers) {
        const current = source.indexOf(marker, previous + 1);
        expect(current, `${label}: missing or misordered ${marker}`).toBeGreaterThan(
            previous,
        );
        previous = current;
    }
}

function countOccurrences(source: string, marker: string): number {
    return source.split(marker).length - 1;
}
