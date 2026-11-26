import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutActor } from '../../cutout-actor.ts';
import { CutoutArt } from '../../cutout-art.ts';
import { createTownIce } from '../../town/raid-presentation.ts';
import type { TownMatchSession } from '../town-match-session.ts';
import type { TownMatchPlayer, TownMatchState } from '../town-match.ts';
import { resolveTownMatchAppearance } from './town-match-hud.ts';
import { TownMatchPeerPresentation } from './town-match-peer-presentation.ts';

interface TownMatchPeer {
    readonly actor: CutoutActor;
    readonly ice: Mesh;
    readonly presentation: TownMatchPeerPresentation;
}

export class TownMatchPeerActors {
    private readonly root: HTMLElement;
    private readonly scene: Scene;
    private readonly art: CutoutArt;
    private readonly peers = new Map<string, TownMatchPeer>();

    constructor(root: HTMLElement, scene: Scene) {
        this.root = root;
        this.scene = scene;
        this.art = new CutoutArt(scene);
    }

    render(
        view: TownMatchSession.View,
        match: TownMatchState,
        focus: TownMatchPlayer,
        visible: boolean,
        nowEpochMs: number
    ): void {
        const players = match.players.filter((player) =>
            player.id !== focus.id &&
            match.seats.some((seat) => seat.id === player.id && seat.status === 'active')
        );
        this.removeAbsentPeers(players);
        for (const player of players) {
            const appearance = resolveTownMatchAppearance(match, player.id);
            let peer = this.peers.get(player.id);
            if (!peer) {
                const actor = new CutoutActor({
                    scene: this.scene,
                    art: this.art,
                    color: appearance.color,
                    guard: false
                });
                peer = {
                    actor,
                    ice: createTownIce(this.scene, this.art),
                    presentation: new TownMatchPeerPresentation()
                };
                this.peers.set(player.id, peer);
            }
            peer.actor.updateColor(appearance.color);
            const live = view.livePoses?.players.find((pose) => pose.id === player.id);
            const source = live && player.frozenUntil <= player.elapsed ? { ...player, ...live } : player;
            const pose = peer.presentation.advance({
                player: source,
                town: match.town,
                matchId: match.matchId,
                tick: live && view.livePoses ? view.livePoses.tick : match.tick,
                inputGeneration: view.inputGeneration,
                enabled: visible && !document.hidden && match.phase === 'playing' &&
                    view.available && !view.recovering,
                nowEpochMs
            });
            if (player === players[0]) {
                this.root.dataset.renderPeerX = String(pose.x);
                this.root.dataset.peerColor = appearance.color;
            }
            peer.ice.setEnabled(player.frozenUntil > player.elapsed);
            peer.ice.position.set(pose.x, 1, pose.z - 0.3);
            peer.actor.render({
                x: pose.x,
                z: pose.z,
                time: player.frozenUntil > player.elapsed ? 0 : pose.animationTime,
                moving: player.frozenUntil <= player.elapsed && Math.hypot(source.vx, source.vz) > 0.2,
                slipping: player.slipping,
                facing: Math.abs(source.vx) > 0.05 ? Math.sign(source.vx) : player.facingX,
                angry: false,
                dizzy: player.dizzyUntil > player.elapsed,
                puking: player.sickAt >= 0 && player.elapsed >= player.sickAt && player.elapsed < player.sickAt + 1,
                mini: false,
                working: false,
                stain: player.stain
            });
        }
    }

    private removeAbsentPeers(players: readonly TownMatchPlayer[]): void {
        if (players.length === 0) {
            delete this.root.dataset.renderPeerX;
            delete this.root.dataset.peerColor;
        }
        for (const [id, peer] of this.peers) {
            if (!players.some((player) => player.id === id)) {
                peer.actor.root.dispose();
                peer.ice.dispose();
                this.peers.delete(id);
            }
        }
    }
}
