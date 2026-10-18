import * as THREE from 'three';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';

const TARGET_URL = `${import.meta.env.BASE_URL}targets/school-logo.mind`;

async function assertTargetAvailable() {
  const response = await fetch(TARGET_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`识别目标文件加载失败（HTTP ${response.status}）：${TARGET_URL}`);
  }
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/html')) {
    throw new Error(`识别目标文件无效或不存在：${TARGET_URL}`);
  }
}

export function createARSession({ container, ui }) {
  let mindar = null;
  let cube = null;
  let stopped = false;

  async function start() {
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      throw new Error('摄像头需要 HTTPS 安全来源。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('此浏览器不支持摄像头访问。');
    }
    await assertTargetAvailable();

    mindar = new MindARThree({
      container,
      imageTargetSrc: TARGET_URL,
      maxTrack: 1,
      filterMinCF: 0.001,
      filterBeta: 0.01,
      warmupTolerance: 5,
      missTolerance: 5,
    });

    const { renderer, scene, camera } = mindar;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    scene.add(new THREE.HemisphereLight(0xffffff, 0x224433, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
    keyLight.position.set(1, 2, 2);
    scene.add(keyLight);

    const anchor = mindar.addAnchor(0);
    const geometry = new THREE.BoxGeometry(0.28, 0.28, 0.28);
    const material = new THREE.MeshStandardMaterial({
      color: 0x24d66b,
      roughness: 0.38,
      metalness: 0.08,
    });
    cube = new THREE.Mesh(geometry, material);
    cube.position.set(0, 0, 0.18);
    cube.visible = false;
    anchor.group.add(cube);

    anchor.onTargetFound = () => {
      if (stopped) return;
      cube.visible = true;
      ui.found();
    };
    anchor.onTargetLost = () => {
      if (stopped) return;
      cube.visible = false;
      ui.lost();
    };

    await mindar.start();
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const delta = Math.min(clock.getDelta(), 0.05);
      if (cube?.visible) cube.rotation.y += delta * 0.8;
      renderer.render(scene, camera);
    });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (mindar) {
      mindar.renderer.setAnimationLoop(null);
      mindar.stop();
      cube?.geometry.dispose();
      cube?.material.dispose();
      mindar.renderer.dispose();
    }
    container.replaceChildren();
    mindar = null;
    cube = null;
  }

  return { start, stop };
}
