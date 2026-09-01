import { parse } from '@babel/parser';
import path from 'node:path';

import { compareCodeUnits, compareFindings, toFinding } from './layout-findings.mjs';

const typeScriptSuffixPattern = /(?:\.d)?\.(?:ts|tsx|mts|cts)$/u;
// A filename may carry conventional role qualifiers before its extension -- `.test`,
// `.browser.test`, `.config`, `.worker`. Those describe the file's role, not its name, so
// they are removed before the kebab-case and generic-stem checks read the owning noun.
const fileRoleQualifiers = 'test|spec|browser|worker|config|typecheck|full-stack|recipe-console|exhaustive';
const fileRoleQualifierPattern = new RegExp(`(?:\\.(?:${fileRoleQualifiers}))+$`, 'u');
const kebabCasePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const toWordSet = (value) => new Set(value.split(' '));
const genericFileStems = toWordSet('utils types helpers contracts runtime middleware');
const conventionalToolFileNames = new Set(['prisma.config.ts', 'vite.config.ts']);
const ignoredLeadingFeatureTokens = toWordSet(
    'app api browser cached compute create default rallar read register server shared ' +
        'to use v1 v2 validate write'
);
const approvedModCompatibilityBoundaries = toWordSet(
    'packages/relic-hunters/mod.ts packages/shared-graph/mod.ts packages/shared/ontology/mod.ts ' +
        'packages/shared-server/mod.ts packages/shared/mod.ts ' +
        'packages/shared-test/rallar-bb-test/mod.ts ' +
        'packages/shared-web/game/mod.ts packages/shared-web/mod.ts packages/shared/crdt/mod.ts ' +
        'packages/shared/rallar-ai/mod.ts packages/shared/rallar-game/mod.ts ' +
        'packages/shared/rallar-match/mod.ts packages/shared/rallar-motion/mod.ts'
);
const authoritativeBrowserImports = new Map([
    [
        '@shared/api/group-types.ts',
        toWordSet(
            'Group GroupEvent GroupEventType GroupJoinMode GroupMember GroupMemberStatus ' +
                'GroupPresenceAdmission GroupPresenceAdmissionSession GroupPresenceSession ' +
                'GroupPresenceSummary GroupRole GroupSnapshot GroupStateCausalRevision GroupStatus'
        )
    ],
    [
        '@shared/api/state-types.ts',
        toWordSet(
            'AcceptGroupInviteRequest AppointGroupDirectorRequest BanGroupMemberRequest ' +
                'ConnectGroupPresenceSessionRequest CreateGroupInviteRequest CreateGroupRequest ' +
                'DisconnectGroupPresenceSessionRequest GroupJoinCodeResponse ' +
                'HeartbeatGroupPresenceSessionRequest JoinGroupRequest RemoveGroupMemberRequest ' +
                'RevokeGroupInviteRequest RotateGroupJoinCodeRequest SetGroupMemberRoleRequest ' +
                'TransferGroupOwnershipRequest UnbanGroupMemberRequest UpdateGroupRequest ' +
                'UpsertGroupMemberRequest'
        )
    ],
    ['@shared/api/state-event-types.ts', toWordSet('StateEventCursor StateEventPage')]
]);
const browserPrefix = 'packages/shared-web/browser/';
const browserRoomsPrefix = `${browserPrefix}rooms/`;
const browserTranslationFile = `${browserRoomsPrefix}room-group-state-translation.ts`;
const serverPrefix = 'packages/shared-server/';
const serverGroupStatePrefix = `${serverPrefix}rallar-system/group-state/`;
const protocolIdentityNames = new Set(['GroupRef', 'roomRef']);
const primaryDeclarationTypes = toWordSet(
    'ClassDeclaration FunctionDeclaration TSDeclareFunction TSEnumDeclaration ' +
        'TSInterfaceDeclaration TSTypeAliasDeclaration'
);
const declarationIdTypes = new Set([...primaryDeclarationTypes, 'TSModuleDeclaration']);
const declarationKeyTypes = toWordSet(
    'ClassMethod ClassPrivateMethod ClassPrivateProperty ClassProperty ObjectMethod ' +
        'TSDeclareMethod TSMethodSignature TSPropertySignature'
);
const functionExpressionTypes = toWordSet('ArrowFunctionExpression FunctionExpression');
export const layoutLimits = Object.freeze({
    directTypeScriptFileCount: 20,
    featurePrefixFileCount: 4,
    displayedFileSampleCount: 5
});
export const layoutRuleIds = Object.freeze({
    directoryDensity: 'layout.directory-density',
    featurePrefixCluster: 'layout.feature-prefix-cluster',
    filenameStyle: 'layout.filename-style',
    genericFilename: 'layout.generic-filename',
    genericRouteInit: 'layout.generic-route-init',
    unapprovedMod: 'layout.unapproved-mod',
    primaryExportName: 'layout.primary-export-name',
    browserRoomBoundary: 'layout.browser-room-boundary',
    serverGroupStateVocabulary: 'layout.server-group-state-vocabulary'
});
export const isLayoutTypeScriptFile = (file) => typeScriptSuffixPattern.test(file);
export function toKebabCase(value) {
    return value
        .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
        .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
        .replace(/[_\s]+/gu, '-')
        .replace(/-+/gu, '-')
        .replace(/^-|-$/gu, '')
        .toLowerCase();
}
export function scanRepositoryLayout(input) {
    const sources = input.sources
        .filter((source) => isLayoutTypeScriptFile(source.file))
        .map((source) => ({ ...source, file: path.resolve(source.file) }));
    const findings = [];
    scanDirectories(sources, findings);
    scanSourceDeclarations(input, sources, findings);
    scanModBoundaries(input.repoRoot, sources, findings);
    findings.sort(compareFindings);
    const counts = Object.fromEntries(Object.values(layoutRuleIds).map((ruleId) => [ruleId, 0]));
    findings.forEach((item) => (counts[item.ruleId] += item.affectedCount));
    return { findings, counts };
}
function scanDirectories(sources, findings) {
    const sourcesByDirectory = groupBy(sources, (source) => path.dirname(source.file));
    for (const directory of [...sourcesByDirectory.keys()].sort()) {
        const directSources = sourcesByDirectory
            .get(directory)
            .toSorted((left, right) => path.basename(left.file).localeCompare(path.basename(right.file)));
        const fileNames = directSources.map((source) => path.basename(source.file));
        scanDirectoryDensity(directory, directSources, findings);
        addFileGroupFinding({
            findings,
            directory,
            fileNames: fileNames
                .filter((fileName) => !conventionalToolFileNames.has(fileName))
                .filter((fileName) => !kebabCasePattern.test(toTypeScriptStem(fileName))),
            ruleId: layoutRuleIds.filenameStyle,
            message: 'TypeScript filenames are not kebab-case.'
        });
        addFileGroupFinding({
            findings,
            directory,
            fileNames: fileNames.filter((fileName) => genericFileStems.has(toTypeScriptStem(fileName))),
            ruleId: layoutRuleIds.genericFilename,
            message: 'generic filenames need an owning feature noun and role.'
        });
    }
}
function scanDirectoryDensity(directory, directSources, findings) {
    if (directSources.length <= layoutLimits.directTypeScriptFileCount) {
        return;
    }
    const densityMessage = `Review feature ownership: this directory has ${directSources.length} ` +
        'direct production TypeScript files ' +
        `(review threshold > ${layoutLimits.directTypeScriptFileCount}). This is ` +
        'not an instruction to create folders or pass-through modules mechanically.';
    findings.push(toFinding(directory, layoutRuleIds.directoryDensity, densityMessage));
    const directoryTokens = new Set(toKebabCase(path.basename(directory)).split('-'));
    const filesByPrefix = groupBy(
        directSources.filter((source) => getFeaturePrefix(source.file, directoryTokens) !== undefined),
        (source) => getFeaturePrefix(source.file, directoryTokens)
    );
    for (const prefix of [...filesByPrefix.keys()].sort()) {
        const fileNames = filesByPrefix
            .get(prefix)
            .map((source) => path.basename(source.file))
            .sort();
        if (fileNames.length < layoutLimits.featurePrefixFileCount) {
            continue;
        }
        const prefixMessage = `Review feature ownership: prefix '${prefix}' appears in ${fileNames.length} ` +
            `direct files. Samples: ${sampleFileNames(fileNames)}. This is not an instruction ` +
            'to create folders or pass-through modules mechanically.';
        findings.push({
            ...toFinding(directory, layoutRuleIds.featurePrefixCluster, prefixMessage),
            symbol: `prefix:${prefix}`
        });
    }
}
function addFileGroupFinding(input) {
    if (input.fileNames.length === 0) {
        return;
    }
    const detail = `${input.fileNames.length} ${input.message} Samples: ` + `${sampleFileNames(input.fileNames)}.`;
    const finding = toFinding(input.directory, input.ruleId, detail);
    input.findings.push({ ...finding, affectedCount: input.fileNames.length });
}
function scanSourceDeclarations(input, sources, findings) {
    for (const source of sources) {
        const stem = toTypeScriptStem(path.basename(source.file));
        const isRoute = stem.endsWith('-route') || stem.endsWith('-routes');
        if (!isRoute && input.includeDetails !== true) {
            continue;
        }
        const program = parseProgram(source);
        if (isRoute && hasExportedInitFunction(program)) {
            const message = 'Exported route registration function init needs a descriptive feature name.';
            findings.push(toFinding(source.file, layoutRuleIds.genericRouteInit, message));
        }
        if (input.includeDetails === true) {
            scanPrimaryExport(source, program, findings);
            findings.push(...scanBrowserBoundary(input.repoRoot, source, program));
            findings.push(...scanServerVocabulary(input.repoRoot, source, program));
        }
    }
}
function scanPrimaryExport(source, program, findings) {
    const fileName = path.basename(source.file);
    const stem = toTypeScriptStem(fileName);
    if (stem === 'mod' || stem === 'index' || conventionalToolFileNames.has(fileName)) {
        return;
    }
    const names = getDirectExportNames(program);
    const [name] = names;
    if (names.size === 1 && toKebabCase(name) !== stem) {
        const message = `Primary export ${name} does not match filename stem ${stem}.`;
        findings.push({
            ...toFinding(source.file, layoutRuleIds.primaryExportName, message),
            symbol: name
        });
    }
}
function scanBrowserBoundary(repoRoot, source, program) {
    const relativeFile = toRelativeFile(repoRoot, source.file);
    const isRoomOwned = relativeFile.startsWith(browserRoomsPrefix) ||
        (relativeFile.startsWith(browserPrefix) &&
            hasRoomToken(toTypeScriptStem(path.basename(source.file))));
    if (!isRoomOwned || relativeFile === browserTranslationFile) {
        return [];
    }
    const evidence = new Set();
    for (const statement of program.body) {
        if (statement.type !== 'ImportDeclaration') {
            continue;
        }
        const authoritativeNames = authoritativeBrowserImports.get(statement.source.value);
        if (authoritativeNames === undefined) {
            continue;
        }
        for (const specifier of statement.specifiers) {
            if (specifier.type === 'ImportDefaultSpecifier') {
                evidence.add(`default as ${specifier.local.name}`);
            }
            else if (specifier.type === 'ImportNamespaceSpecifier') {
                evidence.add(`namespace:* as ${specifier.local.name}`);
            }
            else {
                const originalName = specifier.imported.name ?? specifier.imported.value;
                if (protocolIdentityNames.has(originalName) || !authoritativeNames.has(originalName)) {
                    continue;
                }
                evidence.add(
                    originalName === specifier.local.name
                        ? originalName
                        : `${originalName} as ${specifier.local.name}`
                );
            }
        }
    }
    if (evidence.size === 0) {
        return [];
    }
    const samples = [...evidence].sort(compareCodeUnits).join(', ');
    const message = `Room-owned browser code imports authoritative group state directly. ` +
        `Evidence: ${samples}.`;
    return [toFinding(source.file, layoutRuleIds.browserRoomBoundary, message)];
}
function scanServerVocabulary(repoRoot, source, program) {
    const relativeFile = toRelativeFile(repoRoot, source.file);
    const stemTokens = toKebabCase(toTypeScriptStem(path.basename(source.file))).split('-');
    const hasGroupStateToken = stemTokens.some(
        (token, index) => token === 'group' && stemTokens[index + 1] === 'state'
    );
    if (
        !relativeFile.startsWith(serverPrefix) ||
        (!hasGroupStateToken &&
            !getDirectExportNames(program, declarationIdTypes).has('GroupState') &&
            !relativeFile.startsWith(serverGroupStatePrefix))
    ) {
        return [];
    }
    const samples = [...getDeclaredIdentifierNames(program)]
        .filter((name) => !protocolIdentityNames.has(name))
        .filter(hasRoomToken)
        .sort(compareCodeUnits)
        .slice(0, layoutLimits.displayedFileSampleCount);
    if (samples.length === 0) {
        return [];
    }
    const message = `Server group-state declarations use room vocabulary: ${samples.join(', ')}.`;
    return [toFinding(source.file, layoutRuleIds.serverGroupStateVocabulary, message)];
}
function scanModBoundaries(repoRoot, sources, findings) {
    for (const source of sources) {
        if (
            path.basename(source.file) === 'mod.ts' &&
            !approvedModCompatibilityBoundaries.has(toRelativeFile(repoRoot, source.file))
        ) {
            const message = 'mod.ts is not an approved package compatibility boundary.';
            findings.push(toFinding(source.file, layoutRuleIds.unapprovedMod, message));
        }
    }
}
function getDirectExportNames(program, declarationTypes = primaryDeclarationTypes) {
    const names = new Set();
    for (const statement of program.body) {
        if (
            (statement.type === 'ExportNamedDeclaration' ||
                statement.type === 'ExportDefaultDeclaration') &&
            statement.declaration !== null
        ) {
            const declaration = statement.declaration;
            if (declaration.type === 'VariableDeclaration') {
                declaration.declarations.forEach((item) => addBindingNames(item.id, names));
            }
            else if (declarationTypes.has(declaration.type)) {
                addBindingNames(declaration.id, names);
            }
        }
    }
    return names;
}
function getDeclaredIdentifierNames(program) {
    const names = new Set();
    walkAst(program, (node) => {
        if (node.type === 'ImportDeclaration') {
            return false;
        }
        if (
            declarationIdTypes.has(node.type) ||
            node.type === 'VariableDeclarator' ||
            node.type === 'TSEnumMember'
        ) {
            addBindingNames(node.id, names);
        }
        else if (declarationKeyTypes.has(node.type) && !node.computed) {
            addBindingNames(node.key, names);
        }
        else if (node.type === 'TSTypeParameter' || node.type === 'CatchClause') {
            addBindingNames(node.type === 'CatchClause' ? node.param : node.name, names);
        }
        node.params?.forEach((parameter) => addBindingNames(parameter, names));
        return true;
    });
    return names;
}
function addBindingNames(pattern, names) {
    if (pattern?.type === 'PrivateName') {
        addBindingNames(pattern.id, names);
    }
    else if (pattern?.type === 'Identifier') {
        names.add(pattern.name);
    }
    else if (pattern?.type === 'RestElement') {
        addBindingNames(pattern.argument, names);
    }
    else if (pattern?.type === 'AssignmentPattern') {
        addBindingNames(pattern.left, names);
    }
    else if (pattern?.type === 'TSParameterProperty') {
        addBindingNames(pattern.parameter, names);
    }
    else if (pattern?.type === 'ArrayPattern') {
        pattern.elements.forEach((item) => addBindingNames(item, names));
    }
    else if (pattern?.type === 'ObjectPattern') {
        pattern.properties.forEach((item) =>
            addBindingNames(item.type === 'RestElement' ? item.argument : item.value, names)
        );
    }
}
function walkAst(node, visit) {
    if (Array.isArray(node)) {
        node.forEach((item) => walkAst(item, visit));
    }
    else if (node !== null && typeof node === 'object' && typeof node.type === 'string') {
        if (visit(node) !== false) {
            Object.values(node).forEach((value) => walkAst(value, visit));
        }
    }
}
const isInitExport = (item) => item.local?.name === 'init' && item.exported?.name === 'init';
function hasExportedInitFunction(program) {
    const hasLocalCallableInit = program.body.some(isCallableInitDeclaration);
    return program.body.some(
        (statement) =>
            statement.type === 'ExportNamedDeclaration' &&
            (isCallableInitDeclaration(statement.declaration) ||
                (hasLocalCallableInit &&
                    statement.source === null &&
                    statement.specifiers.some(isInitExport)))
    );
}
function isCallableInitDeclaration(declaration) {
    return (
        (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === 'init') ||
        (declaration?.type === 'VariableDeclaration' &&
            declaration.declarations.some(
                ({ id, init }) =>
                    id.type === 'Identifier' && id.name === 'init' && functionExpressionTypes.has(init?.type)
            ))
    );
}
function parseProgram(source) {
    return parse(source.raw, {
        sourceFilename: source.file,
        sourceType: 'module',
        plugins: source.file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript']
    }).program;
}
function getFeaturePrefix(file, directoryTokens) {
    const tokens = toKebabCase(toTypeScriptStem(path.basename(file))).split('-');
    const prefix = tokens.find((token) => !ignoredLeadingFeatureTokens.has(token));
    return prefix === undefined || directoryTokens.has(prefix) ? undefined : prefix;
}
const hasRoomToken = (name) => /(?:^|-)(?:room|rooms)(?:-|$)/u.test(toKebabCase(name));
const toRelativeFile = (repoRoot, file) => path.relative(repoRoot, file).split(path.sep).join('/');
const toTypeScriptStem = (fileName) =>
    fileName.replace(typeScriptSuffixPattern, '').replace(fileRoleQualifierPattern, '');
const sampleFileNames = (fileNames) => [...fileNames].sort().slice(0, layoutLimits.displayedFileSampleCount).join(', ');
function groupBy(values, toKey) {
    const valuesByKey = new Map();
    for (const value of values) {
        const key = toKey(value);
        const groupedValues = valuesByKey.get(key) ?? [];
        groupedValues.push(value);
        valuesByKey.set(key, groupedValues);
    }
    return valuesByKey;
}
