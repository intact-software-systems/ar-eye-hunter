import {
    ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES,
    createAdvancedLegacyHref,
} from './advanced-legacy-href.ts';
import {
    ADVANCED_SURFACE_CATALOG,
    type AdvancedSurface,
} from './advanced-surface-catalog.ts';
import type {
    AdvancedContextRow,
    AdvancedWorkspaceCategory,
    AdvancedWorkspaceModel,
    AdvancedWorkspaceProps,
    AdvancedWorkspaceSection,
} from './advanced-workspace-contract.ts';

const PROVIDERS = ['simulated', 'browser-rallar'] as const;
const SECTIONS = [
    {
        id: 'direct-diagnostics',
        title: 'Direct Diagnostics',
        description: 'Open focused auth, connectivity, realtime, data, and server evidence.',
    },
    {
        id: 'workflow-fallbacks',
        title: 'Preserved Workflow Fallbacks',
        description: 'Return to complete legacy runner workflows while their rollback paths remain supported.',
    },
    {
        id: 'advanced-legacy',
        title: 'Advanced Legacy',
        description: 'Open selected authoring, workbench, control, distributed, and shared-test tools.',
    },
] as const satisfies readonly Omit<AdvancedWorkspaceSection, 'links'>[];
const SELECTION_FIELDS = [
    ['controlRunId', 'Control run'],
    ['distributedRunId', 'Distributed run'],
    ['agentId', 'Agent'],
    ['recipeId', 'Recipe'],
    ['commandId', 'Command'],
    ['transport', 'Transport'],
] as const;

export function createAdvancedWorkspaceModel(
    input: AdvancedWorkspaceProps,
): AdvancedWorkspaceModel {
    const provider = providerRow(input.sourceSearch);
    const group = input.selection.groupContext.group;
    const source = new URLSearchParams();
    if (provider.status === 'ready' && provider.value) {
        source.set('provider', provider.value);
    }
    for (const field of ['applicationId', 'workspaceId', 'groupId'] as const) {
        const value = safeContextValue(group[field]);
        if (value) source.set(field, value);
    }

    const state = {
        ...input.urlState,
        controlRunId: input.selection.controlRunId ?? input.urlState.controlRunId,
        distributedRunId:
            input.selection.distributedRunId ?? input.urlState.distributedRunId,
        agentId: input.selection.agentId ?? input.urlState.agentId,
    };
    const links = ADVANCED_SURFACE_CATALOG.map(surface => {
        const href = createAdvancedLegacyHref({
            surface: surface.id,
            state,
            sourceSearch: source.toString(),
        });
        if (!href) throw new Error(`Missing Advanced href for ${surface.id}.`);
        return {
            category: categoryFor(surface),
            id: surface.id,
            label: surface.label,
            href,
            routeLabel: routeLabel(surface),
        };
    });
    const linkParams = links.map(link => new URLSearchParams(
        link.href.split('?')[1] ?? '',
    ));

    return {
        contextSourceLabel: contextSourceLabel(input.selection.groupContext.source),
        contextRows: [
            bridgeAware(provider, 'provider', linkParams),
            bridgeAware(
                groupRow('applicationId', 'Application', group.applicationId),
                'contextApplicationId',
                linkParams,
            ),
            bridgeAware(
                groupRow('workspaceId', 'Workspace', group.workspaceId),
                'contextWorkspaceId',
                linkParams,
            ),
            bridgeAware(
                groupRow('groupId', 'Group', group.groupId),
                'contextGroupId',
                linkParams,
            ),
            ...SELECTION_FIELDS.map(([field, label]) => bridgeAware(
                selectionRow(input, field, label, state[field]),
                field,
                linkParams,
            )),
        ],
        notices: uniqueNotices(input),
        sections: SECTIONS.map(section => ({
            ...section,
            links: links
                .filter(link => link.category === section.id)
                .map(({ category: _category, ...link }) => link),
        })),
    };
}

function categoryFor(surface: AdvancedSurface): AdvancedWorkspaceCategory {
    if (surface.id.startsWith('runner.')) return 'workflow-fallbacks';
    if (surface.id.startsWith('legacy.')) return 'advanced-legacy';
    return 'direct-diagnostics';
}

function providerRow(search: string): AdvancedContextRow {
    const values = new URLSearchParams(search).getAll('provider');
    if (values.length === 0) {
        return {
            field: 'provider',
            label: 'Provider',
            status: 'absent',
            message: 'Not set; links do not choose a provider.',
        };
    }
    const value = values.length === 1 ? values[0].trim() : undefined;
    if (!value || !(PROVIDERS as readonly string[]).includes(value)) {
        return {
            field: 'provider',
            label: 'Provider',
            status: 'invalid',
            message: 'Unsupported or duplicate provider omitted from links.',
        };
    }
    return { field: 'provider', label: 'Provider', status: 'ready', value };
}

function groupRow(field: string, label: string, value: string): AdvancedContextRow {
    const safe = safeContextValue(value);
    return safe
        ? { field, label, status: 'ready', value: safe }
        : {
            field,
            label,
            status: 'invalid',
            message: 'Invalid group context omitted from links.',
        };
}

function selectionRow(
    input: AdvancedWorkspaceProps,
    field: typeof SELECTION_FIELDS[number][0],
    label: string,
    value: string | undefined,
): AdvancedContextRow {
    const urlIssue = input.urlIssues.find(issue => issue.field === field);
    if (urlIssue?.code === 'invalid') {
        return { field, label, status: 'invalid', message: urlIssue.message };
    }
    const selectionIssue = input.selection.issues.find(issue => issue.field === field);
    const safe = safeContextValue(value);
    if (value !== undefined && safe === undefined) {
        return {
            field,
            label,
            status: 'invalid',
            message: 'Invalid value omitted from links.',
        };
    }
    if (selectionIssue) {
        return {
            field,
            label,
            status: 'unavailable',
            ...(safe ? { value: safe } : {}),
            message: selectionIssue.message,
        };
    }
    return safe
        ? { field, label, status: 'ready', value: safe }
        : { field, label, status: 'absent', message: 'Not selected.' };
}

function bridgeAware(
    row: AdvancedContextRow,
    bridgeField: string,
    linkParams: readonly URLSearchParams[],
): AdvancedContextRow {
    if (
        !row.value ||
        linkParams.every(params => params.get(bridgeField) === row.value)
    ) {
        return row;
    }
    const omissionMessage =
        'Valid context omitted from one or more links because the 4,096-byte query budget is full.';
    return {
        ...row,
        status: 'omitted',
        message: row.message
            ? `${row.message} ${omissionMessage}`
            : omissionMessage,
    };
}

function uniqueNotices(input: AdvancedWorkspaceProps): readonly string[] {
    const relevant = new Set<string>(SELECTION_FIELDS.map(([field]) => field));
    return [...new Set([
        ...input.selection.issues.map(issue => issue.message),
        ...input.urlIssues
            .filter(issue => relevant.has(issue.field))
            .map(issue => issue.message),
    ])];
}

function routeLabel(surface: AdvancedSurface): string {
    const workspace = surface.route.workspace === 'rallar'
        ? 'Rallar'
        : 'Black-box runner';
    return [workspace, surface.route.tab, 'advancedSurface' in surface.route
        ? surface.route.advancedSurface
        : undefined].filter(Boolean).join(' / ');
}

function contextSourceLabel(
    source: AdvancedWorkspaceProps['selection']['groupContext']['source'],
): string {
    if (source === 'selected-distributed-run') {
        return 'Selected distributed run context';
    }
    if (source === 'sole-active-distributed-run') {
        return 'Sole active distributed run context';
    }
    return 'Bootstrap group context';
}

function safeContextValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(normalized) &&
        new TextEncoder().encode(normalized).byteLength <=
            ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES
        ? normalized
        : undefined;
}
