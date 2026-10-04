import * as THREE from 'three';
import { ATLAS_GRID } from './particleAtlas';

/**
 * One draw call's worth of camera-facing particle quads.
 *
 * THREE.Points can't do any of what sells a fire or an explosion: no per-
 * particle rotation, no flipbook frame, no stretching a spark along its
 * velocity, and the sprite size is in screen pixels rather than world units so
 * particles don't hold their scale as the camera moves. So this is an
 * InstancedBufferGeometry of quads billboarded in the vertex shader instead.
 *
 * Dead instances are collapsed to zero size rather than compacted, which keeps
 * writes O(live) and costs the GPU a degenerate triangle.
 */
export class SpriteBatch {
  readonly mesh: THREE.Mesh;
  private center: THREE.InstancedBufferAttribute;
  private params: THREE.InstancedBufferAttribute;   // size, rotation, cell, opacity
  private color: THREE.InstancedBufferAttribute;
  /** 1 = lie flat in the ground plane instead of facing the camera */
  private flat: THREE.InstancedBufferAttribute;
  private cursor = 0;

  constructor(max: number, map: THREE.Texture, additiveBlend: boolean) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.center = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.flat = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.center.setUsage(THREE.DynamicDrawUsage);
    this.params.setUsage(THREE.DynamicDrawUsage);
    this.color.setUsage(THREE.DynamicDrawUsage);
    this.flat.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCenter', this.center);
    geo.setAttribute('aParams', this.params);
    geo.setAttribute('aColor', this.color);
    geo.setAttribute('aFlat', this.flat);
    geo.instanceCount = max;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: map },
        grid: { value: ATLAS_GRID },
      },
      vertexShader: /* glsl */`
        attribute vec3 aCenter;
        attribute vec4 aParams;   // x size, y rotation, z atlas cell, w opacity
        attribute vec3 aColor;
        attribute float aFlat;
        uniform float grid;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vOpacity;
        void main() {
          float s = sin(aParams.y), c = cos(aParams.y);
          vec2 corner = position.xy * aParams.x;
          vec2 rc = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
          vec4 mv;
          if (aFlat > 0.5) {
            // lie in the world ground plane — a blast ring billboarded at the
            // camera reads as a vertical hoop, not a wave running along the deck
            mv = modelViewMatrix * vec4(aCenter + vec3(rc.x, 0.0, rc.y), 1.0);
          } else {
            // billboard in view space so the quad always faces the camera
            mv = modelViewMatrix * vec4(aCenter, 1.0);
            mv.xy += rc;
          }
          gl_Position = projectionMatrix * mv;

          float cell = aParams.z;
          vec2 cellUv = vec2(mod(cell, grid), floor(cell / grid));
          vUv = (uv + cellUv) / grid;
          vColor = aColor;
          vOpacity = aParams.w;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vOpacity;
        void main() {
          vec4 t = texture2D(map, vUv);
          gl_FragColor = vec4(t.rgb * vColor, t.a * vOpacity);
          if (gl_FragColor.a < 0.004) discard;
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: additiveBlend ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;      // the quads live outside the base geometry
    this.mesh.renderOrder = additiveBlend ? 11 : 10;   // smoke first, then fire over it
    this.clear();
  }

  /** park every instance off-screen at zero size */
  clear() {
    this.params.array.fill(0);
    this.params.needsUpdate = true;
  }

  /** start a frame's worth of writes */
  begin() {
    this.cursor = 0;
  }

  write(
    pos: THREE.Vector3, size: number, rot: number, cell: number,
    opacity: number, col: THREE.Color, flat = false,
  ) {
    const i = this.cursor;
    if (i >= this.center.count) return;
    this.cursor++;
    this.center.setXYZ(i, pos.x, pos.y, pos.z);
    this.params.setXYZW(i, size, rot, cell, opacity);
    this.color.setXYZ(i, col.r, col.g, col.b);
    this.flat.setX(i, flat ? 1 : 0);
  }

  /** zero the tail and flush — call once all of this frame's writes are done */
  end() {
    for (let i = this.cursor; i < this.center.count; i++) {
      if (this.params.getX(i) === 0) break;          // already a clean tail
      this.params.setXYZW(i, 0, 0, 0, 0);
    }
    this.center.needsUpdate = true;
    this.params.needsUpdate = true;
    this.color.needsUpdate = true;
    this.flat.needsUpdate = true;
  }
}
