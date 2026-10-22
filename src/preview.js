import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { startBlowDetector } from './blow.js';

const root = document.querySelector('#preview');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x07120d, 1);
root.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07120d);
scene.fog = new THREE.Fog(0x07120d, 4, 10);
const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 0.88, 3.1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.58, 0);
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 5;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0xd9ffe7, 0x15231b, 2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
keyLight.position.set(-2, 3.5, 3);
scene.add(keyLight);
const fillLight = new THREE.PointLight(0x5df29a, 12, 6);
fillLight.position.set(1.8, 1.5, 1.6);
scene.add(fillLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 5),
  new THREE.MeshStandardMaterial({ color: 0x0c1a12, roughness: 0.82, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.01;
scene.add(floor);
const grid = new THREE.GridHelper(8, 40, 0x224c34, 0x183022);
grid.position.y = 0.002;
scene.add(grid);

const targetPanel = new THREE.Mesh(
  new THREE.PlaneGeometry(1.35, 1.1),
  new THREE.MeshStandardMaterial({ color: 0x16261c, roughness: 0.9, side: THREE.DoubleSide }),
);
targetPanel.position.set(0, 0.55, -0.58);
scene.add(targetPanel);
const panelBorder = new THREE.LineSegments(
  new THREE.EdgesGeometry(targetPanel.geometry),
  new THREE.LineBasicMaterial({ color: 0x56ee91, transparent: true, opacity: 0.5 }),
);
panelBorder.position.copy(targetPanel.position);
scene.add(panelBorder);

const characters = [
  { key: 'heart', model: '/characters/models/ip_01_heart_static.fbx', pat: '/characters/animations/heart_pat.glb', pull: '/characters/animations/heart_pull.glb' },
  { key: 'bubble', model: '/characters/models/ip_02_bubble_static.fbx', pat: '/characters/animations/bubble_pat.glb', pull: '/characters/animations/bubble_pull.glb' },
  { key: 'leaf', model: '/characters/models/ip_03_leaf_static.fbx', pat: '/characters/animations/leaf_pat.glb', pull: '/characters/animations/leaf_pull.glb' },
];
const span = 0.88;
const characterWidth = span / 3.18;
const fbxLoader = new FBXLoader();
const gltfLoader = new GLTFLoader();
const TURN_SPEED_MAX = 0.00025;
const TURN_RADIANS_PER_SCREEN_WIDTH = Math.PI * 4;
const TURN_RETURN_DELAY_MS = 1500;

function prepareModel(model, name) {
  model.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => { if (material) material.side = THREE.DoubleSide; });
  });
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = characterWidth / Math.max(size.x, 0.0001);
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  const wrapper = new THREE.Group();
  wrapper.name = name;
  wrapper.add(model);
  wrapper.userData.height = size.y * scale;
  wrapper.userData.width = size.x * scale;
  return wrapper;
}

const records = await Promise.all(characters.map((data, index) => new Promise((resolve, reject) => {
  fbxLoader.load(data.model, (model) => {
    const pose = new THREE.Group();
    pose.position.set((index - 1) * span / 3, 0, 0.3);
    pose.userData.phase = index * 1.55;
    pose.userData.lastActionAt = -Infinity;
    pose.userData.turnAngle = 0;
    pose.userData.lastTurnGestureAt = -Infinity;
    pose.userData.blowSpinVelocity = 0;
    const base = prepareModel(model, `${data.key}-static`);
    pose.add(base);
    scene.add(pose);
    resolve({ data, pose, base, variants: new Map(), busy: false, activeVariant: null });
  }, undefined, reject);
})));

async function playAction(record, name) {
  if (record.busy) return;
  record.busy = true;
  record.pose.userData.lastActionAt = performance.now();
  try {
    let variant = record.variants.get(name);
    if (!variant) {
      const gltf = await gltfLoader.loadAsync(record.data[name]);
      if (!gltf.animations.length) throw new Error(`${record.data[name]} 中没有动画片段`);
      const wrapper = prepareModel(gltf.scene, `${record.data.key}-${name}`);
      wrapper.visible = false;
      record.pose.add(wrapper);
      const mixer = new THREE.AnimationMixer(wrapper);
      const action = mixer.clipAction(gltf.animations[0]);
      variant = { gltf, wrapper, mixer, action };
      record.variants.set(name, variant);
    }

    record.activeVariant = variant;
    record.base.visible = false;
    variant.wrapper.visible = true;
    variant.mixer.stopAllAction();
    variant.action.reset();
    variant.action.setLoop(THREE.LoopOnce, 1);
    variant.action.clampWhenFinished = true;
    const finish = (event) => {
      if (event.action !== variant.action) return;
      variant.mixer.removeEventListener('finished', finish);
      variant.action.stop();
      variant.wrapper.visible = false;
      record.base.visible = true;
      record.activeVariant = null;
      record.busy = false;
    };
    variant.mixer.addEventListener('finished', finish);
    variant.action.play();
  } catch (error) {
    record.busy = false;
    setGestureStatus(`${record.data.key} · ${name} 动作加载失败`);
    console.warn('Preview interaction could not load.', error);
  }
}

function screenPoint(localPoint, pose) {
  const world = localPoint.clone();
  pose.localToWorld(world);
  const projected = world.project(camera);
  return { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2 };
}

function characterScreenBounds(record) {
  const height = record.base.userData.height;
  const width = record.base.userData.width;
  return {
    head: screenPoint(new THREE.Vector3(0, height * 0.82, 0), record.pose),
    headTop: screenPoint(new THREE.Vector3(0, height, 0), record.pose),
    headBoundary: screenPoint(new THREE.Vector3(0, height * (2 / 3), 0), record.pose),
    headLeft: screenPoint(new THREE.Vector3(-width * 0.58, height * 0.84, 0), record.pose),
    headRight: screenPoint(new THREE.Vector3(width * 0.58, height * 0.84, 0), record.pose),
    body: screenPoint(new THREE.Vector3(0, height * 0.42, 0), record.pose),
    bottom: screenPoint(new THREE.Vector3(0, 0, 0), record.pose),
    bodyLeft: screenPoint(new THREE.Vector3(-width * 0.68, height * 0.5, 0), record.pose),
    bodyRight: screenPoint(new THREE.Vector3(width * 0.68, height * 0.5, 0), record.pose),
  };
}

function hitCharacter(point, headOnly = false) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const record of records) {
    const bounds = characterScreenBounds(record);
    const left = Math.min(bounds[headOnly ? 'headLeft' : 'bodyLeft'].x, bounds[headOnly ? 'headRight' : 'bodyRight'].x);
    const right = Math.max(bounds[headOnly ? 'headLeft' : 'bodyLeft'].x, bounds[headOnly ? 'headRight' : 'bodyRight'].x);
    const top = headOnly ? bounds.headTop.y : Math.min(bounds.headTop.y, bounds.bottom.y);
    const bottom = headOnly ? bounds.headBoundary.y : Math.max(bounds.headTop.y, bounds.bottom.y);
    if (point.x < left - 0.018 || point.x > right + 0.018 || point.y < top - 0.018 || point.y > bottom + 0.018) continue;
    const target = headOnly ? bounds.head : bounds.body;
    const distance = Math.hypot(target.x - point.x, target.y - point.y);
    if (distance < nearestDistance) {
      nearest = record;
      nearestDistance = distance;
    }
  }
  return nearest;
}

let dragStart = null;
let previousDragPoint = null;
let patGesture = null;
const gestureStatus = document.querySelector('#gesture-status');
let previewBlowDetector = null;
function setGestureStatus(message) {
  if (gestureStatus) gestureStatus.textContent = message;
}
document.querySelector('#blow-test-button')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    previewBlowDetector = await startBlowDetector((durationMs) => {
      for (const record of records) {
        const turns = THREE.MathUtils.clamp(0.4 + (durationMs - 180) / 1400, 0.4, 1);
        record.pose.userData.blowSpinVelocity = turns * Math.PI * 2 * 5;
        record.pose.userData.lastTurnGestureAt = performance.now();
      }
      setGestureStatus(`吹气 ${Math.round(durationMs)} 毫秒 · 旋转约 ${THREE.MathUtils.clamp(0.4 + (durationMs - 180) / 1400, 0.4, 1).toFixed(1)} 圈并缓慢停止`);
    });
    button.textContent = '吹气识别已开启';
    setGestureStatus('麦克风已开启，对着设备吹气测试旋转。');
  } catch (error) {
    button.disabled = false;
    setGestureStatus(`麦克风不可用：${error.message}`);
  }
});
window.addEventListener('pagehide', () => { void previewBlowDetector?.stop(); });
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.shiftKey || event.button !== 0 || !event.isPrimary) return;
  const bounds = renderer.domElement.getBoundingClientRect();
  dragStart = { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height, at: performance.now() };
  previousDragPoint = { ...dragStart };
  const headRecord = hitCharacter(dragStart, true);
  patGesture = headRecord ? { record: headRecord, lastX: dragStart.x, strokeStartX: dragStart.x, direction: 0, strokeCount: 0 } : null;
  controls.enabled = false;
  event.preventDefault();
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!dragStart || !previousDragPoint) return;
  const bounds = renderer.domElement.getBoundingClientRect();
  const current = {
    x: (event.clientX - bounds.left) / bounds.width,
    y: (event.clientY - bounds.top) / bounds.height,
    at: performance.now(),
  };
  const dx = current.x - previousDragPoint.x;
  const dy = current.y - previousDragPoint.y;
  const midpoint = { x: (current.x + previousDragPoint.x) / 2, y: (current.y + previousDragPoint.y) / 2 };
  const elapsed = Math.max(current.at - previousDragPoint.at, 1);
  const speed = Math.hypot(dx, dy) / elapsed;
  const headRecord = hitCharacter(current, true);
  if (patGesture && headRecord === patGesture.record) {
    const headBounds = characterScreenBounds(patGesture.record);
    const strokeThreshold = Math.max(0.018, Math.abs(headBounds.headRight.x - headBounds.headLeft.x) * 0.12);
    const strokeDx = current.x - patGesture.strokeStartX;
    if (Math.abs(strokeDx) >= strokeThreshold) {
      const direction = Math.sign(strokeDx);
      if (patGesture.direction && direction !== patGesture.direction) patGesture.strokeCount += 1;
      else if (!patGesture.direction) patGesture.strokeCount = 1;
      patGesture.direction = direction;
      patGesture.strokeStartX = current.x;
      if (patGesture.strokeCount >= 3) {
        setGestureStatus(`${patGesture.record.data.key} · 头部左-右-左往返 → Pat`);
        void playAction(patGesture.record, 'pat');
        patGesture = null;
      }
    }
    if (patGesture) patGesture.lastX = current.x;
  } else if (patGesture) {
    patGesture = null;
  }
  if (!headRecord && Math.abs(dx) > Math.abs(dy) * 1.15 && Math.abs(dx) > 0.002 && speed <= TURN_SPEED_MAX) {
    const record = hitCharacter(midpoint);
    if (record) {
      record.pose.userData.turnAngle = THREE.MathUtils.clamp(
        record.pose.userData.turnAngle + dx * TURN_RADIANS_PER_SCREEN_WIDTH,
        -Math.PI * 1.5,
        Math.PI * 1.5,
      );
      record.pose.userData.lastTurnGestureAt = current.at;
      setGestureStatus(`${record.data.key} · 慢速横滑 → 按距离转身`);
    }
  }
  previousDragPoint = current;
});
renderer.domElement.addEventListener('pointerup', (event) => {
  controls.enabled = true;
  if (!dragStart) return;
  const bounds = renderer.domElement.getBoundingClientRect();
  const end = { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  const dx = end.x - dragStart.x;
  const dy = end.y - dragStart.y;
  const midpoint = { x: (end.x + dragStart.x) / 2, y: (end.y + dragStart.y) / 2 };
  const duration = performance.now() - dragStart.at;
  const distance = Math.hypot(dx, dy);
  if (duration < 1400 && distance > 0.08) {
    if (Math.abs(dy) > Math.abs(dx) * 1.25) {
      const record = hitCharacter(midpoint);
      if (record) {
        setGestureStatus(`${record.data.key} · 身体上下滑动 → Pull`);
        void playAction(record, 'pull');
      }
    }
  }
  dragStart = null;
  previousDragPoint = null;
  patGesture = null;
});
renderer.domElement.addEventListener('lostpointercapture', () => {
  if (!dragStart) return;
  dragStart = null;
  previousDragPoint = null;
  patGesture = null;
  controls.enabled = true;
});
renderer.domElement.addEventListener('pointercancel', () => { dragStart = null; previousDragPoint = null; patGesture = null; controls.enabled = true; });

const clock = new THREE.Clock();
function render() {
  const delta = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  for (const record of records) {
    const { pose } = record;
    if (pose.userData.blowSpinVelocity > 0.05) {
      pose.userData.turnAngle += pose.userData.blowSpinVelocity * delta;
      pose.userData.blowSpinVelocity *= Math.exp(-5 * delta);
      pose.userData.lastTurnGestureAt = performance.now();
      if (pose.userData.blowSpinVelocity <= 0.05) {
        pose.userData.blowSpinVelocity = 0;
        pose.userData.lastTurnGestureAt = performance.now() - TURN_RETURN_DELAY_MS;
      }
    }
    const phase = time * 1.65 + pose.userData.phase;
    const breath = 1 + (Math.sin(phase * 0.82 + 0.4) + 1) * 0.5 * 0.025;
    pose.position.y = Math.sin(phase) * 0.012;
    pose.scale.set(breath, 1 + (breath - 1) * 0.68, breath);
    if (performance.now() - pose.userData.lastTurnGestureAt >= TURN_RETURN_DELAY_MS) {
      pose.userData.turnAngle *= Math.exp(-delta / 0.55);
      if (Math.abs(pose.userData.turnAngle) < 0.005) pose.userData.turnAngle = 0;
    }
    pose.rotation.y = pose.userData.turnAngle;
    if (record.activeVariant) record.activeVariant.mixer.update(delta);
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}
render();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
