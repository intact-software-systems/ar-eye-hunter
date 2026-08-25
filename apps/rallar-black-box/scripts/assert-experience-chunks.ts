import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ManifestChunk {
    readonly file: string;
    readonly src?: string;
    readonly isEntry?: boolean;
    readonly isDynamicEntry?: boolean;
    readonly imports?: readonly string[];
    readonly dynamicImports?: readonly string[];
    readonly css?: readonly string[];
}

type Manifest = Readonly<Record<string, ManifestChunk>>;

const workbenchSafeDynamicEntrySources = {
    RunnerRecipesPanel: '/legacy/runner/recipes/RunnerRecipesPanel.tsx',
    RunnerRunsPanel: '/legacy/runner/runs/RunnerRunsPanel.tsx',
    RunnerFleetPanel: '/legacy/runner/fleet/RunnerFleetPanel.tsx',
    FlowBuilderPanel: '/legacy/runner/builder/FlowBuilderPanel.tsx',
    DistributedRecipesPanel: '/legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx',
    RunManagerPanel: '/legacy/runner/run-manager/RunManagerPanel.tsx',
    SharedTestPanel: '/legacy/runner/shared-test/SharedTestPanel.tsx',
    RoomsClientsPanel: '/legacy/diagnostics/rooms-clients/RoomsClientsPanel.tsx',
    TopologyGraphPanel: '/legacy/diagnostics/topology/TopologyGraphPanel.tsx',
    RtcDiagnosticsPanel: '/legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx'
} as const;

type WorkbenchSafeDynamicEntry = keyof typeof workbenchSafeDynamicEntrySources;

export interface ExperienceChunkGraph {
    readonly main: string;
    readonly mainStaticClosure: ReadonlySet<string>;
    readonly mainDynamicEntries: ReadonlySet<string>;
    readonly mainDynamicExperienceEntries: ReadonlySet<string>;
    readonly recipeConsoleStaticClosure: ReadonlySet<string>;
    readonly workbenchStaticClosure: ReadonlySet<string>;
    readonly workbenchDynamicClosure: ReadonlySet<string>;
    readonly workbenchSafeDynamicEntries: ReadonlyMap<WorkbenchSafeDynamicEntry, string>;
    readonly retentionDynamicEntry: string;
    readonly retentionStaticClosure: ReadonlySet<string>;
    readonly tuneStaticClosure: ReadonlySet<string>;
    readonly productionEntries: ReadonlySet<string>;
    readonly productionClosure: ReadonlySet<string>;
}

interface GraphMetadata {
    readonly manifest: Manifest;
    readonly outputRoot: string;
    readonly recipeConsole: string;
    readonly workbench: string;
    readonly retention: string;
    readonly tune: string;
}

interface ExperienceEntries {
    readonly main: string;
    readonly recipeConsole: string;
    readonly workbench: string;
    readonly retention: string;
    readonly tune: string;
}

const graphMetadata = new WeakMap<ExperienceChunkGraph, GraphMetadata>();

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function findEntry(
    manifest: Manifest,
    predicate: (chunk: ManifestChunk) => boolean,
    message: string
): readonly [string, ManifestChunk] {
    const entry = Object.entries(manifest).find(([, chunk]) => predicate(chunk));
    assert(entry, message);
    return entry;
}

function closure(
    manifest: Manifest,
    root: string,
    includeDynamicImports: boolean
): ReadonlySet<string> {
    const visited = new Set<string>();
    const visit = (key: string): void => {
        if (visited.has(key)) {
            return;
        }
        const chunk = manifest[key];
        assert(chunk, `Manifest closure references missing chunk: ${key}`);
        visited.add(key);
        for (const dependency of chunk.imports ?? []) {
            visit(dependency);
        }
        if (includeDynamicImports) {
            for (const dependency of chunk.dynamicImports ?? []) {
                visit(dependency);
            }
        }
    };
    visit(root);
    return visited;
}

function closureText(
    manifest: Manifest,
    outputRoot: string,
    keys: ReadonlySet<string>
): string {
    return [...keys].map((key) => {
        const chunk = manifest[key];
        if (!chunk) {
            return '';
        }
        return [chunk.file, ...(chunk.css ?? [])]
            .map((file) => readFileSync(resolve(outputRoot, file), 'utf8'))
            .join('\n');
    }).join('\n');
}

function javascriptClosureText(
    manifest: Manifest,
    outputRoot: string,
    keys: ReadonlySet<string>
): string {
    return [...keys].map((key) => {
        const file = manifest[key]?.file;
        return file ? readFileSync(resolve(outputRoot, file), 'utf8') : '';
    }).join('\n');
}

function cssClosure(
    manifest: Manifest,
    keys: ReadonlySet<string>,
    excludedKeys: ReadonlySet<string> = new Set()
): ReadonlySet<string> {
    const files = new Set<string>();
    for (const key of keys) {
        if (excludedKeys.has(key)) {
            continue;
        }
        for (const file of manifest[key]?.css ?? []) {
            files.add(file);
        }
    }
    return files;
}

export function readExperienceChunkGraph(
    manifestPath: string
): ExperienceChunkGraph {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const entries = readExperienceEntries(manifest);
    const workbenchSafeDynamicEntries = readWorkbenchSafeDynamicEntries(manifest);
    const mainDynamicEntries = new Set(manifest[entries.main]?.dynamicImports ?? []);
    const experienceEntries = new Set(
        [...mainDynamicEntries].filter(
            (key) => key === entries.recipeConsole || key === entries.workbench
        )
    );
    const graph: ExperienceChunkGraph = {
        main: entries.main,
        mainStaticClosure: closure(manifest, entries.main, false),
        mainDynamicEntries,
        mainDynamicExperienceEntries: experienceEntries,
        recipeConsoleStaticClosure: closure(manifest, entries.recipeConsole, false),
        workbenchStaticClosure: closure(manifest, entries.workbench, false),
        workbenchDynamicClosure: closure(manifest, entries.workbench, true),
        workbenchSafeDynamicEntries,
        retentionDynamicEntry: entries.retention,
        retentionStaticClosure: closure(manifest, entries.retention, false),
        tuneStaticClosure: closure(manifest, entries.tune, false),
        productionEntries: new Set(
            Object.entries(manifest)
                .filter(([, chunk]) => chunk.isEntry === true || chunk.isDynamicEntry === true)
                .map(([key]) => key)
        ),
        productionClosure: closure(manifest, entries.main, true)
    };
    graphMetadata.set(graph, {
        manifest,
        outputRoot: resolve(dirname(manifestPath), '..'),
        ...entries
    });
    return graph;
}

function readExperienceEntries(manifest: Manifest): ExperienceEntries {
    const [main] = findEntry(
        manifest,
        (chunk) => chunk.isEntry === true,
        'Vite manifest must expose the main entry.'
    );
    const [recipeConsole] = findEntry(
        manifest,
        (chunk) => chunk.src?.endsWith('/recipe-console/app/RecipeConsoleApp.tsx') === true,
        'Vite manifest must expose RecipeConsoleApp as a dynamic entry.'
    );
    const [workbench] = findEntry(
        manifest,
        (chunk) => chunk.src?.endsWith('/workbench/workbench-experience.tsx') === true,
        'Vite manifest must expose WorkbenchExperience as a dynamic entry.'
    );
    const [retention] = findEntry(
        manifest,
        (chunk) =>
            chunk.src?.endsWith(
                '/recipe-console/control/control-retention-api.ts'
            ) === true,
        'Vite manifest must expose the retention client as a dynamic entry.'
    );
    const [tune] = findEntry(
        manifest,
        (chunk) => chunk.src?.endsWith('/recipe-console/tune/TuneWorkspace.tsx') === true,
        'Vite manifest must expose TuneWorkspace as a dynamic entry.'
    );
    return { main, recipeConsole, workbench, retention, tune };
}

function readWorkbenchSafeDynamicEntries(
    manifest: Manifest
): ReadonlyMap<WorkbenchSafeDynamicEntry, string> {
    const workbenchSafeDynamicEntries = new Map<WorkbenchSafeDynamicEntry, string>();
    for (
        const [label, sourceSuffix] of Object.entries(
            workbenchSafeDynamicEntrySources
        ) as [WorkbenchSafeDynamicEntry, string][]
    ) {
        const [entry] = findEntry(
            manifest,
            (chunk) => chunk.src?.endsWith(sourceSuffix) === true,
            `Vite manifest must expose ${label} as a dynamic entry.`
        );
        workbenchSafeDynamicEntries.set(label, entry);
    }
    return workbenchSafeDynamicEntries;
}

export function assertExperienceChunkGraph(graph: ExperienceChunkGraph): void {
    const metadata = graphMetadata.get(graph);
    assert(metadata, 'Chunk graph must originate from readExperienceChunkGraph().');
    assertExperienceEntries(graph, metadata);
    assertWorkbenchDynamicEntries(graph, metadata);
    assertProductionReachability(graph, metadata);
    assertExperienceCssIsolation(graph, metadata);
    const texts = readExperienceClosureTexts(graph, metadata);
    assertExperienceContentIsolation(texts);
    assertWorkbenchStatefulContent(texts);
    assertHistoryAndRetentionContent(texts);
}

function assertExperienceEntries(graph: ExperienceChunkGraph, metadata: GraphMetadata): void {
    const { manifest, recipeConsole, workbench, retention, tune } = metadata;
    assert(recipeConsole !== workbench, 'The two experiences must use different entries.');
    assert(
        manifest[recipeConsole]?.file !== manifest[workbench]?.file,
        'The two experiences must use different files.'
    );
    assert(graph.mainStaticClosure.size > 1, 'Main static closure must contain dependencies.');
    assert(!graph.mainStaticClosure.has(recipeConsole), 'Recipe Console is in the main static closure.');
    assert(!graph.mainStaticClosure.has(workbench), 'WorkbenchExperience is in the main static closure.');
    assert(
        graph.mainDynamicEntries.size > graph.mainDynamicExperienceEntries.size,
        'Unrelated runtime/auth dynamic entries must remain allowed and observable.'
    );
    assert(
        graph.mainDynamicExperienceEntries.size === 2 &&
            graph.mainDynamicExperienceEntries.has(recipeConsole) &&
            graph.mainDynamicExperienceEntries.has(workbench),
        'Main must have exactly the two filtered experience dynamic entries.'
    );
    assert(graph.recipeConsoleStaticClosure.size > 1, 'Recipe Console static closure must be nonempty.');
    assert(graph.workbenchStaticClosure.size > 1, 'Workbench static closure must be nonempty.');
    assert(
        !graph.recipeConsoleStaticClosure.has(workbench),
        'Recipe Console static closure includes WorkbenchExperience.'
    );
    assert(
        manifest[recipeConsole]?.dynamicImports?.includes(retention),
        'Recipe Console must dynamically import the retention client.'
    );
    assert(
        manifest[recipeConsole]?.dynamicImports?.includes(tune),
        'Recipe Console must dynamically import TuneWorkspace.'
    );
    assert(!graph.recipeConsoleStaticClosure.has(retention), 'Recipe Console includes retention statically.');
    assert(!graph.tuneStaticClosure.has(retention), 'Inactive Tune includes retention statically.');
}

function assertWorkbenchDynamicEntries(graph: ExperienceChunkGraph, metadata: GraphMetadata): void {
    for (const [label, entry] of graph.workbenchSafeDynamicEntries) {
        assert(
            metadata.manifest[entry]?.isDynamicEntry === true,
            `Workbench safe entry ${label} is not a Vite dynamic entry.`
        );
        assert(
            graph.productionClosure.has(entry),
            `Workbench safe dynamic entry ${label} is not production-reachable.`
        );
        assert(
            graph.workbenchDynamicClosure.has(entry),
            `Workbench safe dynamic entry ${label} is not reachable from WorkbenchExperience.`
        );
        assert(
            !graph.mainStaticClosure.has(entry),
            `Main static closure includes safe workbench entry ${label}.`
        );
        assert(
            !graph.workbenchStaticClosure.has(entry),
            `Workbench static closure includes safe workbench entry ${label}.`
        );
        assert(
            !graph.recipeConsoleStaticClosure.has(entry),
            `Recipe Console static closure includes safe workbench entry ${label}.`
        );
    }
}

function assertProductionReachability(graph: ExperienceChunkGraph, metadata: GraphMetadata): void {
    assert(
        graph.productionClosure.has(graph.main) &&
            graph.productionClosure.has(metadata.recipeConsole) &&
            graph.productionClosure.has(metadata.workbench),
        'Production closure must reach the main entry and both experiences.'
    );
    for (const entry of graph.productionEntries) {
        assert(
            graph.productionClosure.has(entry),
            `Production entry is unreachable from the main entry: ${entry}`
        );
    }
    assert(
        ![...graph.productionClosure].some((key) => key.includes('recipe-console-css-isolation')),
        'Production closure includes a CSS isolation fixture entry.'
    );
}

function assertExperienceCssIsolation(graph: ExperienceChunkGraph, metadata: GraphMetadata): void {
    const mainCss = cssClosure(metadata.manifest, graph.mainStaticClosure);
    const recipeCss = cssClosure(metadata.manifest, graph.recipeConsoleStaticClosure);
    const workbenchCss = cssClosure(
        metadata.manifest,
        graph.workbenchStaticClosure,
        graph.mainStaticClosure
    );
    assert(workbenchCss.size > 0, 'Workbench experience must emit a nonempty CSS closure.');
    for (const file of workbenchCss) {
        assert(!mainCss.has(file), `Main static closure includes workbench CSS: ${file}`);
        assert(!recipeCss.has(file), `Recipe Console static closure includes workbench CSS: ${file}`);
    }
}

interface ExperienceClosureTexts {
    readonly main: string;
    readonly recipeConsole: string;
    readonly workbench: string;
    readonly workbenchJavaScript: string;
    readonly tune: string;
    readonly retention: string;
}

function readExperienceClosureTexts(
    graph: ExperienceChunkGraph,
    metadata: GraphMetadata
): ExperienceClosureTexts {
    return {
        main: closureText(metadata.manifest, metadata.outputRoot, graph.mainStaticClosure),
        recipeConsole: closureText(metadata.manifest, metadata.outputRoot, graph.recipeConsoleStaticClosure),
        workbench: closureText(metadata.manifest, metadata.outputRoot, graph.workbenchStaticClosure),
        workbenchJavaScript: javascriptClosureText(
            metadata.manifest,
            metadata.outputRoot,
            graph.workbenchStaticClosure
        ),
        tune: closureText(metadata.manifest, metadata.outputRoot, graph.tuneStaticClosure),
        retention: closureText(metadata.manifest, metadata.outputRoot, graph.retentionStaticClosure)
    };
}

function assertExperienceContentIsolation(texts: ExperienceClosureTexts): void {
    assert(
        texts.recipeConsole.includes('data-command-bar'),
        'Recipe Console static closure sentinel is missing.'
    );
    assert(!texts.main.includes('data-command-bar'), 'Main static closure contains Recipe Console UI.');
    assert(!texts.workbench.includes('data-command-bar'), 'Workbench static closure contains Recipe Console UI.');
    assert(!texts.main.includes('app-shell'), 'Main static closure contains workbench shell UI.');
    assert(!texts.recipeConsole.includes('app-shell'), 'Recipe Console contains workbench shell UI.');
    assert(!texts.recipeConsole.includes('panel-media'), 'Recipe Console contains workbench media UI.');
    assert(!texts.recipeConsole.includes('panel-rallar-server'), 'Recipe Console contains workbench server UI.');
    assert(texts.workbench.includes('app-shell'), 'Workbench static closure does not contain its shell.');
    assert(texts.workbench.includes('panel-media'), 'Workbench static closure does not contain panel-media.');
    assert(texts.workbench.includes('panel-rallar-server'), 'Workbench static closure lacks panel-rallar-server.');
}

function assertWorkbenchStatefulContent(texts: ExperienceClosureTexts): void {
    for (
        const [label, sentinel] of [
            ['Quick Rallar Test', 'quick-rallar-test-panel'],
            ['Auth command center', 'auth-command-center-panel'],
            ['WebSocket command center', 'websocket-command-center-panel'],
            ['RTC realtime', 'rtc-realtime-panel'],
            ['Rallar Data', 'rallar-data-panel'],
            ['CRDT', 'crdt-health-panel'],
            ['Media', 'media-console-panel'],
            ['Local Workbench', 'workbench-panel'],
            ['Manual Rallar', 'manual-rallar-panel'],
            ['Rallar Trace', 'rallar-trace-panel'],
            ['Event Stream', 'event-panel'],
            ['Rallar Server', 'rallar-server-panel']
        ] as const
    ) {
        assert(
            texts.workbenchJavaScript.includes(sentinel),
            `Workbench static closure is missing the ${label} stateful diagnostic.`
        );
        assert(
            !texts.main.includes(sentinel) && !texts.recipeConsole.includes(sentinel),
            `Cold Recipe Console includes the ${label} stateful workbench diagnostic.`
        );
    }
}

function assertHistoryAndRetentionContent(texts: ExperienceClosureTexts): void {
    assert(
        texts.tune.includes('data-history-workspace') &&
            texts.tune.includes('data-retention-panel'),
        'Tune static closure History sentinels are missing.'
    );
    for (
        const [label, text] of [
            ['main', texts.main],
            ['Recipe Console', texts.recipeConsole],
            ['Workbench', texts.workbench]
        ] as const
    ) {
        assert(
            !text.includes('data-history-workspace') &&
                !text.includes('data-retention-panel'),
            `${label} static closure contains inactive History UI.`
        );
    }
    for (
        const [label, text] of [
            ['main', texts.main],
            ['Recipe Console', texts.recipeConsole],
            ['Tune', texts.tune]
        ] as const
    ) {
        assert(
            !text.includes('retention/cleanup') &&
                !text.includes('preview.deletedRunIds'),
            `${label} static closure contains lazy retention implementation.`
        );
    }
    assert(
        texts.retention.includes('retention/cleanup') &&
            texts.retention.includes('preview.deletedRunIds'),
        'Retention dynamic closure sentinels are missing.'
    );
}

function runCli(): void {
    const outputRoot = resolve(process.argv[2] ?? 'apps/rallar-black-box/dist');
    const graph = readExperienceChunkGraph(resolve(outputRoot, '.vite/manifest.json'));
    assertExperienceChunkGraph(graph);
    const metadata = graphMetadata.get(graph);
    assert(metadata, 'Chunk graph metadata is unavailable after assertion.');
    console.log(
        `experience chunks ok: ${manifestFile(metadata.manifest, metadata.recipeConsole)} | ${
            manifestFile(metadata.manifest, metadata.workbench)
        }`
    );
}

function manifestFile(manifest: Manifest, key: string): string {
    const file = manifest[key]?.file;
    assert(file, `Manifest chunk ${key} does not expose a file.`);
    return file;
}

const entryUrl = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : undefined;
if (entryUrl === import.meta.url) {
    runCli();
}
