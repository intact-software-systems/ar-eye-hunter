import { GraphAlgo } from '../complete-graph/complete-graph-types.ts';
import { PruneGraphAlgo } from './prune-graph.ts';

export type GenerateSizeInputDto = {
    members: number;
    steiner?: number;

    steinerMemberSize: number;
    steinerMemberRatio: number;

    degreeConstraint: number;
    degreeConstraintSP: number;

    simPruneAlgo: PruneGraphAlgo;
    simGraphAlgo: GraphAlgo;

    isSteinerAlgo: boolean;
};

export function generateSizeOfSteinerSet(
    input: GenerateSizeInputDto
): number {
    const {
        members,
        steinerMemberSize,
        steinerMemberRatio,
        degreeConstraint,
        degreeConstraintSP,
        simPruneAlgo,
        simGraphAlgo,
        isSteinerAlgo
    } = input;

    if (members <= 0) {
        return 0;
    }

    if (steinerMemberSize > 0) {
        return steinerMemberSize;
    }

    const usesSteinerSizing = isSteinerAlgo || simGraphAlgo !== GraphAlgo.COMPLETE_MEMBER_GRAPH;

    let numToAdd = 0;

    if (simPruneAlgo === PruneGraphAlgo.ADD_CORE_LINKS_OPTIMIZED) {
        if (usesSteinerSizing) {
            numToAdd = ceilDiv(members, degreeConstraintSP);
            numToAdd += ceilDiv(numToAdd + 2, degreeConstraintSP);
        }
        else {
            numToAdd = ceilDiv(members, degreeConstraint);
            numToAdd += ceilDiv(numToAdd + 2, degreeConstraint);
        }
    }
    else {
        if (steinerMemberRatio > 0 && usesSteinerSizing) {
            numToAdd = Math.floor(members * steinerMemberRatio);
        }
        else if (usesSteinerSizing) {
            numToAdd = ceilDiv(members, degreeConstraintSP);
            numToAdd += ceilDiv(numToAdd + 2, degreeConstraintSP);
        }
        else {
            numToAdd = ceilDiv(members, degreeConstraint);
            numToAdd += ceilDiv(numToAdd + 2, degreeConstraint);
        }
    }

    if (numToAdd <= 1) {
        numToAdd = 2;
    }

    return numToAdd;
}

export function generateRemainingSizeOfSteinerSet(
    input: GenerateSizeInputDto
): number {
    const alreadyHave = input.steiner ?? 0;
    return Math.max(generateSizeOfSteinerSet(input) - alreadyHave, 0);
}

export function generateSizeNonSteiner(
    input: Pick<GenerateSizeInputDto, 'members' | 'steinerMemberSize' | 'degreeConstraint'>
): number {
    const { members, steinerMemberSize, degreeConstraint } = input;

    if (members <= 0) {
        return 0;
    }

    if (steinerMemberSize > 0) {
        return steinerMemberSize;
    }

    let numToAdd = ceilDiv(members, degreeConstraint);
    numToAdd += ceilDiv((numToAdd * 2) + 2, degreeConstraint);

    return numToAdd;
}

function ceilDiv(numerator: number, denominator: number): number {
    if (denominator <= 0) {
        throw new Error(`ceilDiv requires denominator > 0, got ${denominator}`);
    }

    return Math.ceil(numerator / denominator);
}
