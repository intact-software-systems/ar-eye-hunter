export interface ConnectionPreflight {
    readonly defined: readonly string[];
    readonly referenced: readonly string[];
    readonly missing: readonly string[];
}

export interface ConnectionSelection {
    readonly output: string;
    readonly connections: readonly string[];
}

export interface ConnectionPreflightStep {
    readonly connection: string | undefined;
    readonly writtenOutputs: readonly string[];
    readonly writesAllOutputs: boolean;
    readonly selection: ConnectionSelection | undefined;
    readonly groups: readonly (readonly ConnectionPreflightStep[])[];
}

interface ConnectionWalk {
    readonly outputs: Map<string, readonly string[]>;
    readonly uncertainOutputs: ReadonlySet<string>;
    readonly allOutputsUncertain: boolean;
    readonly referenced: Set<string>;
}

interface OutputWrites {
    readonly names: readonly string[];
    readonly anyOutput: boolean;
}

const RESERVED_ROOTS = new Set([
    'variables',
    'outputs',
    'results',
    'resultsList',
    'resultsByName',
    'runnerRunId',
    'correlation'
]);

export function toConnectionPreflight(
    definedConnectionNames: readonly string[],
    steps: readonly ConnectionPreflightStep[]
): ConnectionPreflight {
    const walk: ConnectionWalk = {
        outputs: new Map(),
        uncertainOutputs: new Set(),
        allOutputsUncertain: false,
        referenced: new Set()
    };
    collectConnectionReferences(steps, walk);
    const defined = [...new Set(definedConnectionNames)].sort();
    const definedSet = new Set(defined);
    const referenced = [...walk.referenced].sort();
    return { defined, referenced, missing: referenced.filter((name) => /[{}]/.test(name) || !definedSet.has(name)) };
}

function collectConnectionReferences(steps: readonly ConnectionPreflightStep[], walk: ConnectionWalk): void {
    for (const step of steps) {
        if (step.connection) {
            for (const connection of resolvePossibleConnections(step.connection, walk.outputs)) {
                walk.referenced.add(connection);
            }
        }
        collectParallelConnections(step.groups, walk);
        if (step.writesAllOutputs) {
            walk.outputs.clear();
        }
        for (const name of step.writtenOutputs) {
            walk.outputs.delete(name);
        }
        if (step.selection && !walk.allOutputsUncertain && !walk.uncertainOutputs.has(step.selection.output)) {
            walk.outputs.set(step.selection.output, step.selection.connections);
        }
    }
}

function collectParallelConnections(
    groups: readonly (readonly ConnectionPreflightStep[])[],
    walk: ConnectionWalk
): void {
    const groupWrites = groups.map(collectWrittenOutputs);
    groups.forEach((steps, index) => {
        const siblingWrites = groupWrites.filter((_writes, sibling) => sibling !== index);
        const uncertainOutputs = new Set([
            ...walk.uncertainOutputs,
            ...siblingWrites.flatMap((writes) => writes.names)
        ]);
        const allOutputsUncertain = walk.allOutputsUncertain || siblingWrites.some((writes) => writes.anyOutput);
        const outputs = new Map(allOutputsUncertain ? [] : walk.outputs);
        for (const name of uncertainOutputs) {
            outputs.delete(name);
        }
        collectConnectionReferences(steps, {
            outputs,
            uncertainOutputs,
            allOutputsUncertain,
            referenced: walk.referenced
        });
    });
    // All groups share runtime outputs. Their writes have no single known post-join owner.
    if (groupWrites.some((writes) => writes.anyOutput)) {
        walk.outputs.clear();
    }
    for (const name of groupWrites.flatMap((writes) => writes.names)) {
        walk.outputs.delete(name);
    }
}

function collectWrittenOutputs(steps: readonly ConnectionPreflightStep[]): OutputWrites {
    const nested = steps.flatMap((step) => step.groups.map(collectWrittenOutputs));
    return {
        names: [
            ...new Set([...steps.flatMap((step) => step.writtenOutputs), ...nested.flatMap((writes) => writes.names)])
        ],
        anyOutput: steps.some((step) => step.writesAllOutputs) || nested.some((writes) => writes.anyOutput)
    };
}

function resolvePossibleConnections(
    connection: string,
    outputs: ReadonlyMap<string, readonly string[]>
): readonly string[] {
    const placeholder = /^\{([A-Za-z_][A-Za-z0-9_-]*)\.connection\}$/.exec(connection);
    if (!placeholder || RESERVED_ROOTS.has(placeholder[1])) {
        return [connection];
    }
    return outputs.get(placeholder[1]) ?? [connection];
}
