import { VertexId, WeightedGraph } from '../graph-props.ts';

export type DynamicTreeAlgo =
    | 'NO_DYNAMIC_TREE_ALGO'
    | 'REMOVE_TRY_REPLACE_MDDL_NAIVE'
    | 'REMOVE_TRY_REPLACE_PRUNE_MDDL'
    | 'REMOVE_TRY_REPLACE_PRUNE_MC'
    | 'REMOVE_TRY_REPLACE_PRUNE_SEARCH_MDDL'
    | 'REMOVE_TRY_REPLACE_PRUNE_SEARCH_MC'
    | 'REMOVE_MINIMUM_DIAMETER_EDGE'
    | 'REMOVE_SEARCH_MINIMUM_DIAMETER_EDGE'
    | 'REMOVE_MINIMUM_COST_EDGE'
    | 'REMOVE_SEARCH_MINIMUM_COST_EDGE'
    | 'REMOVE_DC_MINIMUM_COST_EDGE'
    | 'REMOVE_BR_MINIMUM_COST_EDGE'
    | 'REMOVE_BD_MINIMUM_COST_EDGE'
    | 'REMOVE_DC_SEARCH_MINIMUM_COST_EDGE'
    | 'REMOVE_BR_SEARCH_MINIMUM_COST_EDGE'
    | 'REMOVE_BD_SEARCH_MINIMUM_COST_EDGE'
    | 'REMOVE_DC_MINIMUM_DIAMETER_EDGE'
    | 'REMOVE_BR_MINIMUM_DIAMETER_EDGE'
    | 'REMOVE_BD_MINIMUM_DIAMETER_EDGE'
    | 'REMOVE_DC_SEARCH_MINIMUM_DIAMETER_EDGE'
    | 'REMOVE_BR_SEARCH_MINIMUM_DIAMETER_EDGE'
    | 'REMOVE_BD_SEARCH_MINIMUM_DIAMETER_EDGE';

export type RemoveDynamicsContext = {
    globalGraph: WeightedGraph;
    groupGraph: WeightedGraph;
    actionVertexId: VertexId;
    treeAlgo: DynamicTreeAlgo;
    steinerCandidates: ReadonlySet<VertexId>;
};

export type RemoveResult = {
    graph: WeightedGraph;
    changed: boolean;
};
