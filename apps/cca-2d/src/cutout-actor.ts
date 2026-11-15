import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutArt } from './cutout-art.ts';

interface CutoutPart {
    readonly parent: TransformNode;
    readonly material: StandardMaterial;
    readonly width: number;
    readonly height: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
}
export namespace CutoutActor {
    export interface Input {
        readonly scene: Scene;
        readonly art: CutoutArt;
        readonly color: string;
        readonly guard: boolean;
    }
    export interface Pose {
        readonly x: number;
        readonly z: number;
        readonly time: number;
        readonly moving: boolean;
        readonly slipping: boolean;
        readonly facing: number;
        readonly angry: boolean;
        readonly dizzy: boolean;
        readonly puking: boolean;
        readonly mini: boolean;
        readonly working: boolean;
    }
}
export class CutoutActor {
    readonly root: TransformNode;
    private readonly scene: Scene;
    private readonly body: TransformNode;
    private readonly head: Mesh;
    private readonly leftArm: TransformNode;
    private readonly rightArm: TransformNode;
    private readonly leftLeg: TransformNode;
    private readonly rightLeg: TransformNode;
    private readonly broom: Mesh;
    private readonly puke: Mesh;
    private readonly calm: StandardMaterial;
    private readonly surprised: StandardMaterial;
    private readonly angry: StandardMaterial;
    private readonly dizzy: StandardMaterial;

    constructor(input: CutoutActor.Input) {
        const { scene, art, color, guard } = input;
        this.scene = scene;
        this.root = new TransformNode('actor-ground', scene);
        this.body = new TransformNode('paper-puppet', scene);
        this.body.parent = this.root;
        this.body.rotation.x = 0.55;
        this.calm = art.head(guard, 'grumpy');
        this.surprised = art.head(guard, 'surprised');
        this.angry = art.head(guard, 'angry');
        this.dizzy = art.head(guard, 'dizzy');
        this.leftLeg = this.createLimb(art.limb('#49464a', true), -0.23, true);
        this.rightLeg = this.createLimb(art.limb('#49464a', true), 0.23, true);
        this.createPart({
            parent: this.body,
            material: art.torso(color, guard),
            width: 0.95,
            height: 0.85,
            x: 0,
            y: 0.95,
            z: -0.02
        });
        this.leftArm = this.createLimb(art.limb(color, false), -0.39, false);
        this.rightArm = this.createLimb(art.limb(color, false), 0.39, false);
        this.head = this.createPart({
            parent: this.body,
            material: this.calm,
            width: 1.13,
            height: 1.12,
            x: 0,
            y: 1.64,
            z: -0.08
        });
        const broom = art.texture(
            'broom',
            '<path stroke="#775333" stroke-width="16" d="M130 5L116 191"/><path fill="#cda75b" stroke="#5f5334" stroke-width="5" d="M76 162H163L185 245H51zM80 177l-5 64m32-64v65m27-64l12 63"/>'
        );
        this.broom = this.createPart({
            parent: this.body,
            material: broom,
            width: 0.65,
            height: 1.6,
            x: 0.65,
            y: 0.75,
            z: -0.1
        });
        const puke = art.texture(
            'puke-stream',
            '<path fill="#a5b945" d="M70 10Q140 35 150 100T204 237L89 243Q143 133 106 91T70 10z"/>'
        );
        this.puke = this.createPart({
            parent: this.body,
            material: puke,
            width: 0.8,
            height: 1.3,
            x: 0.3,
            y: 0.75,
            z: -0.2
        });
    }

    render(pose: CutoutActor.Pose): void {
        this.root.position.set(pose.x, 0.08, pose.z);
        this.root.scaling.setAll(pose.mini ? 0.48 : 1);
        const swing = pose.moving ? Math.sin(pose.time * 15) * 0.5 : Math.sin(pose.time * 2) * 0.035;
        this.body.rotation.z = pose.slipping
            ? Math.sin(pose.time * 8) * 0.2 + 0.45
            : -pose.facing * (pose.moving ? 0.1 : 0);
        if (pose.dizzy) {
            this.body.rotation.z = Math.sin(pose.time * 5) * 0.22;
        }
        this.body.position.y = pose.moving ? Math.abs(Math.sin(pose.time * 15)) * 0.07 : 0;
        this.leftLeg.rotation.z = pose.slipping ? -0.95 : swing;
        this.rightLeg.rotation.z = pose.slipping ? 0.8 : -swing;
        this.leftArm.rotation.z = pose.slipping ? -1.5 : -0.15 - swing * 0.7;
        this.rightArm.rotation.z = pose.angry ? 1.7 : pose.slipping ? 1.5 : 0.15 + swing * 0.7;
        this.head.material = pose.dizzy
            ? this.dizzy
            : pose.angry
            ? this.angry
            : pose.slipping
            ? this.surprised
            : this.calm;
        this.broom.setEnabled(pose.working);
        this.broom.rotation.z = Math.sin(pose.time * 9) * 0.25;
        this.puke.setEnabled(pose.puking);
        this.puke.scaling.x = 0.9 + Math.sin(pose.time * 20) * 0.12;
    }

    private createLimb(material: StandardMaterial, x: number, leg: boolean): TransformNode {
        const joint = new TransformNode('cutout-joint', this.scene);
        joint.parent = this.body;
        joint.position.set(x, leg ? 0.63 : 1.22, 0);
        this.createPart({
            parent: joint,
            material,
            width: leg ? 0.45 : 0.43,
            height: leg ? 0.7 : 0.68,
            x: 0,
            y: leg ? -0.28 : -0.23,
            z: leg ? 0.01 : -0.05
        });
        return joint;
    }

    private createPart(part: CutoutPart): Mesh {
        const mesh = CreatePlane('paper-part', { width: part.width, height: part.height }, this.scene);
        mesh.parent = part.parent;
        mesh.position.set(part.x, part.y, part.z);
        mesh.material = part.material;
        mesh.isPickable = false;
        return mesh;
    }
}
