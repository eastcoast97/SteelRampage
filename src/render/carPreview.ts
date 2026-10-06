import * as THREE from 'three';
import type { CarSpec } from '../game/specs';
import { buildCarMesh } from './carMesh';

/**
 * The turntable on the vehicle-select screen.
 *
 * The roster is eight AI-generated vehicles that look nothing like each other,
 * and until now the menu described them in words only — you picked a car and
 * found out what you were driving after the match had started. This builds the
 * real mesh, the same `buildCarMesh` the game uses, so what you are shown is
 * what you get rather than a screenshot that goes stale the next time a model
 * is regenerated.
 *
 * Deliberately its own renderer, not the game's: it has to run while the menu
 * is up and no match exists. It is small (the canvas is a few hundred pixels)
 * and it stops rendering the moment the menu closes.
 */
export class CarPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private turntable = new THREE.Group();
  private current: THREE.Object3D | null = null;
  private frame: THREE.Sphere | null = null;
  private wheels: THREE.Object3D[] = [];
  private raf = 0;
  private spin = 0;
  private running = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
    this.scene.add(this.turntable);

    // A show-floor light rig, not the arena's. Key from the front quarter so the
    // flank reads, a cool fill opposite so the dark side is not a silhouette,
    // and a rim behind to lift the roofline off the panel background.
    const key = new THREE.DirectionalLight(0xfff2e0, 3.1);
    key.position.set(4, 5, 4);
    const fill = new THREE.DirectionalLight(0x9fc0ff, 1.25);
    fill.position.set(-5, 2, -2);
    const rim = new THREE.DirectionalLight(0xffd6a0, 2.0);
    rim.position.set(-2, 3, -6);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xbfd4ff, 0x30241c, 1.5));

    // The bodies are metallic and were authored against a reflection
    // environment; with none they render as flat grey plastic.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x202836);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(10, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x6f8099, side: THREE.BackSide }),
    );
    env.add(glow);
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(24, 1.6, 0.2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    strip.position.set(0, 3.2, -6);
    env.add(strip);
    this.scene.environment = pmrem.fromScene(env, 0.04).texture;
    pmrem.dispose();

    // a soft contact shadow so the car sits on something
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.9, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    this.turntable.add(shadow);
  }

  show(spec: CarSpec) {
    if (this.current) {
      this.turntable.remove(this.current);
      this.current.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry?.dispose();
      });
    }
    const built = buildCarMesh(spec);
    this.current = built.group;
    this.wheels = built.wheels;
    // buildCarMesh places the body at the rig's suspension rest height, which is
    // the physics frame, not the floor. Measure it and set it down.
    this.turntable.add(built.group);
    built.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(built.group);
    built.group.position.y -= box.min.y;
    box.setFromObject(built.group);
    // Frame from the bounding SPHERE, not the box: the group spins, so the
    // silhouette that has to fit is the widest one it will ever present, and a
    // box measured at rest under-reports that by the diagonal. The roster runs
    // from a motorcycle to a box truck, so this cannot be a fixed distance.
    this.frame = box.getBoundingSphere(new THREE.Sphere());
    this.spin = 0;
    this.place();
  }

  /** sit the camera so the car fills the panel at whatever aspect it is now */
  private place() {
    if (!this.frame) return;
    const r = this.frame.radius;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    // fit on BOTH axes, then back off a little for breathing room
    const dist = Math.max(r / Math.sin(vFov / 2), r / Math.sin(hFov / 2)) * 1.06;
    const dir = new THREE.Vector3(0.62, 0.42, 0.78).normalize();
    this.camera.position.copy(dir).multiplyScalar(dist);
    this.camera.position.y += this.frame.center.y * 0.5;
    this.camera.lookAt(0, this.frame.center.y * 0.85, 0);
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.spin += dt * 0.55;
      this.turntable.rotation.y = this.spin;
      // roll the wheels, or a turntable looks like a model on a stick
      for (const w of this.wheels) {
        const hub = w.children[0];
        if (hub) hub.rotation.x += dt * 2.4;
      }
      this.resize();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.place();
    }
  }
}
