import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutArt } from './cutout-art.ts';

interface CreateJointInput {
    readonly scene: Scene;
    readonly parent: TransformNode;
    readonly x: number;
    readonly y: number;
}
interface CreatePartInput {
    readonly scene: Scene;
    readonly parent: TransformNode;
    readonly material: StandardMaterial;
    readonly width: number;
    readonly height: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

export namespace CutoutActor {
    export interface Pose {
        readonly x: number;
        readonly z: number;
        readonly time: number;
        readonly moving: boolean;
        readonly slipping: boolean;
        readonly facing: number;
    }
}
export class CutoutActor {
    readonly root: TransformNode;
    private readonly body: TransformNode;
    private readonly head: Mesh;
    private readonly leftArm: TransformNode;
    private readonly rightArm: TransformNode;
    private readonly leftLeg: TransformNode;
    private readonly rightLeg: TransformNode;
    private readonly calm: StandardMaterial;
    private readonly surprised: StandardMaterial;

    constructor(scene: Scene, art: CutoutArt, color: string, guard: boolean) {
        this.root = new TransformNode('actor-ground', scene);
        this.body = new TransformNode('paper-puppet', scene);
        this.body.parent = this.root;
        this.body.rotation.x = 0.55;
        this.calm = art.head(guard, false);
        this.surprised = art.head(guard, true);
        this.leftLeg = createJoint({ scene, parent: this.body, x: -0.23, y: 0.63 });
        this.rightLeg = createJoint({ scene, parent: this.body, x: 0.23, y: 0.63 });
        createPart({
            scene,
            parent: this.leftLeg,
            material: art.limb('#49464a', true),
            width: 0.45,
            height: 0.7,
            x: 0,
            y: -0.28,
            z: 0.01
        });
        createPart({
            scene,
            parent: this.rightLeg,
            material: art.limb('#49464a', true),
            width: 0.45,
            height: 0.7,
            x: 0,
            y: -0.28,
            z: 0
        });
        createPart({
            scene,
            parent: this.body,
            material: art.torso(color, guard),
            width: 0.95,
            height: 0.85,
            x: 0,
            y: 0.95,
            z: -0.02
        });
        this.leftArm = createJoint({ scene, parent: this.body, x: -0.39, y: 1.22 });
        this.rightArm = createJoint({ scene, parent: this.body, x: 0.39, y: 1.22 });
        createPart({
            scene,
            parent: this.leftArm,
            material: art.limb(color, false),
            width: 0.43,
            height: 0.68,
            x: 0,
            y: -0.23,
            z: -0.05
        });
        createPart({
            scene,
            parent: this.rightArm,
            material: art.limb(color, false),
            width: 0.43,
            height: 0.68,
            x: 0,
            y: -0.23,
            z: -0.05
        });
        this.head = createPart({
            scene,
            parent: this.body,
            material: this.calm,
            width: 1.13,
            height: 1.12,
            x: 0,
            y: 1.64,
            z: -0.08
        });
    }

    render(pose: CutoutActor.Pose): void {
        this.root.position.set(pose.x, 0.08, pose.z);
        const swing = pose.moving ? Math.sin(pose.time * 15) * 0.5 : Math.sin(pose.time * 2) * 0.035;
        this.body.rotation.z = pose.slipping
            ? Math.sin(pose.time * 8) * 0.2 + 0.45
            : -pose.facing * (pose.moving ? 0.1 : 0);
        this.body.position.y = pose.moving ? Math.abs(Math.sin(pose.time * 15)) * 0.07 : 0;
        this.leftLeg.rotation.z = pose.slipping ? -0.95 : swing;
        this.rightLeg.rotation.z = pose.slipping ? 0.8 : -swing;
        this.leftArm.rotation.z = pose.slipping ? -1.5 : -0.15 - swing * 0.7;
        this.rightArm.rotation.z = pose.slipping ? 1.5 : 0.15 + swing * 0.7;
        this.head.material = pose.slipping ? this.surprised : this.calm;
    }
}

function createJoint(input: CreateJointInput): TransformNode {
    const { scene, parent, x, y } = input;
    const joint = new TransformNode('cutout-joint', scene);
    joint.parent = parent;
    joint.position.set(x, y, 0);
    return joint;
}

function createPart(input: CreatePartInput): Mesh {
    const { scene, parent, material, width, height, x, y, z } = input;
    const part = CreatePlane('paper-part', { width, height }, scene);
    part.parent = parent;
    part.position.set(x, y, z);
    part.material = material;
    part.isPickable = false;
    return part;
}
