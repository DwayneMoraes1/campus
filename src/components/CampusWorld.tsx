"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

interface BuildingCfg {
  name: string;
  file: string;
  x: number;
  z: number;
  targetWidth: number;
  targetDepth: number;
  heightScale: number;
  rotationY: number;
}

// Layout: 2 rows of 3, big buildings, 12u+ gaps, trees in outer band 76-87
// Top row z=-52: MLK(-50) | Tower(0) | Macquarrie(50)
//   MLK  edges x[-73,-27] gap=11 Tower x[-16,16] gap=11 Macquarrie x[27,73]
// Bot row z=50: Dorms(-50) | ATM(0) | EventCtr(50)
//   Dorms edges x[-74,-26] gap=10 Union x[-16,16] gap=10 EventCtr x[26,74]
// All buildings max |x|=74, |z|=74  →  trees in band 76-87 → 2u clearance min
const BUILDINGS: BuildingCfg[] = [
  { name: "MLK Library",    file: "Martin_Luther_King_Library.glb", x: -42, z: -44, targetWidth: 46, targetDepth: 40, heightScale: 1.8, rotationY: 0 },
  { name: "Tower Hall",     file: "sjsu_clock_tower%20(1).glb",    x:   0, z: -52, targetWidth: 32, targetDepth: 32, heightScale: 1.8, rotationY: 0 },
  { name: "Macquarrie Hall",file: "macquarrie_hall.glb",           x:  42, z: -44, targetWidth: 46, targetDepth: 40, heightScale: 1.8, rotationY: 0 },
  { name: "Event Center",   file: "SJSU+-+EVENT+CENTER.glb",       x:  42, z:  42, targetWidth: 48, targetDepth: 44, heightScale: 1.8, rotationY: 0 },
  { name: "ATM",            file: "ATM.glb",                       x:   0, z:  50, targetWidth: 32, targetDepth: 26, heightScale: 1.8, rotationY: 0 },
  { name: "Dorms",          file: "Untitled.glb",                  x: -50, z:  50, targetWidth: 48, targetDepth: 42, heightScale: 1.8, rotationY: 0 },
];

const MINIMAP_DOT = [
  "#4a90d9", "#e8a820", "#4a9464", "#cc4444", "#aaaaaa", "#9a7a50",
] as const;


const MINIMAP_HALF_BASE = 95;
const TOTAL = BUILDINGS.length;
const PLAYER_COLLISION_XY_PAD = 1.006;
const PLAYER_COLLISION_GRID_CELL = 2.2;
const REAL_WORLD_SCALE = 1;
const MINIMAP_HALF = MINIMAP_HALF_BASE * REAL_WORLD_SCALE;
// Treasure hunt targets (in order): Dorms, Library, Tower Hall, ATM, Event Center
// IMPORTANT: The riddle text should hint, not name the target.
const HUNT_CLUES = [
  "Where nights are counted in stacked windows, follow the path to the place students rest.",
  "Where knowledge sleeps in endless rows, seek the quiet giant with many floors of pages.",
  "Where time is kept above the campus, stand near the place that watches every hour pass.",
  "Find the tiny spot that gives out cash—small outside, useful inside—near the busy walkway.",
  "Where crowds gather for big moments, look for the wide building made for events and echoes.",
] as const;
const HUNT_CODES = ["DORM42", "BOOK17", "TIME88", "CASH09", "EVENT55"] as const;
const HUNT_AREAS: Array<{ areaX: number; areaZ: number; markerX: number; markerZ: number }> = [
  // Dorms area
  { areaX: -50, areaZ: 50, markerX: -56, markerZ: 56 },
  // Library area
  { areaX: -42, areaZ: -44, markerX: -48, markerZ: -38 },
  // Tower Hall area
  { areaX: 0, areaZ: -52, markerX: 7, markerZ: -47 },
  // ATM area
  { areaX: 0, areaZ: 50, markerX: -6, markerZ: 56 },
  // Event Center area
  { areaX: 42, areaZ: 42, markerX: 42, markerZ: 67 },
];

function makeFloatingLabel(text: string): THREE.Sprite {
  const W = 512, H = 80;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(3, 3, W - 6, H - 6, 12);
  else ctx.rect(3, 3, W - 6, H - 6);
  ctx.fillStyle = "rgba(15,20,25,0.88)";
  ctx.fill();
  ctx.strokeStyle = "rgba(29,155,240,0.9)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#e7e9ea";
  ctx.font = "bold 34px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, W / 2, H / 2);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(22, 3.5, 1);
  return sprite;
}

function visibleGeometryWorldBox(root: THREE.Object3D): THREE.Box3 | null {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  let hit = false;
  root.updateMatrixWorld(true);
  root.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    const posAttr = mesh.geometry.attributes.position;
    if (!posAttr) return;
    for (let i = 0; i < posAttr.count; i++) {
      p.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      box.expandByPoint(p);
      hit = true;
    }
  });
  return hit ? box : null;
}

function buildFootprintCollisionCells(
  root: THREE.Object3D,
  cellSize: number
): THREE.Box3[] {
  const visBox = visibleGeometryWorldBox(root);
  if (!visBox) return [];
  const cells: THREE.Box3[] = [];
  const min = visBox.min, max = visBox.max;
  const pad = PLAYER_COLLISION_XY_PAD;
  for (let x = min.x; x < max.x; x += cellSize) {
    for (let z = min.z; z < max.z; z += cellSize) {
      cells.push(
        new THREE.Box3(
          new THREE.Vector3(x * pad, min.y, z * pad),
          new THREE.Vector3(Math.min(x + cellSize, max.x) * pad, max.y, Math.min(z + cellSize, max.z) * pad)
        )
      );
    }
  }
  return cells.length > 0 ? cells : [visBox];
}

export default function CampusWorld() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(0);
  const [started, setStarted] = useState(false);
  const [nearbyBuilding, setNearbyBuilding] = useState<string | null>(null);
  const [showClues, setShowClues] = useState(false);
  const [clueIndex, setClueIndex] = useState(0);
  const [huntComplete, setHuntComplete] = useState(false);
  const [showReward, setShowReward] = useState(false);
  const [rewardVideoUrl, setRewardVideoUrl] = useState<string>("");
  const [rewardTitle, setRewardTitle] = useState("Random Meme Reward");
  const [rewardLoading, setRewardLoading] = useState(false);
  const [rewardError, setRewardError] = useState<string | null>(null);
  const [dugClues, setDugClues] = useState<boolean[]>(() => Array(HUNT_CLUES.length).fill(false));
  const [foundCodes, setFoundCodes] = useState<string[]>(() => Array(HUNT_CLUES.length).fill(""));
  const [codeInput, setCodeInput] = useState("");
  const [codeFeedback, setCodeFeedback] = useState("");
  const [canDigHere, setCanDigHere] = useState(false);
  const clueIndexRef = useRef(clueIndex);
  const dugCluesRef = useRef(dugClues);
  const foundCodesRef = useRef(foundCodes);
  const huntCompleteRef = useRef(huntComplete);

  useEffect(() => { clueIndexRef.current = clueIndex; }, [clueIndex]);
  useEffect(() => { dugCluesRef.current = dugClues; }, [dugClues]);
  useEffect(() => { foundCodesRef.current = foundCodes; }, [foundCodes]);
  useEffect(() => { huntCompleteRef.current = huntComplete; }, [huntComplete]);

  async function loadRandomRewardMeme() {
    setRewardLoading(true);
    setRewardError(null);
    try {
      const res = await fetch("/api/vlipsy/random");
      if (!res.ok) throw new Error("Could not load meme");
      const data = (await res.json()) as {
        videoUrl?: string;
        title?: string;
      };
      if (!data.videoUrl) throw new Error("No video URL returned");
      setRewardVideoUrl(data.videoUrl);
      setRewardTitle(data.title || "Random Meme Reward");
    } catch {
      setRewardError("Could not fetch a random meme right now.");
    } finally {
      setRewardLoading(false);
    }
  }

  useEffect(() => {
    if (!started) return;
    const container = mountRef.current!;
    const rw = REAL_WORLD_SCALE;

    // ── Scene ──────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 160, 340);


    // ── Renderer ───────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(1);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = false;
    container.appendChild(renderer.domElement);

    // ── Camera ─────────────────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 400);

    // ── Third-person character state ────────────────────────────────────────
    const charPos = new THREE.Vector3(0, 0, 30 * rw); // start inside campus
    let charAngle = Math.PI;   // facing north toward top-row buildings
    let cameraYaw   = Math.PI; // camera behind, looking north
    let cameraPitch = 0.28;    // gentle elevation angle
    const CAM_DIST  = 10;      // pull camera back a bit more for wider view
    let charModel:   THREE.Object3D | null = null;
    let charYOffset  = 0;
    let charMixer:   THREE.AnimationMixer | null = null;
    let walkAction:  THREE.AnimationAction | null = null;
    let charMoving   = false;

    // Position camera initially behind character
    camera.position.set(0, 5, 30 * rw + CAM_DIST);
    camera.lookAt(charPos);

    // ── Mouse drag to orbit camera ──────────────────────────────────────────
    let isDragging = false;
    let lastMX = 0, lastMY = 0;
    const onMouseDown = (e: MouseEvent) => { isDragging = true; lastMX = e.clientX; lastMY = e.clientY; };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      cameraYaw   -= (e.clientX - lastMX) * 0.005;
      cameraPitch  = Math.max(0.08, Math.min(1.1, cameraPitch + (e.clientY - lastMY) * 0.005));
      lastMX = e.clientX; lastMY = e.clientY;
    };
    const onMouseUp = () => { isDragging = false; };
    renderer.domElement.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    // ── Load character model ────────────────────────────────────────────────
    {
      const texLoader = new THREE.TextureLoader();
      const charTex = texLoader.load("/api/map/character_texture.png");
      charTex.flipY = false;
      charTex.colorSpace = THREE.SRGBColorSpace;

      const charLoader = new GLTFLoader();
      charLoader.load(
        "/api/map/character_walk.glb",
        (gltf) => {
          const model = gltf.scene;
          // Apply the skin texture to every mesh
          model.traverse((child: THREE.Object3D) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            const existingMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
            // Keep existing material but inject the texture if no map set
            if (existingMat && (existingMat as THREE.MeshStandardMaterial).map == null) {
              (existingMat as THREE.MeshStandardMaterial).map = charTex;
              existingMat.needsUpdate = true;
            }
          });

          // Scale to ~1.8 units tall
          const b = new THREE.Box3().setFromObject(model);
          const sz = new THREE.Vector3(); b.getSize(sz);
          const sc = 1.8 / Math.max(sz.y, 0.01);
          model.scale.setScalar(sc);
          model.updateMatrixWorld(true);
          const b2 = new THREE.Box3().setFromObject(model);
          charYOffset = -b2.min.y; // lift so feet sit at y=0
          model.position.y = charYOffset;

          model.position.x = charPos.x;
          model.position.z = charPos.z;
          model.rotation.y = charAngle;
          scene.add(model);
          charModel = model;

          // Bind walk animation
          if (gltf.animations.length > 0) {
            charMixer = new THREE.AnimationMixer(model);
            walkAction = charMixer.clipAction(gltf.animations[0]);
            walkAction.setLoop(THREE.LoopRepeat, Infinity);
          }
        },
        undefined,
        (err) => console.warn("character_walk.glb load failed", err)
      );
    }

    // ── Lighting ───────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const sun = new THREE.DirectionalLight(0xfff5e0, 1.2);
    sun.position.set(80, 160, 80);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x87ceeb, 0x4a7c59, 0.6));

    // ── Ground ─────────────────────────────────────────────────────────────
    const BOUNDARY = 90 * rw;
    const groundOut = new THREE.Mesh(
      new THREE.PlaneGeometry(BOUNDARY * 2.5, BOUNDARY * 2.5),
      new THREE.MeshLambertMaterial({ color: 0x5b8d55 })
    );
    groundOut.rotation.x = -Math.PI / 2;
    scene.add(groundOut);

    const campusGrass = new THREE.Mesh(
      new THREE.PlaneGeometry(BOUNDARY * 2, BOUNDARY * 2),
      new THREE.MeshLambertMaterial({ color: 0x8ecb75 })
    );
    campusGrass.rotation.x = -Math.PI / 2;
    campusGrass.position.y = 0.01;
    scene.add(campusGrass);

    // ── Pond (cartoon_pond.glb) ────────────────────────────────────────────
    {
      const pondLoader = new GLTFLoader();
      pondLoader.load(
        "/api/map/cartoon_pond.glb",
        (gltf) => {
          const pondModel = gltf.scene;
          pondModel.updateMatrixWorld(true);
          const b = new THREE.Box3().setFromObject(pondModel);
          const s = new THREE.Vector3();
          b.getSize(s);
          const targetSize = 28 * rw;
          const sc = targetSize / Math.max(s.x, s.z, 0.01);
          pondModel.scale.setScalar(sc);
          pondModel.updateMatrixWorld(true);
          const b2 = new THREE.Box3().setFromObject(pondModel);
          pondModel.position.set(0, Math.max(0, -b2.min.y * sc), 0);
          pondModel.traverse((_child: THREE.Object3D) => { /* no shadows */ });
          scene.add(pondModel);
        },
        undefined,
        (err) => {
          console.warn("cartoon_pond.glb failed, using fallback", err);
          const pond = new THREE.Mesh(
            new THREE.CircleGeometry(13 * rw, 32),
            new THREE.MeshLambertMaterial({ color: 0x1a7abf })
          );
          pond.rotation.x = -Math.PI / 2;
          pond.position.set(0, 0.02, 0);
          scene.add(pond);
        }
      );
    }

    // ── Paths ──────────────────────────────────────────────────────────────
    const pathMat = new THREE.MeshLambertMaterial({ color: 0xc8b99a });
    function addPath(x1: number, z1: number, x2: number, z2: number, w = 4) {
      const dx = x2 - x1, dz = z2 - z1;
      const len = Math.sqrt(dx * dx + dz * dz);
      const geo = new THREE.PlaneGeometry(w * rw, len * rw);
      const mesh = new THREE.Mesh(geo, pathMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -Math.atan2(dx, dz);
      mesh.position.set(((x1 + x2) / 2) * rw, 0.02, ((z1 + z2) / 2) * rw);
      scene.add(mesh);
    }
    // Main spine paths
    addPath(0, -80, 0, 80, 5);          // N-S spine
    addPath(-80, 0, 80, 0, 5);          // E-W spine
    // Top row connections
    addPath(-42, -44, 0, -52, 4);       // MLK → Tower
    addPath(0, -52, 42, -44, 4);        // Tower → Macquarrie
    addPath(-50, -32, -50, 0, 4);       // MLK south to quad
    addPath(50, -32, 50, 0, 4);         // Macquarrie south to quad
    // Bottom row connections
    addPath(-50, 50, 0, 50, 4);         // Dorms → Union
    addPath(0, 50, 42, 42, 4);          // Union → Event Center
    addPath(-50, 29, -50, 0, 4);        // Dorms north to quad
    addPath(42, 26, 42, 0, 4);          // Event Center north to quad
    addPath(0, -32, 0, -52, 4);         // spine to Tower Hall


    // ── Grass tufts (crossed planes, InstancedMesh) ───────────────────────
    {
      const bladeGeo = new THREE.PlaneGeometry(0.6, 0.65);
      const bladeMats = [
        new THREE.MeshLambertMaterial({ color: 0x4ab830, side: THREE.DoubleSide }),
        new THREE.MeshLambertMaterial({ color: 0x5ecf38, side: THREE.DoubleSide }),
        new THREE.MeshLambertMaterial({ color: 0x3a9e28, side: THREE.DoubleSide }),
      ];

      // [cx, cz, half-width+padding, half-depth+padding] — generous clearance
      const bldgZones: Array<[number, number, number, number]> = [
        [-42, -44, 34, 30], [0, -52, 26, 26], [42, -44, 34, 30],
        [-50,  50, 34, 30], [0,  50, 26, 22], [42,  42, 34, 30],
      ];
      const POND_R = 18;
      const blocked = (x: number, z: number) => {
        if (x*x + z*z < POND_R * POND_R) return true;
        return bldgZones.some(([cx, cz, hw, hd]) =>
          Math.abs(x - cx) < hw && Math.abs(z - cz) < hd
        );
      };

      const grassPts: Array<[number, number]> = [];
      for (let attempt = 0; attempt < 4000 && grassPts.length < 800; attempt++) {
        const x = (Math.random() - 0.5) * 174;
        const z = (Math.random() - 0.5) * 174;
        if (Math.abs(x) > 87 || Math.abs(z) > 87) continue;
        if (blocked(x, z)) continue;
        grassPts.push([x, z]);
      }

      const dummy = new THREE.Object3D();
      // Two crossed blades per tuft — 3 colour variants as separate InstancedMesh
      [0, 1, 2].forEach(ci => {
        const slice = grassPts.filter((_, i) => i % 3 === ci);
        [0, Math.PI / 2].forEach(ry => {
          const iMesh = new THREE.InstancedMesh(bladeGeo, bladeMats[ci], slice.length);
          slice.forEach(([x, z], i) => {
            const h = 0.28 + (i % 7) * 0.06;
            dummy.position.set(x * rw, h * 0.5, z * rw);
            dummy.rotation.set(0, ry + i * 0.55, 0);
            dummy.scale.set(0.7 + (i % 4) * 0.1, h / 0.65, 1);
            dummy.updateMatrix();
            iMesh.setMatrixAt(i, dummy.matrix);
          });
          iMesh.instanceMatrix.needsUpdate = true;
          scene.add(iMesh);
        });
      });
    }

    // ── Collision store ────────────────────────────────────────────────────
    const colliderCells: THREE.Box3[][] = [];
    const digMarkers: THREE.Group[] = [];
    const chests: THREE.Group[] = [];

    // ── Treasure markers + chests (hidden by default) ─────────────────────
    HUNT_AREAS.forEach((loc) => {
      const marker = new THREE.Group();
      const xMat = new THREE.MeshLambertMaterial({ color: 0xd92f2f });
      const xBar1 = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.22, 0.22), xMat);
      const xBar2 = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.22, 0.22), xMat);
      xBar1.rotation.z = Math.PI / 4;
      xBar2.rotation.z = -Math.PI / 4;
      marker.add(xBar1, xBar2);
      // Lift the marker so it doesn't get lost in grass.
      marker.position.set(loc.markerX * rw, 1.25, loc.markerZ * rw);
      marker.visible = false;
      scene.add(marker);
      digMarkers.push(marker);

      const chest = new THREE.Group();
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.8, 1.0),
        new THREE.MeshLambertMaterial({ color: 0x7a4a1d })
      );
      base.position.y = 0.4;
      const lid = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.4, 1.0),
        new THREE.MeshLambertMaterial({ color: 0x9c6a2d })
      );
      lid.position.y = 1.0;
      chest.add(base, lid);
      chest.position.set(loc.markerX * rw, 0, loc.markerZ * rw);
      chest.visible = false;
      scene.add(chest);
      chests.push(chest);
    });

    // ── Low-poly trees around the campus perimeter ────────────────────────
    {
      // Geometries — flat shading gives the faceted low-poly look
      const trunkGeo  = new THREE.CylinderGeometry(0.14, 0.22, 2.6, 5);
      const blob0Geo  = new THREE.IcosahedronGeometry(1.9, 1); // main canopy
      const blob1Geo  = new THREE.IcosahedronGeometry(1.3, 1); // left cluster
      const blob2Geo  = new THREE.IcosahedronGeometry(1.15, 1); // right cluster
      const blob3Geo  = new THREE.IcosahedronGeometry(1.0, 1);  // top tuft
      [trunkGeo, blob0Geo, blob1Geo, blob2Geo, blob3Geo].forEach(g => {
        // Flat shading requires recomputed normals after duplication
        g.computeVertexNormals();
      });

      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a4f2c, flatShading: true });
      const mat0     = new THREE.MeshLambertMaterial({ color: 0x3aaf3a, flatShading: true });
      const mat1     = new THREE.MeshLambertMaterial({ color: 0x5dcf2a, flatShading: true });
      const mat2     = new THREE.MeshLambertMaterial({ color: 0x29943c, flatShading: true });
      const mat3     = new THREE.MeshLambertMaterial({ color: 0x6ed63e, flatShading: true });

      // Random scatter in perimeter band (76–87 units from center)
      // buildings stay within ±74 so trees at 76+ never overlap
      const pts: Array<[number, number]> = [];
      const rand = (a: number, b: number) => a + Math.random() * (b - a);

      const POND_R_TREE = 19;
      const bldgZonesT: Array<[number, number, number, number]> = [
        [-42, -44, 36, 32], [0, -52, 28, 28], [42, -44, 36, 32],
        [-50,  50, 36, 32], [0,  50, 28, 24], [42,  42, 36, 32],
      ];
      const treeBlocked = (x: number, z: number) => {
        if (x*x + z*z < POND_R_TREE * POND_R_TREE) return true;
        return bldgZonesT.some(([cx, cz, hw, hd]) =>
          Math.abs(x - cx) < hw && Math.abs(z - cz) < hd
        );
      };

      // Perimeter band (76–87) — random scatter
      for (let i = 0; i < 320; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = rand(76, 87);
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        if (Math.abs(x) > 88 || Math.abs(z) > 88) continue;
        pts.push([x, z]);
      }

      // Interior campus — random scatter avoiding buildings & pond
      for (let i = 0; i < 500; i++) {
        const x = rand(-72, 72);
        const z = rand(-72, 72);
        if (treeBlocked(x, z)) continue;
        pts.push([x, z]);
      }

      const N = pts.length;
      const dummy = new THREE.Object3D();

      // Per-part offsets relative to tree base: [dx, dy, dz, scaleMultiplier]
      type BlobDef = [THREE.BufferGeometry, THREE.MeshLambertMaterial, number, number, number, number];
      const parts: BlobDef[] = [
        [trunkGeo, trunkMat,  0,    1.3,  0,    1.0  ],
        [blob0Geo, mat0,      0.1,  4.2,  0.1,  1.0  ],
        [blob1Geo, mat1,     -1.3,  3.5, -0.2,  0.78 ],
        [blob2Geo, mat2,      1.1,  3.3,  0.6,  0.72 ],
        [blob3Geo, mat3,      0.3,  5.3, -0.5,  0.65 ],
      ];

      parts.forEach(([geo, mat, dx, dy, dz, sm]) => {
        const iMesh = new THREE.InstancedMesh(geo, mat, N);
        pts.forEach(([x, z], i) => {
          const sc = (0.88 + (i % 6) * 0.04) * sm;
          dummy.position.set(x * rw + dx * sc, dy * sc, z * rw + dz * sc);
          dummy.rotation.set(0, i * 1.9, 0);
          dummy.scale.setScalar(sc);
          dummy.updateMatrix();
          iMesh.setMatrixAt(i, dummy.matrix);
        });
        iMesh.instanceMatrix.needsUpdate = true;
        scene.add(iMesh);
      });
    }

    // ── Load buildings ─────────────────────────────────────────────────────
    const loader = new GLTFLoader();
    const meshList: Array<{ object: THREE.Object3D; name: string }> = [];
    let loadedCount = 0;

    BUILDINGS.forEach((cfg, idx) => {
      loader.load(
        `/models/${cfg.file}`,
        (gltf) => {
          const group = new THREE.Group();
          const model = gltf.scene;
          model.updateMatrixWorld(true);
          // Strip embedded floor/ground planes baked into the GLB
          model.traverse((child: THREE.Object3D) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh || !mesh.geometry) return;
            const name = mesh.name.toLowerCase();
            if (
              name.includes("floor") || name.includes("ground") ||
              name.includes("base")  || name.includes("terrain") ||
              name.includes("plane") || name.includes("slab") ||
              name.includes("pavement") || name.includes("concrete") ||
              name.includes("road") || name.includes("asphalt") ||
              name.includes("sidewalk") || name.includes("surface")
            ) {
              mesh.visible = false;
              return;
            }
            // Catch unnamed flat slabs: very thin in Y but wide in X and Z
            const box = new THREE.Box3().setFromObject(mesh);
            const size = new THREE.Vector3();
            box.getSize(size);
            if (size.y < 0.5 && size.x > 2 && size.z > 2) {
              mesh.visible = false;
            }
          });

          const rawBox = new THREE.Box3().setFromObject(model);
          const rawSize = new THREE.Vector3();
          rawBox.getSize(rawSize);

          const scaleX  = (cfg.targetWidth * rw) / Math.max(rawSize.x, 0.01);
          const scaleZ  = (cfg.targetDepth * rw) / Math.max(rawSize.z, 0.01);
          const xzScale = Math.min(scaleX, scaleZ);
          model.scale.set(xzScale, xzScale * cfg.heightScale, xzScale);

          model.updateMatrixWorld(true);
          const scaledBox = new THREE.Box3().setFromObject(model);

          // Centre the model in X/Z so it sits exactly at (cfg.x, cfg.z)
          const centreBox = new THREE.Box3().setFromObject(model);
          const centreVec = new THREE.Vector3();
          centreBox.getCenter(centreVec);
          model.position.x -= centreVec.x;
          model.position.z -= centreVec.z;

          // Ground the model — shift up so lowest vertex is at y=0
          model.updateMatrixWorld(true);
          let trueMinY = Infinity;
          model.traverse((child: THREE.Object3D) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh || !mesh.geometry) return;
            const pos = mesh.geometry.attributes.position;
            if (!pos) return;
            const wp = new THREE.Vector3();
            for (let i = 0; i < pos.count; i++) {
              wp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
              if (wp.y < trueMinY) trueMinY = wp.y;
            }
          });
          if (isFinite(trueMinY)) model.position.y -= trueMinY;

          // Shadows disabled for performance

          group.add(model);
          group.rotation.y = cfg.rotationY;
          group.position.set(cfg.x * rw, 0, cfg.z * rw);
          scene.add(group);

          // Label
          const labelY = scaledBox.max.y + 3;
          const label = makeFloatingLabel(cfg.name);
          label.position.set(cfg.x * rw, labelY, cfg.z * rw);
          scene.add(label);

          // Collision cells
          group.updateMatrixWorld(true);
          const cells = buildFootprintCollisionCells(group, PLAYER_COLLISION_GRID_CELL * rw);
          colliderCells[idx] = cells.length > 0 ? cells : (() => {
            const fb = new THREE.Box3().setFromObject(group);
            return [fb];
          })();

          meshList.push({ object: group, name: cfg.name });
          loadedCount++;
          setLoaded(loadedCount);
        },
        undefined,
        (err) => {
          console.warn(`Failed to load ${cfg.file}`, err);
          loadedCount++;
          setLoaded(loadedCount);
        }
      );
    });

    // ── Input ──────────────────────────────────────────────────────────────
    const keys: Record<string, boolean> = {};
    const onKey = (e: KeyboardEvent, down: boolean) => { keys[e.code] = down; };
    window.addEventListener("keydown", (e) => onKey(e, true));
    window.addEventListener("keyup", (e) => onKey(e, false));

    // ── Lightweight footstep SFX (procedural, no asset file) ───────────────
    let audioCtx: AudioContext | null = null;
    let stepTimer = 0;
    let audioPrimed = false;
    const playUnlockPing = () => {
      if (!audioCtx) return;
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(780, now + 0.08);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.13);
    };
    const playJumpSfx = () => {
      const ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === "suspended") return;
      const now = ctx.currentTime;

      // Mario-like upward chirp.
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      const hp = ctx.createBiquadFilter();

      osc1.type = "square";
      osc2.type = "triangle";
      osc1.frequency.setValueAtTime(520, now);
      osc1.frequency.exponentialRampToValueAtTime(980, now + 0.1);
      osc2.frequency.setValueAtTime(260, now);
      osc2.frequency.exponentialRampToValueAtTime(490, now + 0.1);

      hp.type = "highpass";
      hp.frequency.setValueAtTime(140, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(hp).connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.17);
      osc2.stop(now + 0.17);
    };
    const ensureAudio = () => {
      if (audioCtx) return audioCtx;
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      return audioCtx;
    };
    const tryResumeAudio = () => {
      const ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === "suspended") void ctx.resume();
      if (!audioPrimed && ctx.state === "running") {
        audioPrimed = true;
        playUnlockPing();
      }
    };
    const playFootstep = () => {
      const ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === "suspended") return;
      const now = ctx.currentTime;

      // Small randomization keeps repeated steps from sounding robotic.
      const thumpHz = 70 + Math.random() * 16;
      const toeHz = 120 + Math.random() * 28;
      const pan = (Math.random() - 0.5) * 0.35;
      const stepDur = 0.16;

      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.28, now + 0.01);
      master.gain.exponentialRampToValueAtTime(0.0001, now + stepDur);

      const panner = "createStereoPanner" in ctx ? ctx.createStereoPanner() : null;
      if (panner) panner.pan.value = pan;

      // Heel thump (low, short)
      const heelOsc = ctx.createOscillator();
      const heelGain = ctx.createGain();
      heelOsc.type = "sine";
      heelOsc.frequency.setValueAtTime(thumpHz, now);
      heelOsc.frequency.exponentialRampToValueAtTime(thumpHz * 0.62, now + 0.05);
      heelGain.gain.setValueAtTime(0.0001, now);
      heelGain.gain.exponentialRampToValueAtTime(0.36, now + 0.008);
      heelGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);

      // Toe follow-through (slightly higher and delayed)
      const toeOsc = ctx.createOscillator();
      const toeGain = ctx.createGain();
      toeOsc.type = "triangle";
      toeOsc.frequency.setValueAtTime(toeHz, now + 0.02);
      toeOsc.frequency.exponentialRampToValueAtTime(toeHz * 0.72, now + 0.095);
      toeGain.gain.setValueAtTime(0.0001, now);
      toeGain.gain.exponentialRampToValueAtTime(0.19, now + 0.03);
      toeGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

      // Filtered scrape texture (shoe/ground contact)
      const noise = ctx.createBufferSource();
      const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * stepDur), ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      noise.buffer = noiseBuf;
      const noiseBand = ctx.createBiquadFilter();
      noiseBand.type = "bandpass";
      noiseBand.frequency.setValueAtTime(500 + Math.random() * 200, now);
      noiseBand.Q.value = 0.7;
      const noiseHigh = ctx.createBiquadFilter();
      noiseHigh.type = "highpass";
      noiseHigh.frequency.setValueAtTime(110, now);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.1, now + 0.016);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

      const out = panner ?? master;
      if (panner) {
        master.connect(panner).connect(ctx.destination);
      } else {
        master.connect(ctx.destination);
      }
      heelOsc.connect(heelGain).connect(master);
      toeOsc.connect(toeGain).connect(master);
      noise.connect(noiseBand).connect(noiseHigh).connect(noiseGain).connect(master);

      heelOsc.start(now);
      toeOsc.start(now + 0.015);
      noise.start(now);
      heelOsc.stop(now + 0.09);
      toeOsc.stop(now + 0.12);
      noise.stop(now + 0.13);

      // Keep TypeScript happy when out variable is optimized away.
      void out;
    };
    window.addEventListener("keydown", tryResumeAudio);
    renderer.domElement.addEventListener("mousedown", tryResumeAudio);
    window.addEventListener("pointerdown", tryResumeAudio);
    window.addEventListener("touchstart", tryResumeAudio, { passive: true });

    const PLAYER_R     = 0.38 * rw;
    const PLAYER_SPEED = 8   * rw;
    const GRAVITY      = -18 * rw;
    let velY     = 0;
    let onGround = true;

    const playerSphere = new THREE.Sphere(new THREE.Vector3(), PLAYER_R);

    const POND_COLLIDE_R = 14;
    function playerBlockedAtXZ(x: number, z: number): boolean {
      if (x * x + z * z < (POND_COLLIDE_R + PLAYER_R) * (POND_COLLIDE_R + PLAYER_R)) return true;
      const testSphere = new THREE.Sphere(new THREE.Vector3(x, charPos.y, z), PLAYER_R);
      for (const cells of colliderCells) {
        if (!cells) continue;
        for (const cell of cells) {
          if (cell.intersectsSphere(testSphere)) return true;
        }
      }
      return false;
    }

    // ── Minimap canvas ─────────────────────────────────────────────────────
    const mmSize = 160;
    const mmCanvas = document.createElement("canvas");
    mmCanvas.width = mmSize; mmCanvas.height = mmSize;
    mmCanvas.style.cssText = `position:fixed;bottom:16px;right:16px;border-radius:50%;border:2px solid rgba(255,255,255,0.4);opacity:0.85;pointer-events:none;`;
    document.body.appendChild(mmCanvas);
    const mmCtx = mmCanvas.getContext("2d")!;

    function drawMinimap() {
      mmCtx.clearRect(0, 0, mmSize, mmSize);
      mmCtx.save();
      mmCtx.beginPath();
      mmCtx.arc(mmSize / 2, mmSize / 2, mmSize / 2, 0, Math.PI * 2);
      mmCtx.clip();
      mmCtx.fillStyle = "#1a3a1a";
      mmCtx.fillRect(0, 0, mmSize, mmSize);

      const toMM = (wx: number, wz: number) => ({
        x: (wx / MINIMAP_HALF) * (mmSize / 2) + mmSize / 2,
        y: (wz / MINIMAP_HALF) * (mmSize / 2) + mmSize / 2,
      });

      // buildings
      BUILDINGS.forEach((cfg, i) => {
        const { x, y } = toMM(cfg.x * rw, cfg.z * rw);
        mmCtx.fillStyle = MINIMAP_DOT[i % MINIMAP_DOT.length];
        mmCtx.beginPath();
        mmCtx.arc(x, y, 5, 0, Math.PI * 2);
        mmCtx.fill();
      });

      // player
      const { x: px, y: pz } = toMM(charPos.x, charPos.z);
      mmCtx.fillStyle = "#ff4444";
      mmCtx.beginPath();
      mmCtx.arc(px, pz, 4, 0, Math.PI * 2);
      mmCtx.fill();
      // direction tick
      mmCtx.strokeStyle = "#ff4444";
      mmCtx.lineWidth = 2;
      mmCtx.beginPath();
      mmCtx.moveTo(px, pz);
      mmCtx.lineTo(px + Math.sin(charAngle) * 8, pz + Math.cos(charAngle) * 8);
      mmCtx.stroke();

      mmCtx.restore();
    }

    // ── Nearby building detection ───────────────────────────────────────────
    let nearbyTimer = 0;
    function checkNearby() {
      let closest: string | null = null;
      let closestD = 30 * rw;
      meshList.forEach(({ object, name }) => {
        const d = charPos.distanceTo((object as THREE.Group).position);
        if (d < closestD) { closestD = d; closest = name; }
      });
      setNearbyBuilding(closest);
    }

    // ── Resize ─────────────────────────────────────────────────────────────
    const onResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", onResize);

    // ── Animation loop ─────────────────────────────────────────────────────
    const clock = new THREE.Clock();
    let animId: number;
    let eDownLastFrame = false;
    let digPromptLast = false;

    // Pre-allocated reusable vectors
    const _forward = new THREE.Vector3();
    let _mmFrame = 0;

    function animate() {
      animId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);

      // ── Character movement ──────────────────────────────────────────────
      const sprint = keys["ShiftLeft"] || keys["ShiftRight"];
      const speed  = (sprint ? 16 : PLAYER_SPEED) * dt;

      let mx = 0, mz = 0;
      if (keys["KeyW"] || keys["ArrowUp"])    { mx += Math.sin(cameraYaw);  mz += Math.cos(cameraYaw);  }
      if (keys["KeyS"] || keys["ArrowDown"])  { mx -= Math.sin(cameraYaw);  mz -= Math.cos(cameraYaw);  }
      if (keys["KeyA"] || keys["ArrowLeft"])  { mx += Math.cos(cameraYaw);  mz -= Math.sin(cameraYaw);  }
      if (keys["KeyD"] || keys["ArrowRight"]) { mx -= Math.cos(cameraYaw);  mz += Math.sin(cameraYaw);  }

      const moving = mx !== 0 || mz !== 0;
      if (moving) {
        const len = Math.sqrt(mx * mx + mz * mz);
        mx = (mx / len) * speed;
        mz = (mz / len) * speed;

        const nx = charPos.x + mx;
        const nz = charPos.z + mz;
        const inBounds = Math.abs(nx) < BOUNDARY && Math.abs(nz) < BOUNDARY;
        if (inBounds && !playerBlockedAtXZ(nx, charPos.z)) charPos.x = nx;
        if (inBounds && !playerBlockedAtXZ(charPos.x, nz)) charPos.z = nz;

        charAngle = Math.atan2(mx, mz); // face movement direction
      }

      // Footsteps while walking on ground
      if (moving && onGround) {
        stepTimer += dt;
        const stepInterval = sprint ? 0.22 : 0.32;
        if (stepTimer >= stepInterval) {
          stepTimer = 0;
          playFootstep();
        }
      } else {
        stepTimer = 0;
      }
      // Debug fallback: press T to force a test step sound.
      if (keys["KeyT"]) playFootstep();

      // Gravity & jump
      if (keys["Space"] && onGround) {
        velY = 6 * rw;
        onGround = false;
        playJumpSfx();
      }
      velY += GRAVITY * dt;
      charPos.y += velY * dt;
      if (charPos.y <= 0) { charPos.y = 0; velY = 0; onGround = true; }

      // Boundary clamp
      charPos.x = Math.max(-BOUNDARY + 1, Math.min(BOUNDARY - 1, charPos.x));
      charPos.z = Math.max(-BOUNDARY + 1, Math.min(BOUNDARY - 1, charPos.z));

      playerSphere.center.copy(charPos);

      // ── Treasure hunt world logic ───────────────────────────────────────
      const current = clueIndexRef.current;
      if (!huntCompleteRef.current && current < HUNT_AREAS.length) {
        const step = HUNT_AREAS[current];
        const dxArea = charPos.x - step.areaX;
        const dzArea = charPos.z - step.areaZ;
        // Easier: reveal marker from farther away
        const reachedArea = (dxArea * dxArea + dzArea * dzArea) < (24 * 24);

        // Only reveal current clue's hidden X when player reaches clue area.
        digMarkers.forEach((m, i) => { if (!dugCluesRef.current[i]) m.visible = false; });
        if (reachedArea && !dugCluesRef.current[current]) digMarkers[current].visible = true;

        const dxMark = charPos.x - step.markerX;
        const dzMark = charPos.z - step.markerZ;
        // Easier: allow digging from farther away
        const nearMarker = (dxMark * dxMark + dzMark * dzMark) < (7.5 * 7.5);
        const canDigNow = reachedArea && nearMarker && !dugCluesRef.current[current];
        if (canDigNow !== digPromptLast) {
          digPromptLast = canDigNow;
          setCanDigHere(canDigNow);
        }

        const eDown = !!keys["KeyE"];
        if (canDigNow && eDown && !eDownLastFrame) {
          const nextDug = [...dugCluesRef.current];
          const nextCodes = [...foundCodesRef.current];
          nextDug[current] = true;
          nextCodes[current] = HUNT_CODES[current];
          dugCluesRef.current = nextDug;
          foundCodesRef.current = nextCodes;
          setDugClues(nextDug);
          setFoundCodes(nextCodes);
          setCodeFeedback(`Chest found. Code discovered for clue ${current + 1}.`);
          digMarkers[current].visible = false;
          chests[current].visible = true;
        }
        eDownLastFrame = eDown;
      } else {
        if (digPromptLast) {
          digPromptLast = false;
          setCanDigHere(false);
        }
      }

      // ── Update character mesh ───────────────────────────────────────────
      if (charModel) {
        charModel.position.set(charPos.x, charPos.y + charYOffset, charPos.z);
        charModel.rotation.y = charAngle;
      }

      // ── Walk animation ──────────────────────────────────────────────────
      if (charMixer) {
        if (moving && !charMoving) { walkAction?.play();  charMoving = true;  }
        if (!moving && charMoving) { walkAction?.stop();  charMoving = false; }
        charMixer.update(dt);
      }

      // ── Third-person camera ─────────────────────────────────────────────
      const camX = charPos.x - Math.sin(cameraYaw) * Math.cos(cameraPitch) * CAM_DIST;
      const camY = charPos.y + Math.sin(cameraPitch) * CAM_DIST + 1.4;
      const camZ = charPos.z - Math.cos(cameraYaw) * Math.cos(cameraPitch) * CAM_DIST;
      camera.position.set(camX, camY, camZ);
      camera.lookAt(charPos.x, charPos.y + charYOffset + 1.0, charPos.z);
      _forward.set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));

      nearbyTimer += dt;
      if (nearbyTimer > 0.5) { checkNearby(); nearbyTimer = 0; }

      _mmFrame++;
      if (_mmFrame % 4 === 0) drawMinimap();

      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("keydown", (e) => onKey(e, true));
      window.removeEventListener("keyup", (e) => onKey(e, false));
      window.removeEventListener("keydown", tryResumeAudio);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      renderer.domElement.removeEventListener("mousedown", tryResumeAudio);
      window.removeEventListener("pointerdown", tryResumeAudio);
      window.removeEventListener("touchstart", tryResumeAudio);
      if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      if (document.body.contains(mmCanvas)) document.body.removeChild(mmCanvas);
    };
  }, [started]);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", position: "relative", overflow: "hidden", fontFamily: "Inter, Segoe UI, Arial, sans-serif" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "radial-gradient(circle at 15% 15%, rgba(100,170,255,0.16), transparent 34%), radial-gradient(circle at 85% 18%, rgba(118,78,255,0.12), transparent 30%), linear-gradient(180deg, rgba(3,7,14,0.08), rgba(3,7,14,0.4))",
        }}
      />

      {/* Title */}
      <div style={{
        position: "absolute",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        background: "linear-gradient(180deg, rgba(13,20,33,0.9), rgba(8,13,23,0.78))",
        color: "#eef6ff",
        padding: "10px 20px",
        borderRadius: 14,
        border: "1px solid rgba(132,178,255,0.35)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        fontSize: 14,
        fontWeight: 700,
        letterSpacing: 0.2,
        pointerEvents: "none",
        whiteSpace: "nowrap",
        backdropFilter: "blur(5px)",
      }}>
        San José State University — 3D Campus
      </div>

      {/* HUD corner chips */}
      {started && (
        <>
          <div style={{
            position: "absolute",
            top: 16,
            left: 16,
            background: "linear-gradient(160deg, rgba(16,29,46,0.9), rgba(7,13,22,0.82))",
            color: "#b8cdf3",
            border: "1px solid rgba(123,163,233,0.36)",
            borderRadius: 12,
            padding: "8px 10px",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.2,
            backdropFilter: "blur(5px)",
            pointerEvents: "none",
          }}>
            CAMPUS HUNT
          </div>
          <div style={{
            position: "absolute",
            top: 56,
            left: 16,
            background: "rgba(8,14,24,0.78)",
            color: "#9eb8df",
            border: "1px solid rgba(128,160,214,0.28)",
            borderRadius: 10,
            padding: "7px 10px",
            fontSize: 12,
            pointerEvents: "none",
          }}>
            Objective: Solve all clues
          </div>
        </>
      )}

      {/* Start overlay */}
      {!started && (
        <div style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "radial-gradient(circle at 50% 35%, rgba(50,95,160,0.22), rgba(2,6,14,0.9) 58%)",
          color: "#fff",
          gap: 14,
        }}>
          <h1 style={{ fontSize: 34, fontWeight: 800, marginBottom: 2 }}>Campus Hunt</h1>
          <p style={{ color: "#b8c8e1", fontSize: 15, margin: 0 }}>San José State University · 3D Treasure Adventure</p>
          <button
            onClick={() => setStarted(true)}
            style={{
              marginTop: 10,
              padding: "12px 34px",
              background: "linear-gradient(135deg, #2997ff, #1a75ff)",
              color: "#fff",
              border: "1px solid rgba(180,220,255,0.35)",
              borderRadius: 12,
              fontSize: 16,
              cursor: "pointer",
              fontWeight: 700,
              boxShadow: "0 12px 26px rgba(21,99,210,0.45)",
            }}
          >
            Enter Campus
          </button>
        </div>
      )}

      {/* Loading bar */}
      {started && loaded < TOTAL && (
        <div style={{
          position: "absolute",
          bottom: 28,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(8,14,24,0.82)",
          color: "#dce9ff",
          padding: "10px 18px",
          borderRadius: 12,
          border: "1px solid rgba(141,174,231,0.32)",
          fontSize: 13,
          backdropFilter: "blur(4px)",
        }}>
          Loading campus… {loaded}/{TOTAL}
        </div>
      )}

      {/* Controls hint */}
      {started && (
        <div style={{
          position: "absolute",
          bottom: 82,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(8,12,20,0.72)",
          color: "#d2def2",
          padding: "8px 16px",
          borderRadius: 999,
          border: "1px solid rgba(129,161,220,0.28)",
          fontSize: 13,
          pointerEvents: "none",
          whiteSpace: "nowrap",
          backdropFilter: "blur(4px)",
        }}>
          WASD to move · Shift to sprint · Space to jump · Drag to orbit camera
        </div>
      )}

      {/* Clues button */}
      {started && !showClues && !huntComplete && (
        <button
          onClick={() => setShowClues(true)}
          style={{
            position: "absolute",
            right: 16,
            top: 16,
            background: "linear-gradient(180deg, rgba(28,54,91,0.95), rgba(15,27,48,0.92))",
            color: "#fff",
            border: "1px solid rgba(148,193,255,0.66)",
            borderRadius: 12,
            padding: "10px 15px",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "0 10px 26px rgba(8,26,54,0.5)",
            backdropFilter: "blur(6px)",
          }}
        >
          Open Clues
        </button>
      )}

      {/* Phone-shaped treasure hunt UI */}
      {started && showClues && (
        <div style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.58)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          zIndex: 20,
        }}>
          <div style={{
            width: 340,
            maxWidth: "88vw",
            borderRadius: 36,
            background: "linear-gradient(180deg, #121d2c 0%, #0a121d 100%)",
            border: "2px solid rgba(103,145,208,0.5)",
            boxShadow: "0 20px 55px rgba(0,0,0,0.62)",
            padding: "22px 18px 18px",
            position: "relative",
            color: "#e9efff",
          }}>
            <div style={{
              width: 92,
              height: 10,
              borderRadius: 999,
              background: "#0b131d",
              border: "1px solid #263850",
              margin: "0 auto 14px",
            }} />
            <button
              onClick={() => setShowClues(false)}
              style={{
                position: "absolute",
                top: 14,
                right: 14,
                border: "none",
                width: 28,
                height: 28,
                borderRadius: 999,
                background: "#203146",
                color: "#d8e6ff",
                cursor: "pointer",
                fontWeight: 700,
              }}
              aria-label="Close clues"
            >
              X
            </button>

            <div style={{ fontSize: 13, color: "#9cb5da", marginBottom: 6, fontWeight: 700, letterSpacing: 0.3 }}>
              Treasure Hunt
            </div>
            <div style={{ fontSize: 12, color: "#7f96b8", marginBottom: 14, fontWeight: 600 }}>
              Clue {Math.min(clueIndex + 1, HUNT_CLUES.length)} of {HUNT_CLUES.length}
            </div>
            <div style={{
              height: 7,
              width: "100%",
              borderRadius: 999,
              background: "rgba(255,255,255,0.09)",
              marginBottom: 14,
              overflow: "hidden",
              border: "1px solid rgba(132,165,220,0.24)",
            }}>
              <div style={{
                width: `${((Math.min(clueIndex + 1, HUNT_CLUES.length)) / HUNT_CLUES.length) * 100}%`,
                height: "100%",
                background: "linear-gradient(90deg, #3a9bff, #79b6ff)",
              }} />
            </div>
            <div style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(140,177,230,0.35)",
              borderRadius: 14,
              padding: "14px 12px",
              lineHeight: 1.45,
              fontSize: 14,
              minHeight: 110,
            }}>
              {HUNT_CLUES[clueIndex]}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#9cb5da" }}>
              {dugClues[clueIndex]
                ? `Chest opened. Enter code for clue ${clueIndex + 1}.`
                : "Reach the area, find the hidden X, then press E to dig."}
            </div>
            {foundCodes[clueIndex] && (
              <div style={{ marginTop: 8, fontSize: 13, color: "#ffd66e", fontWeight: 700 }}>
                Found code: {foundCodes[clueIndex]}
              </div>
            )}
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder="Enter clue code"
              style={{
                marginTop: 10,
                width: "100%",
                borderRadius: 8,
                border: "1px solid rgba(150,170,210,0.4)",
                background: "rgba(8,12,20,0.9)",
                color: "#eaf1ff",
                padding: "10px 11px",
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              onClick={() => {
                if (!dugClues[clueIndex]) {
                  setCodeFeedback("You need to dig up this clue's chest first.");
                  return;
                }
                const expected = HUNT_CODES[clueIndex];
                if (codeInput.trim().toUpperCase() !== expected) {
                  setCodeFeedback("Incorrect code. Try again.");
                  return;
                }
                setCodeInput("");
                setCodeFeedback("Code accepted.");
                if (clueIndex + 1 >= HUNT_CLUES.length) {
                  setHuntComplete(true);
                  setShowClues(false);
                } else {
                  setClueIndex(clueIndex + 1);
                }
              }}
              style={{
                marginTop: 12,
                width: "100%",
                border: "none",
                borderRadius: 10,
                padding: "10px 12px",
                background: "linear-gradient(135deg, #2f80ed, #1f66d9)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                boxShadow: "0 8px 20px rgba(37,106,218,0.35)",
              }}
            >
              {clueIndex + 1 >= HUNT_CLUES.length ? "Complete Hunt" : "Unlock Next Clue"}
            </button>
            {codeFeedback && (
              <div style={{
                marginTop: 10,
                fontSize: 12,
                color: "#d7e8ff",
                background: "rgba(85,129,192,0.18)",
                border: "1px solid rgba(120,167,236,0.24)",
                borderRadius: 8,
                padding: "7px 8px",
              }}>
                {codeFeedback}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Final completion screen */}
      {started && huntComplete && !showReward && (
        <div style={{
          position: "absolute",
          inset: 0,
          background: "rgba(2,8,16,0.8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 30,
        }}>
          <div style={{
            width: 420,
            maxWidth: "90vw",
            background: "linear-gradient(180deg, #101c30, #0a1322)",
            border: "1px solid rgba(120,170,255,0.52)",
            borderRadius: 20,
            padding: "24px 20px",
            textAlign: "center",
            color: "#eaf1ff",
            boxShadow: "0 18px 45px rgba(0,0,0,0.48)",
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
              Hunt Complete ✨
            </div>
            <div style={{ fontSize: 14, color: "#a9bddb", marginBottom: 16 }}>
              You solved all 5 clues and unlocked the final reward.
            </div>
            <button
              onClick={async () => {
                setShowReward(true);
                await loadRandomRewardMeme();
              }}
              style={{
                border: "none",
                borderRadius: 10,
                padding: "11px 18px",
                background: "linear-gradient(135deg, #2d9eff, #1f73e8)",
                color: "#fff",
                fontSize: 14,
                fontWeight: 800,
                cursor: "pointer",
                boxShadow: "0 10px 24px rgba(27,111,224,0.4)",
              }}
            >
              Claim Reward
            </button>
          </div>
        </div>
      )}

      {/* Rickroll reveal */}
      {started && showReward && (
        <div style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.9)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          zIndex: 40,
        }}>
          <div style={{ color: "#f2f7ff", fontSize: 24, fontWeight: 900, letterSpacing: 0.3 }}>
            Achievement Unlocked 🏆
          </div>
          <div style={{ color: "#a7c3ee", fontSize: 13, marginTop: -6 }}>
            {rewardTitle}
          </div>
          {rewardLoading && (
            <div style={{ color: "#d7e8ff", fontSize: 14 }}>Loading random meme...</div>
          )}
          {!rewardLoading && rewardError && (
            <div style={{
              color: "#ffd2d2",
              fontSize: 13,
              background: "rgba(140,35,35,0.3)",
              border: "1px solid rgba(230,120,120,0.45)",
              padding: "8px 10px",
              borderRadius: 8,
            }}>
              {rewardError}
            </div>
          )}
          {!rewardLoading && !rewardError && rewardVideoUrl && (
            <video
              src={rewardVideoUrl}
              controls
              autoPlay
              loop
              playsInline
              style={{
                width: "min(900px, 92vw)",
                maxHeight: "70vh",
                borderRadius: 14,
                border: "2px solid rgba(255,255,255,0.28)",
                background: "#000",
                boxShadow: "0 18px 40px rgba(0,0,0,0.5)",
              }}
            />
          )}
          <button
            onClick={loadRandomRewardMeme}
            style={{
              marginTop: 2,
              border: "none",
              borderRadius: 8,
              padding: "8px 14px",
              background: "linear-gradient(180deg, #2a67c5, #1f4f97)",
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            Randomize Meme
          </button>
          <button
            onClick={() => setShowReward(false)}
            style={{
              marginTop: 4,
              border: "none",
              borderRadius: 8,
              padding: "8px 14px",
              background: "linear-gradient(180deg, #2f3f58, #223148)",
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Close
          </button>
        </div>
      )}

      {/* Nearby building */}
      {nearbyBuilding && (
        <div style={{
          position: "absolute",
          top: 62,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(8,13,21,0.75)",
          color: "#f3f8ff",
          padding: "6px 14px",
          borderRadius: 10,
          border: "1px solid rgba(134,171,236,0.3)",
          fontSize: 13,
          pointerEvents: "none",
          backdropFilter: "blur(4px)",
        }}>
          📍 {nearbyBuilding}
        </div>
      )}

      {/* Dig interaction prompt */}
      {started && canDigHere && (
        <div style={{
          position: "absolute",
          bottom: 118,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(16,14,5,0.72)",
          color: "#ffe27a",
          padding: "8px 14px",
          borderRadius: 10,
          border: "1px solid rgba(255,210,88,0.38)",
          fontSize: 13,
          pointerEvents: "none",
          zIndex: 12,
        }}>
          X marks the spot - Press E to dig
        </div>
      )}
    </div>
  );
}
