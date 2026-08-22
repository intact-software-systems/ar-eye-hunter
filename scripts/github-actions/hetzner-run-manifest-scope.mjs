const SCOPE_ROLE = 'scope';
const PARALLEL_GROUPS_ROLE = 'parallel-groups';
const PARALLEL_GROUP_ROLE = 'parallel-group';
const identityFieldNames = new Set(['applicationId', 'workspaceId', 'groupId', 'roomId']);

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
    const groupPathPattern = new RegExp(
        String.raw`^/api/state/apps/([^/]+)/workspaces/([^/]+)/groups` +
            String.raw`(?:/(?!requests(?:/|$))([^/]+))?(?:/|$)`
    );
    const match = value.match(groupPathPattern);
    if (!match) {
        return [`${location} has an unrecognized state group path ${JSON.stringify(value)}`];
    }

    const applicationId = decodePathSegment(match[1], location, issues);
    const workspaceId = decodePathSegment(match[2], location, issues);
    const groupId = match[3] === undefined ? undefined : decodePathSegment(match[3], location, issues);
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
    const marker = value.includes(':ensure-group:')
        ? ':ensure-group:'
        : value.includes(':ensure-member:')
        ? ':ensure-member:'
        : undefined;
    if (!marker) {
        return [];
    }

    const scope = value.slice(value.indexOf(marker) + marker.length).split(':');
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
    const { value, key, expectedGroupRef, location } = input;
    if (typeof value !== 'string') {
        return [];
    }
    if (key === 'path') {
        return validateEmbeddedPathScope(value, expectedGroupRef, location);
    }
    if (key === 'requestId' || key.toLowerCase() === 'idempotency-key') {
        return validateEmbeddedRequestScope(value, expectedGroupRef, location);
    }
    return [];
}

export function validateHetznerRunManifestScope(value, expectedGroupRef) {
    return validateManifestScopeValue(value, expectedGroupRef, {
        location: '$',
        role: SCOPE_ROLE
    });
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
        issues.push(
            ...validateEmbeddedScope({
                value: entry,
                key,
                expectedGroupRef,
                location: entryLocation
            })
        );
        if (!isParallelGroupLabel && identityFieldNames.has(key) && typeof entry === 'string') {
            const expected = key === 'applicationId'
                ? expectedGroupRef.applicationId
                : key === 'workspaceId'
                ? expectedGroupRef.workspaceId
                : expectedGroupRef.groupId;
            if (entry !== expected) {
                issues.push(
                    `${entryLocation} is ${JSON.stringify(entry)}; expected ${JSON.stringify(expected)}`
                );
            }
        }
        issues.push(
            ...validateManifestScopeValue(entry, expectedGroupRef, {
                location: entryLocation,
                role: value.kind === 'parallel' && key === 'groups' ? PARALLEL_GROUPS_ROLE : SCOPE_ROLE
            })
        );
    }

    return issues;
}

function toEmbeddedScope(value, groupRefs, key) {
    const { sourceGroupRef, effectiveGroupRef } = groupRefs;
    if (key === 'path') {
        const sourcePrefix = `/apps/${encodeURIComponent(sourceGroupRef.applicationId)}` +
            `/workspaces/${encodeURIComponent(sourceGroupRef.workspaceId)}/groups`;
        const effectivePrefix = `/apps/${encodeURIComponent(effectiveGroupRef.applicationId)}` +
            `/workspaces/${encodeURIComponent(effectiveGroupRef.workspaceId)}/groups`;
        return value
            .replaceAll(sourcePrefix, effectivePrefix)
            .replaceAll(
                `/${encodeURIComponent(sourceGroupRef.groupId)}`,
                `/${encodeURIComponent(effectiveGroupRef.groupId)}`
            );
    }

    const sourceRequestScope = `:${sourceGroupRef.applicationId}:` +
        `${sourceGroupRef.workspaceId}:${sourceGroupRef.groupId}:`;
    const effectiveRequestScope = `:${effectiveGroupRef.applicationId}:` +
        `${effectiveGroupRef.workspaceId}:${effectiveGroupRef.groupId}:`;
    return value
        .replaceAll(sourceRequestScope, effectiveRequestScope)
        .replaceAll(sourceGroupRef.groupId, effectiveGroupRef.groupId);
}

export function toEffectiveHetznerRunManifestScope(value, sourceGroupRef, effectiveGroupRef) {
    return toEffectiveScopeValue(
        value,
        { sourceGroupRef, effectiveGroupRef },
        { key: '', role: SCOPE_ROLE }
    );
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
        return toEmbeddedScope(value, groupRefs, traversal.key);
    }

    return Object.fromEntries(
        Object.entries(value).map(([entryKey, entry]) => {
            const isParallelGroupLabel = traversal.role === PARALLEL_GROUP_ROLE && entryKey === 'groupId';
            if (isParallelGroupLabel) {
                return [entryKey, entry];
            }
            if (entryKey === 'applicationId' && entry === sourceGroupRef.applicationId) {
                return [entryKey, effectiveGroupRef.applicationId];
            }
            if (entryKey === 'workspaceId' && entry === sourceGroupRef.workspaceId) {
                return [entryKey, effectiveGroupRef.workspaceId];
            }
            if ((entryKey === 'groupId' || entryKey === 'roomId') && entry === sourceGroupRef.groupId) {
                return [entryKey, effectiveGroupRef.groupId];
            }
            return [
                entryKey,
                toEffectiveScopeValue(entry, groupRefs, {
                    key: entryKey,
                    role: value.kind === 'parallel' && entryKey === 'groups' ? PARALLEL_GROUPS_ROLE : SCOPE_ROLE
                })
            ];
        })
    );
}
