import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isLayoutTypeScriptFile, layoutRuleIds as rules, scanRepositoryLayout, toKebabCase } from '../../../scripts/repo-style-check/layout-rules.mjs';

const repoRoot = path.resolve('/repo');
describe('repository layout rules', () => {
    it('uses the exact TypeScript projection and defensively ignores JavaScript', () => {
        for (const suffix of ['ts', 'tsx', 'mts', 'cts', 'd.ts']) {
            expect(isLayoutTypeScriptFile(`/repo/feature/value.${suffix}`)).toBe(true);
        }
        expect(isLayoutTypeScriptFile('/repo/feature/value.mjs')).toBe(false);
        const result = scanFiles({ 'feature/value.mjs': 'export const value = 1;' });
        expect(result.findings).toEqual([]);
        expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
    });
    it('normalizes the repository naming forms mechanically', () => {
        expect(toKebabCase('RallarRoomsFacade')).toBe('rallar-rooms-facade');
        expect(toKebabCase('GroupRef')).toBe('group-ref');
        expect(toKebabCase('APIClient')).toBe('api-client');
        expect(toKebabCase('PSqlRepository')).toBe('p-sql-repository');
    });
    it('warns only above the direct TypeScript file threshold', () => {
        expect(scan(makeSources(20)).counts[rules.directoryDensity]).toBe(0);
        expect(scan(makeSources(21)).counts[rules.directoryDensity]).toBe(1);
    });
    it('groups one feature-prefix finding per qualifying cluster', () => {
        const authFiles = featureFiles('auth');
        const result = scan(denseFixture(authFiles));
        const findings = findingsFor(result, rules.featurePrefixCluster);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.affectedCount).toBe(1);
        expect(result.counts[rules.featurePrefixCluster]).toBe(1);
        expect(featurePrefixCount(authFiles.slice(0, 3))).toBe(0);
    });
    it('compares prefixes only with exact immediate-directory tokens', () => {
        expect(featurePrefixCount(featureFiles('auth'), 'packages/example/auth-services')).toBe(0);
        expect(featurePrefixCount(featureFiles('auth'), 'packages/example/auth/services')).toBe(1);
        expect(featurePrefixCount(featureFiles('group'), 'packages/example/groups')).toBe(1);
    });
    it('removes ignored tokens only from the leading run and assigns one cluster per file', () => {
        const files = [
            'read-auth-register-session.ts',
            'compute-auth-write-session.ts',
            'validate-auth-read-session.ts',
            'write-auth-create-session.ts'
        ];
        const findings = findingsFor(scan(denseFixture(files)), rules.featurePrefixCluster);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain('auth');
    });
    it('reports cluster cardinality and at most five sorted samples', () => {
        const files = ['read-auth-a.ts', 'compute-auth-b.ts', 'validate-auth-c.ts'];
        files.push('write-auth-d.ts', 'create-auth-e.ts', 'to-auth-f.ts');
        const message = findingsFor(scan(denseFixture(files)), rules.featurePrefixCluster)[0]?.message;
        const sortedFiles = [...files].sort();
        expect(message).toContain('6 direct files');
        for (const file of sortedFiles.slice(0, 5)) {
            expect(message).toContain(file);
        }
        expect(message).not.toContain(sortedFiles[5]);
    });
    it('groups exact filename, generic-name, tool-name, and mod-boundary cases', () => {
        const result = scan(
            sourceList(
                'feature/ThingService.ts feature/thingService.ts packages/shared/mod.ts ' +
                    'feature/thing-service.ts feature/vite.config.ts packages/shared/feature/mod.ts ' +
                    'feature/types.ts feature/group-state-types.ts packages/shared/ontology/nested/mod.ts ' +
                    'feature/helpers.ts feature/group-state-helpers.ts packages/shared/ontology/mod.ts'
            )
        );
        expect(result.counts[rules.filenameStyle]).toBe(2);
        expect(findingsFor(result, rules.filenameStyle)).toHaveLength(1);
        expect(result.counts[rules.genericFilename]).toBe(2);
        const unapprovedModCount = (file: string) => scan(sourceList(file)).counts[rules.unapprovedMod];
        expect(unapprovedModCount('packages/shared/ontology/mod.ts')).toBe(0);
        expect(unapprovedModCount('packages/shared/ontology/nested/mod.ts')).toBe(1);
    });
    it('parses exported route registration functions instead of matching text', () => {
        const result = scanFiles(
            inDirectory('feature', {
                'thing-routes.ts': toSource(
                    'const text = \'export function init() {}\';',
                    'export function init() {}'
                ),
                'other-routes.ts': 'export function registerOtherRoutes() {}',
                'private-route.ts': 'function init() {}',
                'arrow-routes.ts': 'export const init = () => {};',
                'function-expression-routes.ts': 'export const init = function () {};'
            })
        );
        expect(result.counts[rules.genericRouteInit]).toBe(3);
    });
    it.each([
        ['function declaration', 'function init() {}\nexport { init };', 1],
        ['arrow function', 'const init = () => {};\nexport { init };', 1],
        ['function expression', 'const init = function () {};\nexport { init };', 1],
        ['direct re-export', 'export { init } from \'./other-routes.ts\';', 0],
        ['non-function binding', 'const init = 1;\nexport { init };', 0],
        ['renamed export', 'function init() {}\nexport { init as registerRoutes };', 0],
        ['unrelated export', 'function registerRoutes() {}\nexport { registerRoutes };', 0],
        ['imported binding', 'import { init } from \'./other-routes.ts\';\nexport { init };', 0],
        ['nested callable shadow', 'const init=1; function f(){const init=()=>{}} export{init}', 0]
    ])('resolves an export-list %s to a top-level callable init', (_kind, raw, count) => {
        const result = scanFiles({ 'feature/export-list-routes.ts': raw });
        expect(result.counts[rules.genericRouteInit]).toBe(count);
    });
    it('parses TypeScript type assertions in .ts route modules without JSX', () => {
        const raw = toSource(
            'const routeConfig = <RouteConfig>input;',
            'export function registerTypeAssertionRoutes() {}'
        );
        const result = scanFiles({ 'feature/type-assertion-routes.ts': raw });
        expect(result.counts[rules.genericRouteInit]).toBe(0);
    });
    it('sorts findings deterministically and derives counts from affected items', () => {
        const records = sourceFiles('zeta/types.ts', 'alpha/Thing.ts', 'alpha/helpers.ts');
        const forward = scan(records);
        const reversed = scan([...records].reverse());
        const keys = forward.findings.map(findingKey);
        expect(reversed).toEqual(forward);
        expect(keys).toEqual([...keys].sort());
        expect(forward.counts[rules.filenameStyle]).toBe(1);
        expect(forward.counts[rules.genericFilename]).toBe(2);
        expect(forward.counts[rules.primaryExportName]).toBe(0);
    });
    it('sorts findings by code units across punctuation and non-ASCII paths', () => {
        const result = scan(
            sourceList('order/é/types.ts order/z/types.ts order/-/types.ts order/a/types.ts')
        );
        expect(findingsFor(result, rules.genericFilename).map((item) => item.file)).toEqual(
            ['order/-', 'order/a', 'order/z', 'order/é'].map((file) => path.resolve(repoRoot, file))
        );
    });
    it('opts primary-export matching in without changing default behavior', () => {
        const mismatch = { 'feature/service.ts': 'export class ThingService {}' };
        expect(
            detailCount({ 'feature/thing-service.ts': 'export class ThingService {}' }, 'primary')
        ).toBe(0);
        expect(detailCount(mismatch, 'primary')).toBe(1);
        expect(scanFiles(mismatch).counts[rules.primaryExportName]).toBe(0);
    });
    it('selects direct export kinds while skipping ambiguous and conventional exports', () => {
        const declarations = inDirectory('feature', {
            'read-thing.ts': 'export function readThing() {}',
            'thing-service.ts': 'export class ThingService {}',
            'thing-input.ts': 'export interface ThingInput {}',
            'thing-result.ts': 'export type ThingResult = string;',
            'thing-state.ts': 'export enum ThingState { Ready }',
            'thing-value.ts': 'export const ThingValue = 1;'
        });
        const skipped = inDirectory('feature', {
            'contracts.ts': toSource('export interface ThingInput {}', 'export interface ThingOutput {}'),
            'values.ts': 'export const firstValue = 1, secondValue = 2;',
            're-export.ts': 'export { ThingService } from \'./thing-service.ts\';',
            'export-all.ts': 'export * from \'./thing-service.ts\';',
            'anonymous-class.ts': 'export default class {}',
            'anonymous-function.ts': 'export default function () {}',
            'mod.ts': 'export class WrongName {}',
            'index.ts': 'export class WrongName {}',
            'vite.config.ts': 'export class WrongName {}',
            'prisma.config.ts': 'export class WrongName {}'
        });
        const overloads = toSource(
            'export function thingService(value: string): string;',
            'export function thingService(value: number): number;',
            'export function thingService(value: string | number) { return value; }'
        );
        expect(detailCount(declarations, 'primary')).toBe(0);
        expect(detailCount(skipped, 'primary')).toBe(0);
        expect(detailCount({ 'feature/service.ts': overloads }, 'primary')).toBe(1);
    });
    it('classifies named browser imports by exact module and original export name', () => {
        const files = browserFiles({
            'group-room.ts': apiImport('import type { GroupSnapshot }'),
            'create-room.ts': toSource(
                apiImport('import type { CreateGroupRequest }', 'state'),
                'export function createRoom(input: CreateGroupRequest) { return input; }'
            ),
            'room-events.ts': apiImport('import type { StateEventPage }', 'state-event')
        });
        expect(detailCount(files, 'browser')).toBe(3);
        const alias = details(
            browserFiles({
                'room-snapshot.ts': apiImport('import type { GroupSnapshot as RoomSnapshot }')
            }),
            'browser'
        )[0];
        expect(alias?.message).toContain('GroupSnapshot');
        expect(alias?.message).toContain('RoomSnapshot');
    });
    it('preserves exact GroupRef and roomRef protocol exemptions before aliasing', () => {
        const files = browserFiles({
            'room-group-ref.ts': apiImport('import type { GroupRef }'),
            'room-ref.ts': apiImport('import { roomRef }'),
            'room-ref-alias.ts': apiImport('import type { GroupRef as RoomRef }')
        });
        expect(detailCount(files, 'browser')).toBe(0);
    });
    it('warns for namespace and default imports from every authoritative module', () => {
        const files = browserFiles({
            'group-default.ts': apiImport('import GroupTypes'),
            'group-namespace.ts': apiImport('import * as GroupTypes'),
            'state-default.ts': apiImport('import StateTypes', 'state'),
            'state-namespace.ts': apiImport('import * as StateTypes', 'state'),
            'events-default.ts': apiImport('import StateEventTypes', 'state-event'),
            'events-namespace.ts': apiImport('import * as StateEventTypes', 'state-event')
        });
        expect(detailCount(files, 'browser')).toBe(6);
    });
    it('ignores browser syntax and paths outside the exact direct-import boundary', () => {
        const files = {
            ...browserFiles({
                'room-side-effect.ts': 'import \'@shared/api/group-types.ts\';',
                'room-dynamic.ts': 'const groupTypes = import(\'@shared/api/group-types.ts\');',
                'room-re-export.ts': apiImport('export { GroupSnapshot }'),
                'room-relative.ts': 'import type { GroupSnapshot } from \'../../api/group-types.ts\';',
                'room-other-module.ts': apiImport('import type { GroupSnapshot }', 'other'),
                'room-non-authoritative.ts': apiImport('import type { GroupRefValue }')
            }),
            'packages/shared-web/browser/state/create-state.ts': apiImport(
                'import type { GroupSnapshot }'
            )
        };
        expect(detailCount(files, 'browser')).toBe(0);
    });
    it('exempts only the exact translation file and reports sorted import evidence once', () => {
        const translation = apiImport('import type { CreateGroupRequest }', 'state');
        const exact = browserFiles({ 'room-group-state-translation.ts': translation });
        const moved = inDirectory('packages/shared-web/browser/adapters', {
            'room-group-state-translation.ts': translation
        });
        expect(detailCount(exact, 'browser')).toBe(0);
        expect(detailCount(moved, 'browser')).toBe(1);
        const findings = details(
            browserFiles({
                'create-room.ts': toSource(
                    apiImport('import type { StateEventPage }', 'state-event'),
                    apiImport('import type { GroupSnapshot as RoomSnapshot }'),
                    apiImport('import type { CreateGroupRequest }', 'state')
                )
            }),
            'browser'
        );
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain(
            'CreateGroupRequest, GroupSnapshot as RoomSnapshot, StateEventPage'
        );
    });
    it('warns for room vocabulary only in server group-state declaration names', () => {
        const files = inDirectory('packages/shared-server/example', {
            'group-state-policy.ts': 'export interface RoomPolicy {}',
            'group-state-service.ts': 'export interface GroupPolicy {}',
            'group-state-ref.ts': toSource(
                apiImport('import { GroupRef, roomRef }'),
                'export function toKey(group: GroupRef) { return roomRef(group); }'
            ),
            'group-state-comments.ts': toSource(
                '// room policy is translated at the boundary',
                'const description = \'rooms remain outside this module\';'
            )
        });
        expect(detailCount(files, 'server')).toBe(1);
    });
    it.each([
        ['roomPolicy', 'class GroupPolicy { #roomPolicy = true; }'],
        ['RoomValue', 'interface GroupPolicy<RoomValue> {}'],
        ['roomError', 'try {} catch (roomError) {}']
    ])('warns for room vocabulary in the %s declaration', (sample, raw) => {
        const findings = details(serverFiles({ [`group-state-${sample}.ts`]: raw }), 'server');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain(sample);
    });
    it('warns for room vocabulary in a declared class method', () => {
        const raw = 'declare class GroupPolicy { roomPolicy(): void; }';
        const findings = details(serverFiles({ 'group-state-declared.ts': raw }), 'server');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain('roomPolicy');
    });
    it('continues to ignore imported, referenced, commented, and string room names', () => {
        const raw = toSource(
            'import type { RoomImport } from \'./room-import.ts\';',
            '// room comment',
            'const description = \'room string\';',
            'export function readPolicy(value: RoomUse) { return roomUse; }'
        );
        expect(detailCount(serverFiles({ 'group-state-use-sites.ts': raw }), 'server')).toBe(0);
    });
    it('recognizes all server group-state module criteria and whole identifier tokens', () => {
        const files = {
            ...serverFiles({
                'group-state-policy.ts': 'export interface ActiveRoomsPolicy {}',
                'group-state-bedroom.ts': 'export interface BedroomPolicy {}',
                'group-state-identities.ts': toSource(
                    'export interface GroupRef {}',
                    'export const roomRef = () => undefined;'
                ),
                'ordinary-policy.ts': 'export interface RoomPolicy {}',
                'policy.ts': toSource('export interface GroupState {}', 'const RoomAdmission = true;')
            }),
            'packages/shared-server/rallar-system/group-state/policy.ts': 'export const RoomCapacity = 4;'
        };
        const findings = details(files, 'server');
        expect(findings).toHaveLength(3);
        expect(findings.map((item) => path.basename(item.file))).toEqual([
            'group-state-policy.ts',
            'policy.ts',
            'policy.ts'
        ]);
    });
    it('sorts and limits server vocabulary evidence to five identifier samples', () => {
        const raw = ['ZetaRoom', 'AlphaRoom', 'GammaRooms', 'BetaRoom', 'DeltaRooms', 'EpsilonRoom']
            .map((name) => `const ${name} = 1;`)
            .join('\n');
        const message = details(serverFiles({ 'group-state-many.ts': raw }), 'server')[0]?.message;
        expect(message).toContain('AlphaRoom, BetaRoom, DeltaRooms, EpsilonRoom, GammaRooms');
        expect(message).not.toContain('ZetaRoom');
    });
    it('reproduces the 22-cluster planning count deterministically', () => {
        const result = scanRepositoryLayout({ repoRoot, sources: planningCountFixture() });
        const findings = findingsFor(result, rules.featurePrefixCluster);
        expect(findings).toHaveLength(22);
        expect(findings.every((item) => item.affectedCount === 1)).toBe(true);
        expect(new Set(findings.map((item) => item.file))).toHaveLength(8);
        expect(result.counts[rules.featurePrefixCluster]).toBe(22);
    });
});

interface SourceRecord {
    readonly file: string;
    readonly raw: string;
}
type ScanResult = ReturnType<typeof scanRepositoryLayout>;
type Files = Readonly<Record<string, string>>;
type DetailRule = keyof typeof detailRuleIds;

const detailRuleIds = {
    primary: rules.primaryExportName,
    browser: rules.browserRoomBoundary,
    server: rules.serverGroupStateVocabulary
} as const;
const toSource = (...lines: string[]) => lines.join('\n');
const serverFiles = (files: Files) => inDirectory('packages/shared-server/example', files);
const apiImport = (clause: string, module = 'group') => `${clause} from '@shared/api/${module}-types.ts';`;
const browserFiles = (files: Files) => inDirectory('packages/shared-web/browser/rooms', files);
const scan = (sourceRecords: readonly SourceRecord[]): ScanResult => scanRepositoryLayout({ repoRoot, sources: sourceRecords });
const scanFiles = (files: Files) => scan(sources(files));
const sourceFiles = (...files: string[]) => sources(Object.fromEntries(files.map((file) => [file, ''])));
const sourceList = (files: string) => sourceFiles(...files.split(' '));
const detailCount = (files: Files, rule: DetailRule) => details(files, rule).length;
function details(files: Files, rule: DetailRule) {
    const result = scanRepositoryLayout({ repoRoot, sources: sources(files), includeDetails: true });
    return result.findings.filter((finding) => finding.ruleId === detailRuleIds[rule]);
}
const sources = (files: Files): SourceRecord[] => Object.entries(files).map(([file, raw]) => ({ file: path.resolve(repoRoot, file), raw }));
const inDirectory = (directory: string, files: Files) => Object.fromEntries(Object.entries(files).map(([file, raw]) => [`${directory}/${file}`, raw]));
function makeSources(count: number, directory = 'packages/example/dense'): SourceRecord[] {
    const files = Array.from({ length: count }, (_, index) => `${directory}/item${index}-source.ts`);
    return sourceFiles(...files);
}
const featureFiles = (prefix: string) => ['read', 'compute', 'validate', 'write'].map((action) => `${action}-${prefix}-session.ts`);
const featurePrefixCount = (files: readonly string[], directory?: string) => scan(denseFixture(files, directory)).counts[rules.featurePrefixCluster];
function denseFixture(
    featureFileNames: readonly string[],
    directory = 'packages/example/dense-review'
): SourceRecord[] {
    const files = [...featureFileNames];
    for (let index = featureFileNames.length; index < 21; index += 1) {
        files.push(`filler${index}-source.ts`);
    }
    return sourceFiles(...files.map((file) => `${directory}/${file}`));
}
function planningCountFixture(): SourceRecord[] {
    return [3, 3, 3, 3, 3, 3, 2, 2].flatMap((clusterCount, directoryIndex) => {
        const featureNames = Array.from({ length: clusterCount }, (_, clusterIndex) =>
            ['read', 'compute', 'validate', 'write'].map(
                (action) => `${action}-feature${directoryIndex}${clusterIndex}-value.ts`
            )).flat();
        return denseFixture(featureNames, `packages/planning/zone-${directoryIndex}`);
    });
}
const findingsFor = (result: ScanResult, ruleId: string) => result.findings.filter((finding) => finding.ruleId === ruleId);
const findingKey = (finding: ScanResult['findings'][number]) => `${finding.file}\u0000${finding.ruleId}\u0000${finding.message}`;
