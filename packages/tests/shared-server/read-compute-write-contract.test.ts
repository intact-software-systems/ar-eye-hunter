import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import * as ts from 'typescript/unstable/ast';
import { afterAll, describe, expect, it } from 'vitest';
const repoRoot = process.cwd();
type Selector =
    | readonly [kind: 'function' | 'method' | 'variable', name: string]
    | readonly [
        kind: 'callback',
        ownerKind: 'function' | 'method',
        ownerName: string,
        name: string,
    ];
type Branch = readonly [condition: string, side: 'then' | 'else'];
type CallSpec = string | readonly [name: string, branch: Branch];
type PathContract = Readonly<{
    family: string;
    name: string;
    file: string;
    owner: Selector;
    retry: string;
    phases: readonly [CallSpec, CallSpec, CallSpec, CallSpec];
}>;
type SeamContract = Readonly<{
    family: string;
    file: string;
    owner: Selector;
    guards: readonly string[];
    dependent: readonly string[];
}>;
type PropertySpec = readonly [name: string, types: readonly string[]];
type AtomicMapping = Readonly<{
    outcome: string;
    property: PropertySpec;
    seam: SeamContract;
    calls: readonly CallSpec[];
}>;
type ReplayMapping = Readonly<{
    outcome: string;
    property: PropertySpec;
    file: string;
    owner: Selector;
    claim: string;
    calls: readonly CallSpec[];
}>;
type EffectContract = Readonly<{
    family: string;
    type: readonly [file: string, name: string];
    passive: readonly string[];
    atomic: readonly AtomicMapping[];
    replay?: readonly ReplayMapping[];
}>;
const clientFile =
    'packages/shared-server/rallar-system/services/client-state-service.ts';
const groupFile =
    'packages/shared-server/rallar-system/services/group-state-service.ts';
const configFile =
    'packages/shared-server/rallar-system/services/group-topology-management-service.ts';
const rtcWorkerFile =
    'packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
const rtcRepositoryFile =
    'packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
const rttFile =
    'packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts';
const clientSeam = seam(
    'client mutation', clientFile, ['function', 'writeClientMutation'],
    ['insertPrincipal', 'updatePrincipal'],
    [
        'writeChildCandidate', 'insertIdempotentClientStateWritten',
        'insertForAuthoritativeWrite', 'appendEvent',
    ],
);
const groupSeam = seam(
    'group mutation', groupFile, ['function', 'writeGroupMutation'],
    ['insertGroup', 'updateGroup', 'insertPresence', 'updatePresence', 'deletePresence'],
    [
        'insertPresenceAdmission', 'updatePresenceAdmission', 'putMember',
        'insertPresenceSummary', 'insertIdempotentGroupMutationReceipt',
        'insertForAuthoritativeWrite', 'appendEvent',
    ],
);
const configSeam = seam(
    'topology config mutation', configFile,
    ['function', 'writeTopologyConfigMutation'],
    ['advanceAuthorityFence'],
    [
        'deleteConfig', 'deleteOverride', 'commitConfig', 'commitOverride',
        'commitInvariantGeneration', 'commitGeneration', 'insertMutationRecord',
        'insertForAuthoritativeWrite',
    ],
);
const rtcSeam = seam(
    'RTC topology mutation', rtcRepositoryFile,
    ['method', 'writeTopologyMutation'], ['commitSnapshotGuard'],
    ['insertWorkClaim', 'insertPublication'],
);
const rttSeam = seam(
    'RTC RTT mutation', rttFile, ['function', 'writeRttMutation'],
    ['commitEndpointAdmission'],
    ['commitMeasurement', 'insertMutationReceipt', 'insertRecomputeIntent'],
);
const seams = [clientSeam, groupSeam, configSeam, rtcSeam, rttSeam] as const;
const rtcWorkerOwner = [
    'callback', 'function', 'createRtcTopologyWorkHandler', 'onMessage',
] as const satisfies Selector;
const paths: readonly PathContract[] = [
    {
        family: clientSeam.family,
        name: 'client effectful path',
        file: clientFile,
        owner: ['variable', 'executeReceipt'],
        retry: 'attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS',
        phases: [
            'readClientMutation', 'computeClientMutation',
            'validateClientMutation', 'writeClientMutation',
        ],
    },
    {
        family: groupSeam.family,
        name: 'group effectful path',
        file: groupFile,
        owner: ['variable', 'executeReceipt'],
        retry: 'attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS',
        phases: [
            'readGroupMutation',
            under('computeGroupMutation', "idempotency.outcome !== 'miss'", 'else'),
            under('validateGroupMutation', 'resolvedFromIdempotency', 'else'),
            'writeGroupMutation',
        ],
    },
    {
        family: configSeam.family,
        name: 'topology config effectful path',
        file: configFile,
        owner: ['method', 'executeTopologyConfigMutation'],
        retry: 'attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS',
        phases: [
            'readTopologyConfigMutation',
            under('computeTopologyConfigMutation',
                "idempotency.outcome !== 'miss'", 'else'),
            under('validateTopologyConfigMutation',
                "computed.outcome === 'replay' || computed.outcome === 'idempotency-conflict'",
                'else'),
            'writeTopologyConfigMutation',
        ],
    },
    {
        family: rtcSeam.family,
        name: 'RTC topology externally effectful worker path',
        file: rtcWorkerFile,
        owner: rtcWorkerOwner,
        retry: 'attempt < 3',
        phases: [
            'readTopologyMutation', 'computeTopologyMutation',
            'validateTopologyMutation', 'writeTopologyMutation',
        ],
    },
    {
        family: rtcSeam.family,
        name: 'RTC topology publication-null internal path',
        file: configFile,
        owner: ['method', 'commitTopologyWithRetry'],
        retry: 'attempt < 3',
        phases: [
            'readTopologyMutation', 'computeTopologyMutation',
            'validateTopologyMutation',
            under('writeTopologyMutation',
                "computed.observation !== 'duplicate'", 'then'),
        ],
    },
    {
        family: rttSeam.family,
        name: 'RTC RTT effectful path',
        file: rttFile,
        owner: ['function', 'executeRttMutation'],
        retry: 'attempt < 3',
        phases: [
            'readRttMutation', 'computeRttMutation',
            'validateRttMutation', 'writeRttMutation',
        ],
    },
];
const effects: readonly EffectContract[] = [
    {
        family: clientSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/client-state-mutations.ts',
            'ClientMutationComputed',
        ],
        passive: ['replay', 'no-op', 'idempotency-conflict'],
        atomic: [{
            outcome: 'write', property: ['outbox', ['ClientMutationOutboxCandidate']],
            seam: clientSeam, calls: ['insertForAuthoritativeWrite'],
        }],
    },
    {
        family: groupSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/group-state-mutations.ts',
            'GroupMutationComputed',
        ],
        passive: ['replay', 'idempotency-conflict', 'no-op', 'rejected'],
        atomic: [{
            outcome: 'write', property: ['outbox', ['GroupMutationOutboxCandidate']],
            seam: groupSeam, calls: ['insertForAuthoritativeWrite'],
        }],
    },
    {
        family: configSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/group-topology-config-mutations.ts',
            'GroupTopologyConfigMutationComputed',
        ],
        passive: ['claim', 'no-op', 'replay', 'idempotency-conflict'],
        atomic: [{
            outcome: 'write', property: ['outbox', ['GroupTopologyConfigOutboxInput']],
            seam: configSeam,
            calls: [under('insertForAuthoritativeWrite',
                "computed.outcome === 'write'", 'then')],
        }],
    },
    {
        family: rtcSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/rtc-topology-mutations.ts',
            'RtcTopologyMutationComputed',
        ],
        passive: ['retry', 'superseded'],
        atomic: [{
            outcome: 'write',
            property: ['publication', ['RtcTopologyPublication', 'null']],
            seam: rtcSeam,
            calls: [
                under('insertWorkClaim', 'publicationWrite', 'then'),
                under('insertPublication', 'publicationWrite', 'then'),
            ],
        }],
        replay: [{
            outcome: 'loaded',
            property: ['publication', ['RtcTopologyPublication']],
            file: rtcWorkerFile,
            owner: rtcWorkerOwner,
            claim: 'read.publicationClaim',
            calls: [
                under('publish', 'read.publicationClaim', 'then'),
                under('recordTopologyPublication', 'read.publicationClaim', 'then'),
            ],
        }],
    },
    {
        family: rttSeam.family,
        type: [
            'packages/shared-server/rallar-system/services/rtc-topology-mutations.ts',
            'RtcRttMutationComputed',
        ],
        passive: ['replay', 'rejected'],
        atomic: [{
            outcome: 'write',
            property: ['recomputeIntents', ['readonly RtcRttRecomputeIntent[]']],
            seam: rttSeam,
            calls: ['insertRecomputeIntent'],
        }],
    },
];
const pureMutationModules = [...new Set(effects.map(({ type }) => type[0]))];
const astFiles = [...new Set([
    ...paths.map(({ file }) => file),
    ...seams.map(({ file }) => file),
    ...pureMutationModules,
])];
const compilerApi = new API();
const compilerSnapshot = compilerApi.updateSnapshot({
    openFiles: astFiles.map((file) => path.join(repoRoot, file)),
});
afterAll(() => {
    compilerSnapshot.dispose();
    compilerApi.close();
});
describe('read/compute/validate/write implementation contract', () => {
    it('keeps five operation families while guarding both RTC topology paths', () => {
        expect(new Set(paths.map(({ family }) => family)).size).toBe(5);
        expect(paths.filter(({ family }) => family === rtcSeam.family)
            .map(({ name }) => name)).toEqual([
                'RTC topology externally effectful worker path',
                'RTC topology publication-null internal path',
            ]);
    });
    it.each(paths)(
        '$name keeps one syntax-aware branch-local read/compute/validate/write path',
        (contract) => assertPath(repoSource(contract.file), contract),
    );
    it.each(seams)(
        '$family lets only its write seam own begin and guards dependent writes',
        (contract) => assertSeam(repoSource(contract.file), contract),
    );
    it.each(effects)(
        '$family categorizes every discriminant and maps every external effect',
        (contract) => assertEffect(contract),
    );
    it('commits the publication-bearing RTC worker result before fanout', () => {
        const external = paths[3]!;
        const source = repoSource(external.file);
        const owner = findFunction(source, external.owner);
        const publication = findCall(source, owner, 'toTopologyPublication');
        const compute = findCall(source, owner, external.phases[1]);
        const write = findCall(source, owner, external.phases[3]);
        const conflict = findIf(owner, "written === 'conflict'");
        const fanout = findCall(source, owner, 'publish');
        const recorded = findCall(source, owner, 'recordTopologyPublication');
        expect(publication.pos).toBeLessThan(compute.pos);
        expect(compute.pos).toBeLessThan(write.pos);
        expect(write.pos).toBeLessThan(conflict.pos);
        expect(hasKind(conflict.thenStatement, ts.SyntaxKind.ContinueStatement))
            .toBe(true);
        expect(conflict.end).toBeLessThan(fanout.pos);
        expect(fanout.pos).toBeLessThan(recorded.pos);
        expect(normalize(recorded.arguments[0]?.getText(source) ?? '')).toBe('true');
        const internal = findFunction(repoSource(paths[4]!.file), paths[4]!.owner);
        expect(ownedCalls(internal).filter(({ name }) => name === 'publish'))
            .toHaveLength(0);
    });
    it.each(pureMutationModules)('%s keeps compute and validate AST-pure', (file) => {
        assertPure(repoSource(file));
    });
    it('rejects phase names hidden in comments, strings, or nested callbacks', () => {
        withFixture(`
            async function executeMutation() {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    readMutation();
                    const text = 'computeMutation()';
                    // validateMutation();
                    const unrelated = () => computeMutation();
                    writeMutation();
                }
            }
        `, (source) => {
            expect(() => assertPath(source, {
                family: 'fixture', name: 'nested fixture', file: source.fileName,
                owner: ['function', 'executeMutation'], retry: 'attempt < 3',
                phases: [
                    'readMutation', 'computeMutation',
                    'validateMutation', 'writeMutation',
                ],
            })).toThrow(/computeMutation|validateMutation/);
        });
    });
    it('rejects a new unmapped externally effectful discriminant', () => {
        withFixture(`
            type FixtureComputed =
                | { outcome: 'write'; outbox: Outbox }
                | { outcome: 'publish-alert'; alert: Alert };
            async function writeFixture(computed: FixtureComputed) {
                return runtime.begin(async () => {
                    insertGuard();
                    insertOutbox(computed);
                });
            }
        `, (source) => {
            expect(() => assertEffect(fixtureEffect(source), source))
                .toThrow(/publish-alert/);
        });
    });
    it('rejects an effectful discriminant whose atomic writer mapping is removed', () => {
        withFixture(`
            type FixtureComputed = { outcome: 'write'; outbox: Outbox };
            async function writeFixture() {
                return runtime.begin(async () => insertGuard());
            }
        `, (source) => {
            expect(() => assertEffect(fixtureEffect(source), source))
                .toThrow(/insertOutbox/);
        });
    });
    it('keeps the architecture inventory synchronized with all guarded paths', () => {
        const architecture = readRepo('packages/shared-server/architecture.md');
        for (const contract of paths) {
            for (const phase of contract.phases) {
                const name = typeof phase === 'string' ? phase : phase[0];
                expect(architecture, `${contract.name}: ${name}`)
                    .toContain(`\`${name}\``);
            }
        }
        expect(architecture).toContain('createRtcTopologyWorkHandler');
        expect(architecture).toContain('commitTopologyWithRetry');
    });
});
function seam(
    family: string,
    file: string,
    owner: Selector,
    guards: readonly string[],
    dependent: readonly string[],
): SeamContract {
    return { family, file, owner, guards, dependent };
}
function under(
    name: string,
    condition: string,
    side: 'then' | 'else',
): CallSpec {
    return [name, [condition, side]];
}
function fixtureEffect(source: ts.SourceFile): EffectContract {
    return {
        family: 'fixture',
        type: [source.fileName, 'FixtureComputed'],
        passive: [],
        atomic: [{
            outcome: 'write', property: ['outbox', ['Outbox']],
            seam: seam(
                'fixture', source.fileName, ['function', 'writeFixture'],
                ['insertGuard'], [],
            ),
            calls: ['insertOutbox'],
        }],
    };
}
function assertPath(source: ts.SourceFile, contract: PathContract): void {
    const owner = findFunction(source, contract.owner);
    const calls = contract.phases.map((phase) => findCall(source, owner, phase));
    const loops = calls.map((call) => nearestLoop(call, owner));
    for (const loop of loops) {
        expect(normalize(loop.condition?.getText(source) ?? ''), contract.name)
            .toBe(contract.retry);
    }
    expect(new Set(loops.map(({ pos, end }) => `${pos}:${end}`)).size).toBe(1);
    for (let index = 1; index < calls.length; index += 1) {
        expect(calls[index]!.pos, contract.name).toBeGreaterThan(calls[index - 1]!.pos);
    }
}
function assertSeam(source: ts.SourceFile, contract: SeamContract): void {
    const owner = findFunction(source, contract.owner);
    const ownedBegin = ownedCalls(owner).filter(({ name }) => name === 'begin');
    expect(ownedBegin, `${contract.family}: owned begin`).toHaveLength(1);
    expect(allCalls(source).filter(({ name }) => name === 'begin'), contract.family)
        .toHaveLength(1);
    const transaction = callCallback(ownedBegin[0]!.node, source);
    const calls = ownedCalls(transaction);
    const guards = requireCalls(calls, contract.guards, `${contract.family}: guard`);
    const dependent = requireCalls(
        calls, contract.dependent, `${contract.family}: dependent`,
    );
    if (dependent.length > 0) {
        expect(Math.max(...guards.map(({ node }) => node.pos)), contract.family)
            .toBeLessThan(Math.min(...dependent.map(({ node }) => node.pos)));
    }
}
function assertEffect(
    contract: EffectContract,
    provided?: ts.SourceFile,
): void {
    const typeSource = provided ?? repoSource(contract.type[0]);
    const alias = findType(typeSource, contract.type[1]);
    const categorized = [
        ...contract.passive,
        ...contract.atomic.map(({ outcome }) => outcome),
        ...(contract.replay ?? []).map(({ outcome }) => outcome),
    ].sort();
    expect(readOutcomes(alias, typeSource), contract.family).toEqual(categorized);
    for (const mapping of contract.atomic) {
        assertProperty(alias, typeSource, mapping.outcome, mapping.property,
            `${contract.family}:${mapping.outcome}`);
        const writerSource = provided ?? repoSource(mapping.seam.file);
        const writer = findFunction(writerSource, mapping.seam.owner);
        const begin = ownedCalls(writer).filter(({ name }) => name === 'begin');
        expect(begin, `${contract.family}:${mapping.outcome}: begin`).toHaveLength(1);
        const transaction = callCallback(begin[0]!.node, writerSource);
        for (const call of mapping.calls) findCall(writerSource, transaction, call);
    }
    for (const mapping of contract.replay ?? []) {
        assertProperty(alias, typeSource, mapping.outcome, mapping.property,
            `${contract.family}:${mapping.outcome}`);
        const source = provided ?? repoSource(mapping.file);
        const owner = findFunction(source, mapping.owner);
        findIf(owner, mapping.claim);
        for (const call of mapping.calls) findCall(source, owner, call);
    }
}
function assertProperty(
    alias: ts.TypeAliasDeclaration,
    source: ts.SourceFile,
    outcome: string,
    [property, expected]: PropertySpec,
    label: string,
): void {
    const found = new Set<string>();
    const branches = ts.isUnionTypeNode(alias.type) ? alias.type.types : [alias.type];
    for (const branch of branches.filter((node) => hasOutcome(node, source, outcome))) {
        walk(branch, (node) => {
            if (
                isProperty(node) && node.type &&
                normalize(node.name.getText(source)) === property
            ) found.add(normalize(node.type.getText(source)));
            return true;
        });
    }
    expect([...found].sort(), `${label}:${property}`).toEqual([...expected].sort());
}
function assertPure(source: ts.SourceFile): void {
    const forbidden: string[] = [];
    walk(source, (node) => {
        if (ts.isAwaitExpression(node)) forbidden.push('await');
        if (isFunction(node) && node.modifiers?.some(({ kind }) =>
            kind === ts.SyntaxKind.AsyncKeyword)) forbidden.push('async');
        if (ts.isCallExpression(node)) {
            const expression = normalize(node.expression.getText(source));
            if (
                expression === 'Date.now' || expression.startsWith('Temporal.Now.') ||
                expression === 'Math.random' || expression === 'randomUUID' ||
                expression.endsWith('.begin') || expression.startsWith('performance.') ||
                /^(?:repository|runtimeRepository)\./.test(expression)
            ) forbidden.push(expression);
        }
        if (
            ts.isPropertyAccessExpression(node) &&
            /^(?:process|Deno|Bun)\.env(?:\.|$)/.test(normalize(node.getText(source)))
        ) forbidden.push(normalize(node.getText(source)));
        return true;
    });
    expect(forbidden, source.fileName).toEqual([]);
}
type NamedCall = Readonly<{ name: string; node: ts.CallExpression }>;
function findCall(
    source: ts.SourceFile,
    owner: ts.FunctionLikeDeclaration,
    spec: CallSpec,
): ts.CallExpression {
    const [name, expected] = typeof spec === 'string' ? [spec, undefined] : spec;
    const matches = ownedCalls(owner).filter(({ name: actual, node }) =>
        actual === name && sameBranches(readBranches(node, owner, source), expected));
    expect(matches, `${name} in ${owner.getText(source).slice(0, 80)}`).toHaveLength(1);
    return matches[0]!.node;
}
function readBranches(
    node: ts.Node,
    owner: ts.FunctionLikeDeclaration,
    source: ts.SourceFile,
): readonly Branch[] {
    const result: Branch[] = [];
    let current: ts.Node = node;
    while (current !== owner && current.parent) {
        const parent = current.parent;
        if (ts.isIfStatement(parent)) {
            result.push([
                normalize(parent.expression.getText(source)),
                within(node, parent.thenStatement) ? 'then' : 'else',
            ]);
        }
        current = parent;
    }
    return result.reverse();
}
function sameBranches(actual: readonly Branch[], expected?: Branch): boolean {
    return JSON.stringify(actual) === JSON.stringify(expected ? [expected] : []);
}
function nearestLoop(
    node: ts.Node,
    owner: ts.FunctionLikeDeclaration,
): ts.ForStatement {
    let current: ts.Node | undefined = node.parent;
    while (current && current !== owner) {
        if (ts.isForStatement(current)) return current;
        current = current.parent;
    }
    throw new Error(`Missing retry loop for ${node.getText()}`);
}
function findIf(owner: ts.FunctionLikeDeclaration, condition: string): ts.IfStatement {
    const matches: ts.IfStatement[] = [];
    walkOwned(owner, (node) => {
        if (ts.isIfStatement(node) && normalize(node.expression.getText()) === condition) {
            matches.push(node);
        }
    });
    expect(matches, condition).toHaveLength(1);
    return matches[0]!;
}
function findFunction(source: ts.SourceFile, selector: Selector): ts.FunctionLikeDeclaration {
    if (selector[0] === 'callback') {
        const owner = findFunction(source, [selector[1], selector[2]]);
        const matches: ts.FunctionLikeDeclaration[] = [];
        walkOwned(owner, (node) => {
            if (
                ts.isPropertyAssignment(node) &&
                normalize(node.name.getText(source)) === selector[3] &&
                isFunction(node.initializer)
            ) matches.push(node.initializer);
        });
        expect(matches, `${selector[2]}.${selector[3]}`).toHaveLength(1);
        return matches[0]!;
    }
    const matches: ts.FunctionLikeDeclaration[] = [];
    walk(source, (node) => {
        if (
            selector[0] === 'function' && ts.isFunctionDeclaration(node) &&
            node.name?.text === selector[1]
        ) matches.push(node);
        if (
            selector[0] === 'method' && ts.isMethodDeclaration(node) &&
            normalize(node.name.getText(source)) === selector[1]
        ) matches.push(node);
        if (
            selector[0] === 'variable' && ts.isVariableDeclaration(node) &&
            normalize(node.name.getText(source)) === selector[1] &&
            node.initializer && isFunction(node.initializer)
        ) matches.push(node.initializer);
        return true;
    });
    expect(matches, `${selector[0]}:${selector[1]}`).toHaveLength(1);
    return matches[0]!;
}
function findType(source: ts.SourceFile, name: string): ts.TypeAliasDeclaration {
    const matches: ts.TypeAliasDeclaration[] = [];
    walk(source, (node) => {
        if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
            matches.push(node);
        }
        return true;
    });
    expect(matches, name).toHaveLength(1);
    return matches[0]!;
}
function readOutcomes(
    alias: ts.TypeAliasDeclaration,
    source: ts.SourceFile,
): readonly string[] {
    const outcomes = new Set<string>();
    walk(alias.type, (node) => {
        if (
            isProperty(node) && node.type &&
            normalize(node.name.getText(source)) === 'outcome'
        ) readLiterals(node.type).forEach((value) => outcomes.add(value));
        return true;
    });
    return [...outcomes].sort();
}
function hasOutcome(node: ts.Node, source: ts.SourceFile, outcome: string): boolean {
    let found = false;
    walk(node, (candidate) => {
        if (
            isProperty(candidate) && candidate.type &&
            normalize(candidate.name.getText(source)) === 'outcome' &&
            readLiterals(candidate.type).includes(outcome)
        ) found = true;
        return !found;
    });
    return found;
}
function readLiterals(node: ts.Node): string[] {
    const values: string[] = [];
    walk(node, (candidate) => {
        if (
            ts.isLiteralTypeNode(candidate) && ts.isStringLiteral(candidate.literal)
        ) values.push(candidate.literal.text);
        return true;
    });
    return values;
}
function ownedCalls(owner: ts.FunctionLikeDeclaration): readonly NamedCall[] {
    const calls: NamedCall[] = [];
    walkOwned(owner, (node) => {
        if (ts.isCallExpression(node)) calls.push({ name: callName(node), node });
    });
    return calls.sort((left, right) => left.node.pos - right.node.pos);
}
function allCalls(source: ts.SourceFile): readonly NamedCall[] {
    const calls: NamedCall[] = [];
    walk(source, (node) => {
        if (ts.isCallExpression(node)) calls.push({ name: callName(node), node });
        return true;
    });
    return calls;
}
function requireCalls(
    calls: readonly NamedCall[],
    names: readonly string[],
    label: string,
): readonly NamedCall[] {
    return names.flatMap((name) => {
        const matches = calls.filter((call) => call.name === name);
        expect(matches.length, `${label}:${name}`).toBeGreaterThan(0);
        return matches;
    });
}
function callName(call: ts.CallExpression): string {
    if (ts.isIdentifier(call.expression)) return call.expression.text;
    if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
    return normalize(call.expression.getText());
}
function callCallback(
    call: ts.CallExpression,
    source: ts.SourceFile,
): ts.FunctionLikeDeclaration {
    const callback = call.arguments[0];
    expect(callback && isFunction(callback), callback?.getText(source)).toBe(true);
    return callback as ts.FunctionLikeDeclaration;
}
function walkOwned(
    owner: ts.FunctionLikeDeclaration,
    visit: (node: ts.Node) => void,
): void {
    walk(owner.body ?? owner, (node) => {
        if (node !== owner.body && isFunction(node)) return false;
        visit(node);
        return true;
    });
}
function walk(node: ts.Node, visit: (node: ts.Node) => boolean): void {
    if (!visit(node)) return;
    node.forEachChild((child) => {
        walk(child, visit);
        return undefined;
    });
}
function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
    return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node);
}
function isProperty(node: ts.Node): node is ts.PropertySignature {
    return node.kind === ts.SyntaxKind.PropertySignature;
}
function within(node: ts.Node, container: ts.Node): boolean {
    return node.pos >= container.pos && node.end <= container.end;
}
function hasKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
    let found = false;
    walk(node, (candidate) => {
        if (candidate.kind === kind) found = true;
        return !found;
    });
    return found;
}
function normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}
function repoSource(file: string): ts.SourceFile {
    const absolute = path.join(repoRoot, file);
    const source = compilerSnapshot.getDefaultProjectForFile(absolute)?.program
        .getSourceFile(absolute);
    expect(source, file).toBeDefined();
    return source!;
}
function withFixture(source: string, run: (source: ts.SourceFile) => void): void {
    const directory = mkdtempSync(path.join(tmpdir(), 'rallar-write-contract-'));
    const file = path.join(directory, 'fixture.ts');
    writeFileSync(file, source);
    const api = new API();
    const snapshot = api.updateSnapshot({ openFiles: [file] });
    try {
        const parsed = snapshot.getDefaultProjectForFile(file)?.program
            .getSourceFile(file);
        expect(parsed, file).toBeDefined();
        run(parsed!);
    } finally {
        snapshot.dispose();
        api.close();
        rmSync(directory, { recursive: true, force: true });
    }
}
function readRepo(file: string): string {
    return readFileSync(path.join(repoRoot, file), 'utf8');
}
