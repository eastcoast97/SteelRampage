import * as THREE from 'three';

/**
 * The shield bubble.
 *
 * The old one was a squashed sphere with a hex texture at a flat 0.16 opacity:
 * the lattice sat at the same brightness across the whole dome, including the
 * part directly between you and the car, so it read as a mesh wrapped round the
 * vehicle rather than a field around it — and it greyed out the paint it was
 * protecting.
 *
 * This is the standard energy-field treatment and it fixes both at once:
 *
 *  - FRESNEL. Nearly transparent where the surface faces you, bright where it
 *    turns away. The car underneath stays readable and the dome's silhouette is
 *    what you actually see, which is what makes it look like a field with a
 *    surface rather than a tinted bag.
 *  - LOCALISED IMPACTS. A hit lights the cells around where it landed instead of
 *    flashing the whole bubble, so you can see WHERE you are being shot from.
 *  - DESTABILISING. In the last two seconds the lattice breaks up and flickers
 *    rather than just blinking its opacity, so expiry reads as the field failing.
 */

export interface ShieldResult {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
}

export function buildShield(radius: number, hexMap: THREE.Texture): ShieldResult {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: hexMap },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x8fa5ff) },
      uHot: { value: new THREE.Color(0xeaf2ff) },
      /** 0..1, decays after a blocked hit */
      uFlash: { value: 0 },
      /** local-space direction the hit came from */
      uHitDir: { value: new THREE.Vector3(0, 1, 0) },
      /** 1 = healthy, ramps to 0 as the field fails */
      uStable: { value: 1 },
    },
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vViewW;
      varying vec3 vLocal;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vLocal = normalize(position);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewW = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uTime, uFlash, uStable;
      uniform vec3 uColor, uHot, uHitDir;
      varying vec3 vNormalW;
      varying vec3 vViewW;
      varying vec3 vLocal;
      varying vec2 vUv;

      void main() {
        // rim: transparent face-on, bright at grazing angles
        float facing = abs(dot(normalize(vNormalW), normalize(vViewW)));
        float rim = pow(1.0 - facing, 2.3);

        // hex lattice, drifting slowly so the field is never static
        float cells = texture2D(uMap, vUv * vec2(2.0, 1.0) + vec2(uTime * 0.012, 0.0)).r;

        // charge band sweeping up the dome
        float band = smoothstep(0.1, 0.0, abs(fract(uTime * 0.22) - (vLocal.y * 0.5 + 0.5)));

        // impact: light the cells around where the hit landed, not the whole dome
        float near = max(0.0, dot(normalize(vLocal), normalize(uHitDir)));
        float hit = pow(near, 5.0) * uFlash;

        // failing field: the lattice breaks up and stutters
        float noise = fract(sin(dot(vLocal.xy + floor(uTime * 22.0), vec2(12.99, 78.23))) * 43758.55);
        float decay = mix(step(0.35, noise) * (0.5 + 0.5 * sin(uTime * 30.0)), 1.0, uStable);

        float a = (rim * (0.5 + cells * 0.45) + cells * 0.05 + band * 0.18) * decay;
        a += hit * 1.5;

        vec3 col = mix(uColor, uHot, clamp(hit * 1.6 + band * 0.4, 0.0, 1.0));
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 20), mat);
  mesh.scale.y = 0.6;           // squashed dome — a field around the car, not a ball
  mesh.position.y = 0.15;
  mesh.visible = false;
  mesh.renderOrder = 8;
  return { mesh, mat };
}
