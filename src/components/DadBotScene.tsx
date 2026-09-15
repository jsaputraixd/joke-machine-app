"use client";

import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Canvas, extend, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

extend({ RoundedBoxGeometry });

declare module "@react-three/fiber" {
  interface ThreeElements {
    roundedBoxGeometry: ThreeElements["boxGeometry"] & {
      args?: [
        width?: number,
        height?: number,
        depth?: number,
        segments?: number,
        radius?: number,
      ];
    };
  }
}

export type RobotState = "idle" | "thinking" | "talking" | "leanIn" | "punchline";

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface FaceRuntime {
  blink: number;
  mouthOpen: number;
  grin: number;
  squint: number;
  nextBlinkAt: number;
  blinking: boolean;
  blinkStart: number;
  thinkingPhase: number;
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  face: FaceRuntime,
  showThinkingDots: boolean,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, w, h);

  const eyeY = h * 0.42;
  const eyeSpacing = w * 0.24;
  const eyeW = w * 0.15;
  const squintFactor = 1 - face.squint * 0.6;
  const eyeH = Math.max(4, (1 - face.blink) * h * 0.16 * squintFactor);

  ctx.fillStyle = "#7dffb0";
  [-1, 1].forEach((s) => {
    const ex = w / 2 + s * eyeSpacing;
    const r = Math.min(eyeW, eyeH) * 0.3;
    roundRectPath(ctx, ex - eyeW / 2, eyeY - eyeH / 2, eyeW, eyeH, r);
    ctx.fill();
  });

  if (showThinkingDots) {
    for (let i = 0; i < 3; i++) {
      const phase = (face.thinkingPhase + i * 0.33) % 1;
      const op = 0.25 + 0.75 * Math.abs(Math.sin(phase * Math.PI));
      ctx.fillStyle = `rgba(255,176,32,${op.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(w * 0.76 + i * 14, h * 0.14, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const mouthY = h * 0.72;
  ctx.strokeStyle = "#f4e9d8";
  ctx.fillStyle = "#f4e9d8";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";

  if (face.grin > 0.05) {
    const grinW = w * (0.32 + 0.1 * face.grin);
    ctx.beginPath();
    ctx.moveTo(w / 2 - grinW / 2, mouthY - 6);
    ctx.quadraticCurveTo(
      w / 2,
      mouthY + 18 * face.grin,
      w / 2 + grinW / 2,
      mouthY - 6,
    );
    ctx.stroke();
  } else {
    const mw = w * 0.22;
    const mh = 6 + face.mouthOpen * 40;
    ctx.beginPath();
    roundRectPath(ctx, w / 2 - mw / 2, mouthY - mh / 2, mw, mh, mh * 0.4);
    ctx.fill();
  }
}

const SQUINT_TARGET: Record<RobotState, number> = {
  idle: 0,
  thinking: 0.6,
  talking: 0,
  leanIn: 0.5,
  punchline: 0.25,
};

const HEAD_TILT_TARGET: Record<RobotState, number> = {
  idle: 0,
  thinking: 0,
  talking: 0,
  leanIn: -0.07,
  punchline: 0.15,
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// How far you can zoom out: front-on, rotated to the side, and swung all the
// way around to view from behind. The room is a different distance away in
// each of those directions, so a ceiling that's safe dead-ahead clips
// straight through a wall once you've orbited past it — this shrinks (or
// widens) the ceiling to match as you turn. BACK is a starting guess — Dad-Bot
// stands close to the back wall, so it's deliberately the tightest of the
// three; tune it directly.
const FRONT_MAX_DISTANCE = 16;
const SIDE_MAX_DISTANCE = 9;
const BACK_MAX_DISTANCE = 3;

/**
 * Pulls the camera's zoom-out ceiling in as you orbit toward the side walls.
 *
 * `maxDistance` alone is a one-way ceiling — it stops the camera clipping
 * through a wall, but doesn't push it back out again once you rotate back
 * to centre. So on top of that ceiling, this also actively re-pins the
 * camera to the (now larger) ceiling on the way back — but only while it's
 * resting AT the ceiling; a distance the user reached by scrolling in
 * manually is left alone rather than being dragged back out on them.
 */
function CameraDistanceLimiter({
  controlsRef,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
}) {
  const prevMaxRef = useRef(FRONT_MAX_DISTANCE);
  const dirRef = useRef(new THREE.Vector3());

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    // getAzimuthalAngle() is 0 dead-ahead, ±π/2 side-on, ±π looking from
    // directly behind. Two cosine segments — front→side, then side→back —
    // stitched together at π/2: each one barely tightens near its own anchor
    // and narrows fastest mid-segment, rather than a linear (and therefore
    // abrupt-feeling) falloff.
    const angle = Math.abs(controls.getAzimuthalAngle());
    const newMax =
      angle <= Math.PI / 2
        ? lerp(SIDE_MAX_DISTANCE, FRONT_MAX_DISTANCE, Math.cos(angle))
        : lerp(BACK_MAX_DISTANCE, SIDE_MAX_DISTANCE, Math.cos(angle - Math.PI / 2));

    const camera = controls.object;
    const dir = dirRef.current.subVectors(camera.position, controls.target);
    const currentDistance = dir.length();
    const wasPinnedToCeiling = currentDistance >= prevMaxRef.current - 0.05;

    controls.maxDistance = newMax;

    if (wasPinnedToCeiling) {
      dir.normalize();
      camera.position.copy(controls.target).addScaledVector(dir, newMax);
    }

    controls.update();
    prevMaxRef.current = newMax;
  });
  return null;
}

// "Cartoon Office" by scrawach (Sketchfab, Standard License).
const OFFICE_URL = "/models/cartoon-office/scene.gltf";

// 1.3875 increased by 50%.
const ROBOT_SCALE = 2.08125;

// Where Dad-Bot stands, in paces out from the room's centre. "Left" and
// "back" are from the viewer's default vantage point. One pace ~0.8 units,
// roughly a human stride at this scale. The base offsets put him in the open
// aisle; the paces move him from there.
const STEP = 0.8;
const PACES_LEFT = 1;
// Split the difference between the original 4.5 and 11.5.
const PACES_BACK = 4.5;
const STAND_X = -1.02 + PACES_LEFT * STEP;
// Negative: the camera sits at +Z looking toward -Z, so "back" (further
// into the room, away from the viewer) is the negative direction.
const STAND_Z = -0.38 - PACES_BACK * STEP;

/**
 * Office set. Auto-fitted rather than hand-placed: the model is scaled so the
 * room stands at a believable height next to Dad-Bot, dropped so its floor
 * lands on y=0, and centred on him.
 */
function Office({ onFloorY }: { onFloorY: (y: number) => void }) {
  const { scene } = useGLTF(OFFICE_URL);

  const floorY = useMemo(() => {
    // Must happen before ANY measurement of this scene. A freshly-loaded
    // GLTF has never been through a render pass, so its matrixWorld state
    // is undefined until this runs — Box3.setFromObject silently uses
    // whatever's there rather than computing it. That's exactly what was
    // producing a wrong (and inconsistent dev-vs-production) size/scale for
    // the whole room: this call used to happen only later, for the floor
    // raycast, after the box below had already been computed on stale data.
    scene.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // Dad-Bot is ~1.9 units tall, so a ~3.8 unit room reads as a real ceiling.
    const scale = 3.8 / size.y;

    // TEMP DIAGNOSTIC — remove once the prod-only shrink/float bug is found.
    console.log("[office-debug] box", {
      size: [size.x, size.y, size.z],
      center: [center.x, center.y, center.z],
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      scale,
      childCount: scene.children.length,
      meshCount: (() => {
        let n = 0;
        scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) n++;
        });
        return n;
      })(),
    });

    // The office stays fixed and centred — Dad-Bot is what moves through it.
    scene.scale.setScalar(scale);
    scene.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });

    // The model's lowest point is the underside of the floor slab, not its
    // walking surface — standing on y=0 buries his feet. Raycast straight down
    // at Dad-Bot's actual spot to find the floor height there. The scale/
    // position just changed above, so matrices need refreshing again.
    scene.updateMatrixWorld(true);
    const floorRay = new THREE.Raycaster(
      new THREE.Vector3(STAND_X, 20, STAND_Z),
      new THREE.Vector3(0, -1, 0),
    );
    const floorHits = floorRay.intersectObject(scene, true);
    // The lowest hit point directly below the stand spot — not "the last
    // element", which only equals that if intersectObject's ordering is
    // exactly what's expected. This was floating Dad-Bot above the floor
    // in production while looking correct in dev.
    return floorHits.length > 0
      ? Math.min(...floorHits.map((h) => h.point.y))
      : 0;
  }, [scene]);

  useEffect(() => {
    onFloorY(floorY);
  }, [floorY, onFloorY]);

  return <primitive object={scene} />;
}

useGLTF.preload(OFFICE_URL);

function Robot({
  state,
  mouthLevelRef,
  busy,
  onTellJoke,
}: {
  state: RobotState;
  mouthLevelRef: RefObject<number>;
  busy: boolean;
  onTellJoke: () => void;
}) {
  const headRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const armLRef = useRef<THREE.Group>(null);
  const armRRef = useRef<THREE.Group>(null);
  const buttonCapRef = useRef<THREE.Mesh>(null);
  const clawLRef = useRef<THREE.Group>(null);
  const clawRRef = useRef<THREE.Group>(null);
  const elbowLRef = useRef<THREE.Group>(null);
  const elbowRRef = useRef<THREE.Group>(null);
  const waistRef = useRef<THREE.Group>(null);

  const headTiltRef = useRef(0);
  const danceRef = useRef(0);
  const danceStartRef = useRef<number | null>(null);

  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    return () => {
      document.body.style.cursor = "auto";
    };
  }, []);

  const canvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 220;
    return c;
  }, []);
  const texture = useMemo(() => new THREE.CanvasTexture(canvas), [canvas]);

  const face = useRef<FaceRuntime>({
    blink: 0,
    mouthOpen: 0,
    grin: 0,
    squint: 0,
    nextBlinkAt: 2 + Math.random() * 2,
    blinking: false,
    blinkStart: 0,
    thinkingPhase: 0,
  });

  const suitMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x24242c,
        roughness: 0.45,
        metalness: 0.15,
      }),
    [],
  );
  const lapelMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x3e3e4c,
        roughness: 0.38,
        metalness: 0.18,
      }),
    [],
  );
  const limbMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x5c5c6a,
        roughness: 0.45,
        metalness: 0.2,
      }),
    [],
  );
  const jointMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x9c9cae,
        roughness: 0.3,
        metalness: 0.25,
      }),
    [],
  );
  const shirtMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.7 }),
    [],
  );
  const tieMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xffb020,
        roughness: 0.35,
        metalness: 0.2,
      }),
    [],
  );
  const shoeMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x5e3c27,
        roughness: 0.35,
        metalness: 0.1,
      }),
    [],
  );
  const soleMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.8 }),
    [],
  );
  const bezelMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x17171c,
        roughness: 0.28,
        metalness: 0.25,
      }),
    [],
  );
  const frameMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xa8a8ba,
        roughness: 0.25,
        metalness: 0.3,
      }),
    [],
  );
  const ventMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x6e6e7e,
        roughness: 0.5,
        metalness: 0.2,
      }),
    [],
  );
  const antennaTipMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xffb020,
        emissive: 0xffb020,
        emissiveIntensity: 0.7,
        roughness: 0.3,
      }),
    [],
  );
  const buttonMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xffb020,
        emissive: 0xffb020,
        emissiveIntensity: 0.3,
        roughness: 0.3,
        metalness: 0.1,
      }),
    [],
  );
  const glassesMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xc08b3e,
        roughness: 0.28,
        metalness: 0.35,
      }),
    [],
  );
  const lensMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xcfeaff,
        roughness: 0.05,
        metalness: 0,
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
      }),
    [],
  );

  const screenFrameGeo = useMemo(() => {
    const roundedRect = (w: number, h: number, r: number) => {
      const s = new THREE.Shape();
      const x = -w / 2;
      const y = -h / 2;
      s.moveTo(x + r, y);
      s.lineTo(x + w - r, y);
      s.quadraticCurveTo(x + w, y, x + w, y + r);
      s.lineTo(x + w, y + h - r);
      s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      s.lineTo(x + r, y + h);
      s.quadraticCurveTo(x, y + h, x, y + h - r);
      s.lineTo(x, y + r);
      s.quadraticCurveTo(x, y, x + r, y);
      return s;
    };

    const shape = roundedRect(0.64, 0.54, 0.05);
    shape.holes.push(roundedRect(0.55, 0.45, 0.035));
    return new THREE.ExtrudeGeometry(shape, {
      depth: 0.03,
      bevelEnabled: false,
      curveSegments: 10,
    });
  }, []);

  useFrame((_, delta) => {
    const t = performance.now() / 1000;
    const f = face.current;

    if (state === "idle") {
      if (!f.blinking && t > f.nextBlinkAt) {
        f.blinking = true;
        f.blinkStart = t;
      }
      if (f.blinking) {
        const bt = (t - f.blinkStart) / 0.16;
        f.blink = bt < 0.5 ? bt * 2 : Math.max(0, (1 - bt) * 2);
        if (bt >= 1) {
          f.blink = 0;
          f.blinking = false;
          f.nextBlinkAt = t + 2.5 + Math.random() * 3;
        }
      }
    } else {
      f.blink = 0;
      f.blinking = false;
    }

    f.squint = lerp(f.squint, SQUINT_TARGET[state], 0.08);

    if (state === "talking") {
      f.mouthOpen = lerp(f.mouthOpen, mouthLevelRef.current, 0.5);
    } else {
      f.mouthOpen = lerp(f.mouthOpen, 0, 0.2);
    }

    f.grin = lerp(f.grin, state === "punchline" ? 1 : 0, 0.12);
    f.thinkingPhase = (f.thinkingPhase + delta * 0.9) % 1;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      drawFace(ctx, canvas.width, canvas.height, f, state === "thinking");
      texture.needsUpdate = true;
    }

    // --- Robo dance -----------------------------------------------------
    // Built on the three rules that actually make it read as a robot:
    // isolation (one part moves at a time), sudden starts/stops with holds
    // in between, and a "pop" — a hard jolt that decays — on each snap.
    // He dances the whole time he's delivering, so the routine loops for
    // however long the speech runs rather than playing once.
    if (state === "talking") {
      if (danceStartRef.current === null) danceStartRef.current = t;
    } else {
      danceStartRef.current = null;
    }
    danceRef.current = lerp(danceRef.current, state === "talking" ? 1 : 0, 0.25);
    const d = danceRef.current;
    const ROUTINE = 6;
    const elapsed = danceStartRef.current === null ? 0 : t - danceStartRef.current;
    const cycle = Math.floor(elapsed / ROUTINE);
    const dt = elapsed % ROUTINE;

    // Ramp across a window then hold — a short window is a snap, a long one
    // is a slow move, and the value freezes at both ends.
    const seg = (a: number, b: number) =>
      Math.min(1, Math.max(0, (dt - a) / (b - a)));
    // Muscle-tension pop: a hard overshoot that damps out in a fraction of a second.
    const pop = (at: number, amount: number, dur = 0.18) => {
      const k = (dt - at) / dur;
      return k < 0 || k > 1 ? 0 : amount * (1 - k) * Math.cos(k * Math.PI * 3);
    };

    // 1. Ready stance — both elbows snap to 90°, hands up in front. Hold.
    const ready = -1.55 * seg(0.06, 0.16) + pop(0.16, 0.22);
    // 2. Wrist twist — slow, wrists only. Carries over between loops so it
    //    keeps winding forward instead of snapping back at the seam.
    const wristTwist = (cycle + seg(0.45, 1.15)) * Math.PI * 1.35;
    // 3. Forearm snap — right elbow only, sharp, then dead freeze.
    const forearmSnap = -1.15 * seg(1.3, 1.38) + pop(1.38, 0.34);
    // 4. Head isolation — snap right, hold, snap left, hold, re-centre.
    const headTurn =
      0.52 * seg(1.75, 1.83) -
      1.04 * seg(2.15, 2.23) +
      0.52 * seg(2.55, 2.63) +
      pop(1.83, 0.1);
    // 5. Heel pivot — stiff legs, whole frame pivots side to side.
    const heelPivot =
      0.34 * seg(2.95, 3.05) - 0.68 * seg(3.4, 3.5) + 0.34 * seg(3.85, 3.95);
    // 6. Waist bend — slow fold forward, then power cuts mid-bend. Hold.
    //    7. Torso pop — snap upright on the beat.
    const waistBend =
      0.5 * seg(4.15, 4.75) - 0.5 * seg(5.25, 5.32) + pop(5.32, -0.2);
    // 8. Release — elbows drop back to rest.
    const release = seg(5.6, 5.9);

    headTiltRef.current = lerp(
      headTiltRef.current,
      HEAD_TILT_TARGET[state],
      0.08,
    );
    if (headRef.current) {
      headRef.current.rotation.x = headTiltRef.current;
      headRef.current.rotation.y = d * headTurn;
      headRef.current.rotation.z = d * headTurn * -0.18;
    }

    // Shoulders stay put through the routine — the elbows do the talking.
    const sway = Math.sin(t * 0.8) * 0.03;
    if (armLRef.current) armLRef.current.rotation.z = lerp(sway, 0, d);
    if (armRRef.current) armRRef.current.rotation.z = lerp(-sway, 0, d);

    const elbowRest = (1 - release) * ready;
    if (elbowLRef.current) elbowLRef.current.rotation.x = d * elbowRest;
    if (elbowRRef.current) {
      elbowRRef.current.rotation.x =
        d * (elbowRest + (1 - release) * forearmSnap);
    }

    if (d > 0.01) {
      if (clawLRef.current) clawLRef.current.rotation.y = wristTwist;
      if (clawRRef.current) clawRRef.current.rotation.y = -wristTwist;
    }

    if (waistRef.current) waistRef.current.rotation.x = d * waistBend;

    if (bodyRef.current) {
      const idleBob = Math.sin(t * 1.1) * 0.015;
      // Legs stay stiff — only a small jolt on the torso pop.
      bodyRef.current.position.y = lerp(idleBob, pop(5.32, 0.05), d);
      bodyRef.current.rotation.y = d * heelPivot;
    }

    const glowTarget = busy
      ? 0.08
      : hovered
        ? 0.9
        : 0.28 + 0.16 * Math.sin(t * 2.2);
    buttonMat.emissiveIntensity = lerp(
      buttonMat.emissiveIntensity,
      glowTarget,
      0.15,
    );

    if (buttonCapRef.current) {
      buttonCapRef.current.position.z = lerp(
        buttonCapRef.current.position.z,
        pressed ? 0.322 : 0.335,
        0.35,
      );
    }
  });

  return (
    <group ref={bodyRef}>
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * 0.22, 0.6, 0]} castShadow material={jointMat}>
            <sphereGeometry args={[0.15, 16, 16]} />
          </mesh>
          <mesh position={[s * 0.22, 0.47, 0]} castShadow material={limbMat}>
            <cylinderGeometry args={[0.135, 0.125, 0.26, 16]} />
          </mesh>
          <mesh position={[s * 0.22, 0.34, 0]} castShadow material={jointMat}>
            <sphereGeometry args={[0.115, 16, 16]} />
          </mesh>
          <mesh position={[s * 0.22, 0.23, 0]} castShadow material={limbMat}>
            <cylinderGeometry args={[0.115, 0.125, 0.26, 16]} />
          </mesh>
          <mesh
            position={[s * 0.22, 0.115, 0.05]}
            castShadow
            material={shoeMat}
          >
            <roundedBoxGeometry args={[0.34, 0.14, 0.44, 3, 0.06]} />
          </mesh>
          <mesh position={[s * 0.22, 0.04, 0.05]} castShadow material={soleMat}>
            <roundedBoxGeometry args={[0.36, 0.06, 0.46, 2, 0.025]} />
          </mesh>
        </group>
      ))}

      {/* Waist pivot. The outer group sits at the waistline and the inner one
          cancels that offset, so everything above keeps its original
          coordinates while still bending from the right place. */}
      <group ref={waistRef} position={[0, 0.72, 0]}>
        <group position={[0, -0.72, 0]}>
          <mesh position={[0, 1.12, 0]} castShadow material={suitMat}>
            <roundedBoxGeometry args={[0.86, 0.95, 0.62, 4, 0.14]} />
          </mesh>

          {[-1, 1].map((s) => (
            <mesh
              key={s}
              position={[s * 0.25, 1.3, 0.312]}
              rotation={[0, 0, s * -0.12]}
              material={lapelMat}
            >
              <roundedBoxGeometry args={[0.16, 0.44, 0.03, 2, 0.012]} />
            </mesh>
          ))}

          <mesh position={[0, 1.32, 0.31]} material={shirtMat}>
            <roundedBoxGeometry args={[0.3, 0.46, 0.03, 2, 0.012]} />
          </mesh>

          {[-1, 1].map((s) => (
            <mesh
              key={s}
              position={[s * 0.09, 1.46, 0.325]}
              rotation={[0, 0, s * 0.5]}
              material={shirtMat}
            >
              <boxGeometry args={[0.13, 0.11, 0.025]} />
            </mesh>
          ))}

          <mesh position={[0, 1.42, 0.335]} material={tieMat}>
            <boxGeometry args={[0.07, 0.07, 0.03]} />
          </mesh>
          <mesh position={[0, 1.22, 0.332]} material={tieMat}>
            <boxGeometry args={[0.1, 0.34, 0.025]} />
          </mesh>

          <mesh position={[0, 0.72, 0]} castShadow material={lapelMat}>
            <roundedBoxGeometry args={[0.9, 0.11, 0.66, 2, 0.04]} />
          </mesh>
          <mesh position={[0, 0.72, 0.338]} material={tieMat}>
            <boxGeometry args={[0.11, 0.08, 0.03]} />
          </mesh>

          <group
            onPointerOver={(e) => {
              e.stopPropagation();
              if (busy) return;
              setHovered(true);
              document.body.style.cursor = "pointer";
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              setHovered(false);
              setPressed(false);
              document.body.style.cursor = "auto";
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              pointerDownAt.current = { x: e.clientX, y: e.clientY };
              if (!busy) setPressed(true);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              setPressed(false);
              const start = pointerDownAt.current;
              pointerDownAt.current = null;
              if (!start || busy) return;
              // Ignore if the pointer was dragged — that's an orbit, not a press.
              if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6)
                return;
              onTellJoke();
            }}
          >
            <mesh
              position={[0, 0.9, 0.318]}
              rotation={[Math.PI / 2, 0, 0]}
              material={frameMat}
            >
              <cylinderGeometry args={[0.115, 0.115, 0.035, 24]} />
            </mesh>
            <mesh
              ref={buttonCapRef}
              position={[0, 0.9, 0.335]}
              rotation={[Math.PI / 2, 0, 0]}
              castShadow
              material={buttonMat}
            >
              <cylinderGeometry args={[0.085, 0.085, 0.05, 24]} />
            </mesh>
          </group>

          {[
            { shoulder: armLRef, elbow: elbowLRef, claw: clawLRef, s: -1 },
            { shoulder: armRRef, elbow: elbowRRef, claw: clawRRef, s: 1 },
          ].map(({ shoulder, elbow, claw, s }) => (
            <group key={s} ref={shoulder} position={[s * 0.46, 1.42, 0]}>
              <mesh castShadow material={jointMat}>
                <sphereGeometry args={[0.15, 16, 16]} />
              </mesh>
              <mesh
                position={[s * 0.1, -0.15, 0]}
                rotation={[0, 0, s * 0.588]}
                castShadow
                material={limbMat}
              >
                <cylinderGeometry args={[0.105, 0.095, 0.34, 14]} />
              </mesh>

              {/* Elbow pivot — the forearm, cuff and claw hang off this so the
              forearm can snap independently of the shoulder. */}
              <group ref={elbow} position={[s * 0.2, -0.3, 0]}>
                <mesh castShadow material={jointMat}>
                  <sphereGeometry args={[0.085, 16, 16]} />
                </mesh>
                <mesh
                  position={[s * 0.06, -0.15, 0]}
                  rotation={[0, 0, s * 0.38]}
                  castShadow
                  material={limbMat}
                >
                  <cylinderGeometry args={[0.09, 0.085, 0.32, 14]} />
                </mesh>
                <mesh
                  position={[s * 0.1, -0.245, 0]}
                  rotation={[0, 0, s * 0.38]}
                  material={shirtMat}
                >
                  <cylinderGeometry args={[0.105, 0.105, 0.06, 14]} />
                </mesh>

                {/* Minifig-style clasping hand: a wrist stud into an open
                    C-ring. The outer group aligns to the forearm axis; the
                    inner group spins, so it turns like a wrist. */}
                <group
                  position={[s * 0.12, -0.3, 0]}
                  rotation={[0, 0, s * 0.38]}
                >
                  <group ref={claw}>
                    <mesh castShadow material={frameMat}>
                      <cylinderGeometry args={[0.058, 0.052, 0.11, 14]} />
                    </mesh>
                    {/* Partial torus — the arc leaves the gap that makes it
                        read as a clasp rather than a solid ring. */}
                    <mesh
                      position={[0, -0.14, 0]}
                      rotation={[0, 0, -0.87]}
                      castShadow
                      material={frameMat}
                    >
                      <torusGeometry
                        args={[0.082, 0.032, 12, 24, Math.PI * 1.55]}
                      />
                    </mesh>
                  </group>
                </group>
              </group>
            </group>
          ))}

          <mesh position={[0, 1.63, 0]} material={limbMat}>
            <cylinderGeometry args={[0.11, 0.13, 0.14, 14]} />
          </mesh>

          <group ref={headRef} position={[0, 2.02, 0]}>
            <mesh castShadow material={bezelMat}>
              <roundedBoxGeometry args={[0.78, 0.7, 0.44, 4, 0.06]} />
            </mesh>

            {[-1, 1].map((s) =>
              [-0.09, -0.02, 0.05].map((y) => (
                <mesh
                  key={`${s}-${y}`}
                  position={[s * 0.385, y, -0.04]}
                  material={ventMat}
                >
                  <boxGeometry args={[0.02, 0.022, 0.2]} />
                </mesh>
              )),
            )}

            <mesh position={[0, 0, 0.221]}>
              <planeGeometry args={[0.56, 0.46]} />
              <meshBasicMaterial map={texture} />
            </mesh>

            <mesh position={[0, 0, 0.218]} material={frameMat}>
              <primitive object={screenFrameGeo} attach="geometry" />
            </mesh>

            {[-1, 1].map((sx) =>
              [-1, 1].map((sy) => (
                <mesh
                  key={`${sx}-${sy}`}
                  position={[sx * 0.2975, sy * 0.2475, 0.248]}
                  rotation={[Math.PI / 2, 0, 0]}
                  material={frameMat}
                >
                  <cylinderGeometry args={[0.013, 0.013, 0.014, 8]} />
                </mesh>
              )),
            )}

            {/* Reading glasses, centred on the eyes drawn at y=+0.037 on the screen. */}
            <group position={[0, 0.037, 0]}>
              {[-1, 1].map((s) => (
                <group key={s}>
                  <mesh
                    position={[s * 0.134, 0, 0.272]}
                    castShadow
                    material={glassesMat}
                  >
                    <torusGeometry args={[0.105, 0.012, 8, 28]} />
                  </mesh>
                  <mesh position={[s * 0.134, 0, 0.269]} material={lensMat}>
                    <circleGeometry args={[0.097, 24]} />
                  </mesh>
                  <mesh
                    position={[s * 0.318, 0, 0.272]}
                    rotation={[0, 0, Math.PI / 2]}
                    material={glassesMat}
                  >
                    <cylinderGeometry args={[0.011, 0.011, 0.134, 10]} />
                  </mesh>
                  <mesh position={[s * 0.385, 0, 0.272]} material={glassesMat}>
                    <sphereGeometry args={[0.016, 10, 10]} />
                  </mesh>
                  <mesh
                    position={[s * 0.385, 0, 0.111]}
                    rotation={[Math.PI / 2, 0, 0]}
                    castShadow
                    material={glassesMat}
                  >
                    <cylinderGeometry args={[0.011, 0.011, 0.322, 10]} />
                  </mesh>
                </group>
              ))}
              <mesh
                position={[0, 0.03, 0.272]}
                rotation={[0, 0, Math.PI / 2]}
                material={glassesMat}
              >
                <cylinderGeometry args={[0.009, 0.009, 0.08, 10]} />
              </mesh>
            </group>

            <mesh position={[0, 0.36, 0]} material={frameMat}>
              <cylinderGeometry args={[0.042, 0.05, 0.05, 12]} />
            </mesh>
            <mesh position={[0, 0.45, 0]} material={frameMat}>
              <cylinderGeometry args={[0.02, 0.02, 0.18, 8]} />
            </mesh>
            <mesh position={[0, 0.55, 0]} material={antennaTipMat}>
              <sphereGeometry args={[0.045, 12, 12]} />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  );
}

// TEMP DIAGNOSTIC — remove once the prod-only shrink/float bug is found.
function DebugCanvasInfo() {
  const { size, camera, gl } = useThree();
  useEffect(() => {
    console.log("[office-debug] canvas", {
      cssSize: [size.width, size.height],
      drawingBufferSize: [gl.domElement.width, gl.domElement.height],
      devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : null,
      cameraAspect: (camera as THREE.PerspectiveCamera).aspect,
      cameraFov: (camera as THREE.PerspectiveCamera).fov,
      cameraPosition: camera.position.toArray(),
    });
  }, [size, camera, gl]);
  return null;
}

function SceneContent({
  state,
  mouthLevelRef,
  busy,
  onTellJoke,
  bubble,
}: {
  state: RobotState;
  mouthLevelRef: RefObject<number>;
  busy: boolean;
  onTellJoke: () => void;
  bubble?: ReactNode;
}) {
  const [floorY, setFloorY] = useState(0);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  return (
    <>
      <DebugCanvasInfo />
      <color attach="background" args={["#eceef2"]} />

      {/* Interior lighting: flatter and more ambient than the white-void rig,
          since the room supplies its own walls and bounce. */}
      <hemisphereLight args={[0xffffff, 0xb8bcc6, 1.05]} />
      <directionalLight
        position={[3, 5, 4]}
        intensity={0.7}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
      />
      <directionalLight position={[-4, 2, -2]} intensity={0.3} />
      <directionalLight
        position={[0, 2.2, -4]}
        intensity={0.45}
        color={0xdfeaff}
      />

      {/* Overhead fill, positioned above wherever Dad-Bot actually stands
          (STAND_X/STAND_Z) — a point light so it pools over him instead of
          flatly lighting the whole room like another directional would. */}
      <pointLight
        position={[STAND_X, 6, STAND_Z]}
        intensity={10}
        distance={14}
        decay={2}
        color={0xfff2df}
      />

      <Suspense fallback={null}>
        <Office onFloorY={setFloorY} />
      </Suspense>

      {/* Dad-Bot sits on the measured floor, scaled down to office-human size.
          The bubble lives inside this group so it tracks his actual head. */}
      <group position={[STAND_X, floorY, STAND_Z]} scale={ROBOT_SCALE}>
        <Robot
          state={state}
          mouthLevelRef={mouthLevelRef}
          busy={busy}
          onTellJoke={onTellJoke}
        />

        {bubble ? (
          <Html
            position={[0.5, 2.3, 0]}
            style={{ pointerEvents: "none" }}
            zIndexRange={[20, 10]}
          >
            {bubble}
          </Html>
        ) : null}
      </group>

      <CameraDistanceLimiter controlsRef={controlsRef} />

      <OrbitControls
        ref={controlsRef}
        target={[STAND_X, floorY + 1.35 * ROBOT_SCALE, STAND_Z]}
        enableDamping
        dampingFactor={0.08}
        minDistance={3}
        // Static ceiling for the very first frame, before the limiter above
        // has run once — it takes over every frame after that.
        maxDistance={FRONT_MAX_DISTANCE}
        maxPolarAngle={Math.PI * 0.54}
        // Held lower than the white-void version so you can't rise up and
        // look over the office walls.
        minPolarAngle={Math.PI * 0.3}
        enablePan={false}
      />
    </>
  );
}

export default function DadBotScene({
  state,
  mouthLevelRef,
  busy,
  onTellJoke,
  bubble,
}: {
  state: RobotState;
  mouthLevelRef: RefObject<number>;
  busy: boolean;
  onTellJoke: () => void;
  bubble?: ReactNode;
}) {
  return (
    <Canvas
      shadows={{ type: THREE.PCFShadowMap }}
      camera={{ position: [STAND_X, 1.7, STAND_Z + FRONT_MAX_DISTANCE], fov: 38 }}
    >
      <SceneContent
        state={state}
        mouthLevelRef={mouthLevelRef}
        busy={busy}
        onTellJoke={onTellJoke}
        bubble={bubble}
      />
    </Canvas>
  );
}
