import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import type { MotionValue } from 'framer-motion';
import * as THREE from 'three';

interface RelayLoomProps {
  progress?: MotionValue<number>;
  variant?: 'hero' | 'story';
}

const STREAMS = 28;
const SEGMENTS = 86;
const PARTICLES = 520;

function writePoint(
  target: Float32Array,
  offset: number,
  stream: number,
  t: number,
  time: number,
  progress: number,
  pointerX: number,
  pointerY: number,
) {
  const phase = stream * 0.713;
  const envelope = Math.sin(Math.PI * t);
  const lane = (stream - (STREAMS - 1) / 2) * 0.155;
  const pinch = Math.exp(-Math.pow((t - 0.5) * 3.15, 2));
  const braid = Math.sin(t * 8.5 + phase + time * 0.26) * 0.13 * envelope;
  const unfurl = Math.sin((t + progress * 0.72) * Math.PI * 2 + phase) * envelope * (0.06 + progress * 0.38);

  target[offset] = -5.6 + t * 11.2 + pointerX * 0.11 * envelope;
  target[offset + 1] = lane * (1 - pinch * (0.72 + progress * 0.16)) + braid + unfurl + pointerY * 0.15 * envelope;
  target[offset + 2] = Math.cos(t * 6.2 + phase + time * 0.14) * envelope * (0.12 + progress * 0.48);
}

function Loom({ progress }: { progress?: MotionValue<number> }) {
  const groupRef = useRef<THREE.Group>(null!);
  const lineMaterialRef = useRef<THREE.LineBasicMaterial>(null!);
  const pointMaterialRef = useRef<THREE.PointsMaterial>(null!);
  const ember = useMemo(() => new THREE.Color('#e8965c'), []);
  const cream = useMemo(() => new THREE.Color('#f3eee5'), []);

  const lineGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(STREAMS * (SEGMENTS - 1) * 2 * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, []);

  const particleGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLES * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, []);

  useEffect(() => () => {
    lineGeometry.dispose();
    particleGeometry.dispose();
  }, [lineGeometry, particleGeometry]);

  useFrame(({ clock, pointer }, delta) => {
    const time = clock.getElapsedTime();
    const storyProgress = progress?.get() ?? 0.08;
    const linePositions = lineGeometry.getAttribute('position').array as Float32Array;
    let cursor = 0;

    for (let stream = 0; stream < STREAMS; stream += 1) {
      for (let segment = 0; segment < SEGMENTS - 1; segment += 1) {
        writePoint(linePositions, cursor, stream, segment / (SEGMENTS - 1), time, storyProgress, pointer.x, pointer.y);
        cursor += 3;
        writePoint(linePositions, cursor, stream, (segment + 1) / (SEGMENTS - 1), time, storyProgress, pointer.x, pointer.y);
        cursor += 3;
      }
    }
    lineGeometry.getAttribute('position').needsUpdate = true;

    const particlePositions = particleGeometry.getAttribute('position').array as Float32Array;
    for (let index = 0; index < PARTICLES; index += 1) {
      const stream = index % STREAMS;
      const t = (index / PARTICLES + time * 0.022 + (stream * 0.037)) % 1;
      writePoint(particlePositions, index * 3, stream, t, time, storyProgress, pointer.x, pointer.y);
    }
    particleGeometry.getAttribute('position').needsUpdate = true;

    groupRef.current.rotation.x = THREE.MathUtils.damp(groupRef.current.rotation.x, -pointer.y * 0.08, 4, delta);
    groupRef.current.rotation.y = THREE.MathUtils.damp(groupRef.current.rotation.y, pointer.x * 0.1, 4, delta);
    groupRef.current.rotation.z = THREE.MathUtils.damp(groupRef.current.rotation.z, (storyProgress - 0.5) * 0.09, 3, delta);
    lineMaterialRef.current.color.copy(cream).lerp(ember, 0.72 + storyProgress * 0.2);
    pointMaterialRef.current.color.copy(cream).lerp(ember, 0.82);
  });

  return (
    <group ref={groupRef}>
      <lineSegments geometry={lineGeometry} frustumCulled={false}>
        <lineBasicMaterial
          ref={lineMaterialRef}
          color="#d7804d"
          transparent
          opacity={0.32}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </lineSegments>
      <points geometry={particleGeometry} frustumCulled={false}>
        <pointsMaterial
          ref={pointMaterialRef}
          color="#e8965c"
          size={0.032}
          transparent
          opacity={0.94}
          sizeAttenuation
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>
    </group>
  );
}

export default function RelayLoom({ progress, variant = 'hero' }: RelayLoomProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), { rootMargin: '120px' });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className={`relay-loom relay-loom-${variant}`}>
      <Canvas
        camera={{ position: [0, 0, 8.4], fov: 42, near: 0.1, far: 40 }}
        dpr={[1, 1.5]}
        frameloop={active ? 'always' : 'demand'}
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
        performance={{ min: 0.5 }}
        fallback={<div className="loom-fallback" />}
      >
        <Loom progress={progress} />
      </Canvas>
    </div>
  );
}
