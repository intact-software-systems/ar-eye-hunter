import type { RelicActionInput, RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import { roomClueHotspot } from './prompts.ts';

export type SceneObjectiveTone = 'neutral' | 'mystery' | 'success' | 'danger';

export type SceneObjective = Readonly<{
    eyebrow: string;
    title: string;
    detail: string;
    tone: SceneObjectiveTone;
    roomId?: string;
    recommendedAction?: RelicActionInput;
    targetRoomId?: string;
    revealedRoomId?: string;
    routeTargetRoomId?: string;
    clueHotspotId?: string;
    investigationSummary?: string;
    investigationHint?: string;
    danger?: string;
    investigated: boolean;
    urgent: boolean;
}>;

export function deriveSceneObjective({
    snapshot,
    localPlayerId,
    primedAction,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    primedAction?: RelicActionInput;
}>): SceneObjective {
    if (!snapshot) {
        return objective({
            eyebrow: 'Expedition',
            title: 'Enter the castle',
            detail: 'Create or join a room to begin the expedition.',
            tone: 'neutral',
        });
    }

    const player = snapshot.players.find((candidate) => candidate.playerId === localPlayerId);
    if (!player) {
        return objective({
            eyebrow: 'Expedition',
            title: 'Join the party',
            detail: 'Choose a hunter before the castle starts falling apart.',
            tone: 'neutral',
        });
    }

    const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
    if (snapshot.phase === 'finished') {
        return objective({
            eyebrow: 'Finished',
            title: snapshot.winnerIds.includes(player.playerId)
                ? 'You claimed the Heart Relic'
                : 'The expedition is over',
            detail: 'Scores are final. The ruin has gone quiet.',
            tone: snapshot.winnerIds.includes(player.playerId) ? 'success' : 'neutral',
            roomId: room?.id,
        });
    }

    if (snapshot.phase === 'lobby') {
        return objective({
            eyebrow: 'Lobby',
            title: 'Gather the hunters',
            detail: 'Start the expedition when the party is ready.',
            tone: 'neutral',
            roomId: room?.id,
        });
    }

    if (!room) {
        return objective({
            eyebrow: 'Lost',
            title: 'Find your footing',
            detail: 'The castle map has not caught up with your hunter.',
            tone: 'danger',
        });
    }

    const investigation = roomInvestigation(snapshot, room.id);
    const investigated = !!investigation || roomHasResolvedClue(snapshot, room.id);

    if (player.escaped) {
        return objective({
            eyebrow: room.name,
            title: 'You are outside the ruin',
            detail: 'Watch the others decide whether to risk one more room.',
            tone: 'success',
            roomId: room.id,
        });
    }

    if (player.defeated) {
        return objective({
            eyebrow: room.name,
            title: 'You are down',
            detail: 'The castle keeps your relics unless the expedition still turns.',
            tone: 'danger',
            roomId: room.id,
            urgent: true,
        });
    }

    if (snapshot.submittedPlayerIds.includes(player.playerId)) {
        const waiting = activePlayerCount(snapshot) - snapshot.submittedPlayerIds.length;
        return objective({
            eyebrow: room.name,
            title: 'Plan locked',
            detail: investigation?.summary ?? (waiting > 0
                ? `Waiting for ${waiting} hunter${waiting === 1 ? '' : 's'} to choose.`
                : 'All plans are locked. The castle is about to answer.'),
            tone: 'success',
            roomId: room.id,
            investigated,
            investigationSummary: investigation?.summary,
            investigationHint: investigation?.hint,
            danger: investigation?.danger,
        });
    }

    if (primedAction?.kind === 'move' && primedAction.targetRoomId) {
        const target = snapshot.map.find((candidate) => candidate.id === primedAction.targetRoomId);
        return objective({
            eyebrow: room.name,
            title: target ? `Move to ${target.name}` : 'Move is primed',
            detail: investigation?.hint ?? 'Submit the plan to commit this turn-based move.',
            tone: room.unstable ? 'danger' : 'neutral',
            roomId: room.id,
            recommendedAction: primedAction,
            targetRoomId: primedAction.targetRoomId,
            investigated,
            investigationSummary: investigation?.summary,
            investigationHint: investigation?.hint,
            danger: investigation?.danger,
            urgent: !!room.unstable,
        });
    }

    if (primedAction?.kind === 'search') {
        const clue = roomClueHotspot(room);
        return objective({
            eyebrow: room.name,
            title: clue.label,
            detail: investigation?.hint ?? 'Submit the plan to search this room.',
            tone: room.unstable || investigation?.danger ? 'danger' : 'mystery',
            roomId: room.id,
            recommendedAction: { kind: 'search' },
            clueHotspotId: clue.id,
            investigated,
            investigationSummary: investigation?.summary,
            investigationHint: investigation?.hint,
            danger: investigation?.danger,
            urgent: !!room.unstable || !!investigation?.danger,
        });
    }

    if (primedAction?.kind === 'escape') {
        return objective({
            eyebrow: room.name,
            title: 'Escape is primed',
            detail: 'Submit the plan to leave the castle with your safe score.',
            tone: 'success',
            roomId: room.id,
            recommendedAction: { kind: 'escape' },
            investigated,
            investigationSummary: investigation?.summary,
            investigationHint: investigation?.hint,
            danger: investigation?.danger,
        });
    }

    if (room.kind === 'exit') {
        return objective({
            eyebrow: room.name,
            title: player.relicIds.length > 0
                ? 'Escape with your relics'
                : 'Escape is available',
            detail: player.relicIds.length > 0
                ? 'Prime Escape to bank your relics before the castle closes.'
                : 'You can leave safely now, or risk another room for relics.',
            tone: 'success',
            roomId: room.id,
            recommendedAction: { kind: 'escape' },
            investigated,
            investigationSummary: investigation?.summary,
            investigationHint: investigation?.hint,
            danger: investigation?.danger,
            urgent: roundsLeft(snapshot) <= 2,
        });
    }

    const hiddenRelic = !investigated && roomHasHiddenRelic(snapshot, room.id);
    const clue = roomClueHotspot(room);
    if (!investigated && (hiddenRelic || shouldSearchRoom(room))) {
        return objective({
            eyebrow: room.name,
            title: clue.label,
            detail: hiddenRelic
                ? roomSearchDetail(room)
                : 'Search if the party needs one more lead before moving on.',
            tone: room.unstable ? 'danger' : 'mystery',
            roomId: room.id,
            recommendedAction: { kind: 'search' },
            clueHotspotId: clue.id,
            investigated,
            urgent: !!room.unstable,
        });
    }

    const route = recommendedMoveRoute(
        snapshot,
        room,
        player.relicIds.length > 0,
        investigation?.revealedRoomId,
    );
    if (route) {
        const clueRoute = route.source === 'revealed' && investigation;
        return objective({
            eyebrow: room.name,
            title: clueRoute
                ? clueRouteTitle(investigation, route.target)
                : `Move to ${route.next.name}`,
            detail: clueRoute
                ? `Next step: Move to ${route.next.name}. ${investigation.hint}`
                : investigation?.hint ?? (player.relicIds.length > 0
                ? 'Carry your relics toward the Exit before the ruin closes.'
                : 'Push deeper toward rooms with better relic odds.'),
            tone: room.unstable || investigation?.danger ? 'danger' : 'neutral',
            roomId: room.id,
            recommendedAction: { kind: 'move', targetRoomId: route.next.id },
            targetRoomId: route.next.id,
            revealedRoomId: investigation?.revealedRoomId,
            routeTargetRoomId: route.target.id,
            investigated,
            investigationSummary: investigation?.summary,
            investigationHint: investigation?.hint,
            danger: investigation?.danger,
            urgent: !!room.unstable || !!investigation?.danger,
        });
    }

    return objective({
        eyebrow: room.name,
        title: 'Hold your ground',
        detail: 'No open path is obvious from here. Choose the least risky plan.',
        tone: 'danger',
        roomId: room.id,
        investigated,
        investigationSummary: investigation?.summary,
        investigationHint: investigation?.hint,
        danger: investigation?.danger,
        urgent: true,
    });
}

export function roomHasResolvedClue(
    snapshot: RelicPublicSnapshot,
    roomId: string,
): boolean {
    if (snapshot.roomInvestigations?.some((investigation) =>
        investigation.roomId === roomId
    )) {
        return true;
    }

    return snapshot.relics.some((relic) =>
        relic.roomId === roomId && (!!relic.foundBy || !!relic.carriedBy || !!relic.escapedBy)
    );
}

export function shortestOpenRoomPath(
    rooms: readonly RelicRoom[],
    fromRoomId: string,
    toRoomId: string,
): readonly string[] | undefined {
    const roomById = new Map(rooms.map((room) => [room.id, room]));
    const start = roomById.get(fromRoomId);
    const target = roomById.get(toRoomId);
    if (!start || !target || target.collapsed) {
        return undefined;
    }
    if (fromRoomId === toRoomId) {
        return [fromRoomId];
    }

    const visited = new Set<string>([fromRoomId]);
    const queue: Array<readonly string[]> = [[fromRoomId]];
    while (queue.length > 0) {
        const path = queue.shift()!;
        const currentId = path[path.length - 1];
        const current = roomById.get(currentId);
        if (!current) {
            continue;
        }

        for (const neighborId of current.neighbors) {
            if (visited.has(neighborId)) {
                continue;
            }

            const neighbor = roomById.get(neighborId);
            if (!neighbor || neighbor.collapsed) {
                continue;
            }

            const nextPath = [...path, neighborId];
            if (neighborId === toRoomId) {
                return nextPath;
            }

            visited.add(neighborId);
            queue.push(nextPath);
        }
    }

    return undefined;
}

function roomInvestigation(
    snapshot: RelicPublicSnapshot,
    roomId: string,
): RelicPublicSnapshot['roomInvestigations'][number] | undefined {
    return snapshot.roomInvestigations?.find((investigation) =>
        investigation.roomId === roomId
    );
}

function objective(values: Omit<SceneObjective, 'investigated' | 'urgent'> & Partial<Pick<
    SceneObjective,
    'investigated' | 'urgent'
>>): SceneObjective {
    return {
        investigated: false,
        urgent: false,
        ...values,
    };
}

function roomHasHiddenRelic(
    snapshot: RelicPublicSnapshot,
    roomId: string,
): boolean {
    return snapshot.relics.some((relic) =>
        relic.roomId === roomId && !relic.foundBy && !relic.carriedBy && !relic.escapedBy
    );
}

function shouldSearchRoom(room: RelicRoom): boolean {
    return room.kind === 'storage' ||
        room.kind === 'shrine' ||
        room.kind === 'trap' ||
        room.kind === 'treasure' ||
        room.kind === 'monster';
}

function roomSearchDetail(room: RelicRoom): string {
    switch (room.kind) {
        case 'storage':
            return 'The crates and torn map may hide a relic lead.';
        case 'shrine':
            return 'The altar runes look like the heart of this room.';
        case 'trap':
            return 'Study the plates before noise turns into damage.';
        case 'treasure':
            return 'The chest, coins, and mirror all point to a prize.';
        case 'monster':
            return 'The chains and ash hide danger, but also the richest clues.';
        default:
            return 'Inspect the strongest clue in this room.';
    }
}

type RecommendedMoveRoute = Readonly<{
    next: RelicRoom;
    target: RelicRoom;
    source: 'exit' | 'revealed' | 'relic' | 'fallback';
}>;

function recommendedMoveRoute(
    snapshot: RelicPublicSnapshot,
    room: RelicRoom,
    carryingRelics: boolean,
    revealedRoomId: string | undefined,
): RecommendedMoveRoute | undefined {
    const openNeighbors = room.neighbors
        .map((roomId) => snapshot.map.find((candidate) => candidate.id === roomId))
        .filter((candidate): candidate is RelicRoom => !!candidate && !candidate.collapsed);
    if (openNeighbors.length === 0) {
        return undefined;
    }

    if (carryingRelics) {
        const exit = snapshot.map.find((candidate) => candidate.kind === 'exit');
        if (exit) {
            const next = nextStepToward(snapshot.map, room.id, exit.id);
            if (next) {
                return { next, target: exit, source: 'exit' };
            }
        }
    }

    const revealedTarget = revealedRoomId
        ? snapshot.map.find((candidate) => candidate.id === revealedRoomId && !candidate.collapsed)
        : undefined;
    if (revealedTarget) {
        const next = nextStepToward(snapshot.map, room.id, revealedTarget.id);
        if (next) {
            return { next, target: revealedTarget, source: 'revealed' };
        }
    }

    const relicTarget = highestValueRelicNeighbor(snapshot, openNeighbors);
    if (relicTarget) {
        return { next: relicTarget, target: relicTarget, source: 'relic' };
    }

    const fallback = openNeighbors.find((candidate) => candidate.kind === 'treasure') ??
        openNeighbors.find((candidate) => candidate.kind === 'shrine') ??
        openNeighbors.find((candidate) => candidate.kind === 'trap') ??
        openNeighbors[0];
    return fallback
        ? { next: fallback, target: fallback, source: 'fallback' }
        : undefined;
}

function highestValueRelicNeighbor(
    snapshot: RelicPublicSnapshot,
    neighbors: readonly RelicRoom[],
): RelicRoom | undefined {
    return neighbors
        .map((neighbor) => ({
            neighbor,
            value: highestHiddenRelicValue(snapshot, neighbor.id),
        }))
        .filter((candidate) => candidate.value > 0)
        .sort((left, right) => right.value - left.value)[0]?.neighbor;
}

function highestHiddenRelicValue(
    snapshot: RelicPublicSnapshot,
    roomId: string,
): number {
    return Math.max(
        0,
        ...snapshot.relics
            .filter((relic) =>
                relic.roomId === roomId &&
                !relic.foundBy &&
                !relic.carriedBy &&
                !relic.escapedBy
            )
            .map((relic) => relic.value),
    );
}

function nextStepToward(
    rooms: readonly RelicRoom[],
    fromRoomId: string,
    toRoomId: string,
): RelicRoom | undefined {
    const path = shortestOpenRoomPath(rooms, fromRoomId, toRoomId);
    if (!path || path.length < 2) {
        return undefined;
    }

    const nextRoomId = path[1];
    return rooms.find((room) => room.id === nextRoomId);
}

function clueRouteTitle(
    investigation: RelicPublicSnapshot['roomInvestigations'][number],
    target: RelicRoom,
): string {
    switch (investigation.effect) {
        case 'map-fragment':
            return `Follow the map fragment toward ${target.name}`;
        case 'rune-reading':
            return `Follow the runes toward ${target.name}`;
        case 'safe-path':
            return `Follow the marked safe path toward ${target.name}`;
        case 'treasure-trail':
            return `Follow the treasure trail toward ${target.name}`;
        case 'monster-trace':
            return `Follow the monster trace toward ${target.name}`;
        case 'exit-route':
            return `Follow the exit route toward ${target.name}`;
        case 'ordinary-search':
            return `Follow the clue toward ${target.name}`;
    }
}

function activePlayerCount(snapshot: RelicPublicSnapshot): number {
    return snapshot.players.filter((player) => !player.escaped && !player.defeated).length;
}

function roundsLeft(snapshot: RelicPublicSnapshot): number {
    return snapshot.maxRounds - snapshot.round + 1;
}
