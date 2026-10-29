const SCOPE_ROLE = 'scope';

const PARALLEL_GROUPS_ROLE = 'parallel-groups';

const PARALLEL_GROUP_ROLE = 'parallel-group';

const WAIT_MATCH_ROLE = 'wait-match';

const WAIT_PAYLOAD_FIELDS_ROLE = 'wait-payload-fields';

const stateGroupPathPattern = new RegExp(
    String.raw`^/api/state/apps/([^/]+)/workspaces/([^/]+)/groups` +
        String.raw`(?:/(?!requests(?:/|$))([^/]+))?(?=/|$)`
);

// A workspace-scoped client read carries application and workspace but no group segment.
const stateWorkspaceReadPathPattern = new RegExp(
    String.raw`^/api/state/apps/([^/]+)/workspaces/([^/]+)(?=/clients$)`
);

const identityFieldNames = new Set(['applicationId', 'workspaceId', 'groupId', 'roomId']);

// A wait's payload field is keyed by the payload path it reads, so its identity name is the path's last segment.
function toIdentityFieldName(key, role) {
    return role === WAIT_PAYLOAD_FIELDS_ROLE ? key.slice(key.lastIndexOf('.') + 1) : key;
}

// Match complete JSON string tokens without requiring the surrounding fragment or runtime placeholders to parse.
const serializedScopeIdentityPattern =
    /(^|[{,]\s*)("(roomId|groupId|applicationId|workspaceId)"\s*:\s*)("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")/g;

export function validateHetznerRunManifestScope(value, expectedGroupRef) {
    return validateManifestScopeValue(value, expectedGroupRef, {
        location: '$',
        role: SCOPE_ROLE
    });
}

export function toEffectiveHetznerRunManifestScope(value, sourceGroupRef, effectiveGroupRef) {
    return toEffectiveScopeValue(
        value,
        { sourceGroupRef, effectiveGroupRef },
        { key: '', role: SCOPE_ROLE }
    );
}

function toStatePathScope(value) {
    const group = value.match(stateGroupPathPattern);
    if (group) {
        return {
            prefix: group[0],
            applicationId: group[1],
            workspaceId: group[2],
            groupId: group[3],
            groupScoped: true
        };
    }
    const workspace = value.match(stateWorkspaceReadPathPattern);
    if (workspace) {
        return {
            prefix: workspace[0],
            applicationId: workspace[1],
            workspaceId: workspace[2],
            groupId: undefined,
            groupScoped: false
        };
    }
    return undefined;
}

function decodePathSegment(value, location, issues) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        issues.push(
            `${location} contains an invalid URI-encoded identity segment ${JSON.stringify(value)}`
        );
        return value;
    }
}

function validateEmbeddedPathScope(value, expectedGroupRef, location) {
    if (!value.startsWith('/api/state/apps/')) {
        return [];
    }

    const issues = [];
    const pathScope = toStatePathScope(value);
    if (!pathScope) {
        return [`${location} has an unrecognized state group path ${JSON.stringify(value)}`];
    }

    const applicationId = decodePathSegment(pathScope.applicationId, location, issues);
    const workspaceId = decodePathSegment(pathScope.workspaceId, location, issues);
    const groupId = pathScope.groupId === undefined
        ? undefined
        : decodePathSegment(pathScope.groupId, location, issues);
    if (applicationId !== expectedGroupRef.applicationId) {
        issues.push(
            `${location} contains application ${JSON.stringify(applicationId)}; ` +
                `expected ${JSON.stringify(expectedGroupRef.applicationId)}`
        );
    }
    if (workspaceId !== expectedGroupRef.workspaceId) {
        issues.push(
            `${location} contains workspace ${JSON.stringify(workspaceId)}; ` +
                `expected ${JSON.stringify(expectedGroupRef.workspaceId)}`
        );
    }
    if (groupId !== undefined && groupId !== expectedGroupRef.groupId) {
        issues.push(
            `${location} contains group ${JSON.stringify(groupId)}; ` +
                `expected ${JSON.stringify(expectedGroupRef.groupId)}`
        );
    }
    return issues;
}

function validateEmbeddedRequestScope(value, expectedGroupRef, location) {
    const request = toScopedRequestIdentity(value);
    if (!request) {
        return [];
    }

    const scope = request.segments;
    const expectedScope = [
        expectedGroupRef.applicationId,
        expectedGroupRef.workspaceId,
        expectedGroupRef.groupId
    ];
    if (scope.length < expectedScope.length) {
        return [`${location} has an incomplete scoped request identity ${JSON.stringify(value)}`];
    }

    return expectedScope.flatMap((expected, index) =>
        scope[index] === expected
            ? []
            : [
                `${location} contains scoped request identity ${JSON.stringify(value)}; ` +
                `expected ${JSON.stringify(expectedGroupRef)}`
            ]
    );
}

function validateEmbeddedScope(input) {
    const { value, key, role, expectedGroupRef, location } = input;
    if (typeof value !== 'string') {
        return [];
    }
    if (key === 'path') {
        return validateEmbeddedPathScope(value, expectedGroupRef, location);
    }
    if (key === 'requestId' || key.toLowerCase() === 'idempotency-key') {
        return validateEmbeddedRequestScope(value, expectedGroupRef, location);
    }
    if (role === WAIT_MATCH_ROLE && key === 'contains') {
        return validateSerializedScope(value, expectedGroupRef, location);
    }
    return [];
}

function validateSerializedScope(value, expectedGroupRef, location) {
    const issues = [];
    for (const [, , , field, encodedIdentity] of value.matchAll(serializedScopeIdentityPattern)) {
        const expected = resolveScopeIdentity(expectedGroupRef, field);
        if (JSON.parse(encodedIdentity) !== expected) {
            issues.push(
                `${location} contains serialized ${field} ${encodedIdentity}; ` +
                    `expected ${JSON.stringify(expected)}`
            );
        }
    }
    return issues;
}

function resolveScopeTraversalRole(value, key, currentRole) {
    if (currentRole === WAIT_MATCH_ROLE && key === 'contains') {
        return WAIT_MATCH_ROLE;
    }
    if (currentRole === WAIT_MATCH_ROLE && key === 'payloadFields') {
        return WAIT_PAYLOAD_FIELDS_ROLE;
    }
    if (value.kind === 'parallel' && key === 'groups') {
        return PARALLEL_GROUPS_ROLE;
    }
    return value.kind === 'wait' && key === 'match' ? WAIT_MATCH_ROLE : SCOPE_ROLE;
}

function validateManifestScopeValue(value, expectedGroupRef, traversal) {
    const issues = [];

    if (Array.isArray(value)) {
        const itemRole = traversal.role === PARALLEL_GROUPS_ROLE ? PARALLEL_GROUP_ROLE : SCOPE_ROLE;
        value.forEach((entry, index) => {
            issues.push(
                ...validateManifestScopeValue(entry, expectedGroupRef, {
                    location: `${traversal.location}[${index}]`,
                    role: itemRole
                })
            );
        });
        return issues;
    }

    if (!value || typeof value !== 'object') {
        return issues;
    }

    for (const [key, entry] of Object.entries(value)) {
        const entryLocation = `${traversal.location}.${key}`;
        const isParallelGroupLabel = traversal.role === PARALLEL_GROUP_ROLE && key === 'groupId';
        const identityFieldName = toIdentityFieldName(key, traversal.role);
        issues.push(
            ...validateEmbeddedScope({
                value: entry,
                key,
                role: traversal.role,
                expectedGroupRef,
                location: entryLocation
            })
        );
        if (!isParallelGroupLabel && identityFieldNames.has(identityFieldName) && typeof entry === 'string') {
            const expected = resolveScopeIdentity(expectedGroupRef, identityFieldName);
            if (entry !== expected) {
                issues.push(
                    `${entryLocation} is ${JSON.stringify(entry)}; expected ${JSON.stringify(expected)}`
                );
            }
        }
        issues.push(
            ...validateManifestScopeValue(entry, expectedGroupRef, {
                location: entryLocation,
                role: resolveScopeTraversalRole(value, key, traversal.role)
            })
        );
    }

    return issues;
}

function toScopedRequestIdentity(value) {
    const marker = value.includes(':ensure-group:')
        ? ':ensure-group:'
        : value.includes(':ensure-member:')
        ? ':ensure-member:'
        : undefined;
    if (!marker) {
        return undefined;
    }
    const scopeStart = value.indexOf(marker) + marker.length;
    return { prefix: value.slice(0, scopeStart), segments: value.slice(scopeStart).split(':') };
}

function toEmbeddedScope(value, groupRefs, traversal) {
    const { sourceGroupRef, effectiveGroupRef } = groupRefs;
    const { key, role } = traversal;
    if (role === WAIT_MATCH_ROLE && key === 'contains') {
        return toSerializedScope(value, groupRefs);
    }
    if (key === 'path') {
        const pathScope = toStatePathScope(value);
        if (!pathScope) {
            return value;
        }
        const workspacePrefix = `/api/state/apps/${encodeURIComponent(effectiveGroupRef.applicationId)}` +
            `/workspaces/${encodeURIComponent(effectiveGroupRef.workspaceId)}`;
        const groupsSegment = pathScope.groupScoped ? '/groups' : '';
        const groupSegment = pathScope.groupId === undefined ? '' : `/${encodeURIComponent(effectiveGroupRef.groupId)}`;
        return `${workspacePrefix}${groupsSegment}${groupSegment}${value.slice(pathScope.prefix.length)}`;
    }
    if (key !== 'requestId' && key.toLowerCase() !== 'idempotency-key') {
        return value;
    }
    const request = toScopedRequestIdentity(value);
    if (!request) {
        return value;
    }
    const sourceIdentity = [sourceGroupRef.applicationId, sourceGroupRef.workspaceId, sourceGroupRef.groupId];
    if (!sourceIdentity.every((segment, index) => request.segments[index] === segment)) {
        return value;
    }
    const segments = [
        effectiveGroupRef.applicationId,
        effectiveGroupRef.workspaceId,
        effectiveGroupRef.groupId,
        ...request.segments.slice(3)
    ];
    return `${request.prefix}${segments.join(':')}`;
}

function resolveScopeIdentity(groupRef, field) {
    return groupRef[field === 'roomId' ? 'groupId' : field];
}

function toSerializedScope(value, groupRefs) {
    const { sourceGroupRef, effectiveGroupRef } = groupRefs;
    const fragments = [];
    let offset = 0;
    for (const match of value.matchAll(serializedScopeIdentityPattern)) {
        const [token, prefix, key, field, encodedIdentity] = match;
        const source = resolveScopeIdentity(sourceGroupRef, field);
        const effective = resolveScopeIdentity(effectiveGroupRef, field);
        const replacement = source !== effective && JSON.parse(encodedIdentity) === source
            ? `${prefix}${key}${JSON.stringify(effective)}`
            : token;
        fragments.push(value.slice(offset, match.index), replacement);
        offset = match.index + token.length;
    }
    fragments.push(value.slice(offset));
    return fragments.join('');
}

function toEffectiveScopeValue(value, groupRefs, traversal) {
    const { sourceGroupRef, effectiveGroupRef } = groupRefs;
    if (Array.isArray(value)) {
        const itemRole = traversal.role === PARALLEL_GROUPS_ROLE ? PARALLEL_GROUP_ROLE : SCOPE_ROLE;
        return value.map((entry) =>
            toEffectiveScopeValue(entry, groupRefs, {
                key: '',
                role: itemRole
            })
        );
    }

    if (!value || typeof value !== 'object') {
        if (typeof value !== 'string') {
            return value;
        }
        return toEmbeddedScope(value, groupRefs, traversal);
    }

    return Object.fromEntries(
        Object.entries(value).map(([entryKey, entry]) => {
            const isParallelGroupLabel = traversal.role === PARALLEL_GROUP_ROLE && entryKey === 'groupId';
            if (isParallelGroupLabel) {
                return [entryKey, entry];
            }
            const identityFieldName = toIdentityFieldName(entryKey, traversal.role);
            if (
                identityFieldNames.has(identityFieldName) &&
                entry === resolveScopeIdentity(sourceGroupRef, identityFieldName)
            ) {
                return [entryKey, resolveScopeIdentity(effectiveGroupRef, identityFieldName)];
            }
            return [
                entryKey,
                toEffectiveScopeValue(entry, groupRefs, {
                    key: entryKey,
                    role: resolveScopeTraversalRole(value, entryKey, traversal.role)
                })
            ];
        })
    );
}
