// Adapted from React Bits TextPressure by David Haz.
// License notice: ../../public/THIRD_PARTY_NOTICES.txt

import { useCallback, useEffect, useRef, useState } from 'react';

interface TextPressureProps {
  text: string;
  className?: string;
  minFontSize?: number;
  maxFontSize?: number;
  textColor?: string;
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y);

export default function TextPressure({
  text,
  className = '',
  minFontSize = 48,
  maxFontSize = 240,
  textColor = 'currentColor',
}: TextPressureProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const lettersRef = useRef<(HTMLSpanElement | null)[]>([]);
  const smoothedPointer = useRef({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0 });
  const visible = useRef(true);
  const reducedMotion = useRef(false);
  const [fontSize, setFontSize] = useState(minFontSize);

  const resize = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const width = container.getBoundingClientRect().width;
    const fittedSize = width / Math.max(text.length * 0.7, 1);
    setFontSize(Math.min(maxFontSize, Math.max(minFontSize, fittedSize)));
  }, [maxFontSize, minFontSize, text.length]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rect = container.getBoundingClientRect();
    const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    pointer.current = origin;
    smoothedPointer.current = origin;

    const handlePointer = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    const resizeObserver = new ResizeObserver(resize);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting;
    });
    resizeObserver.observe(container);
    visibilityObserver.observe(container);
    window.addEventListener('pointermove', handlePointer, { passive: true });
    resize();

    return () => {
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      window.removeEventListener('pointermove', handlePointer);
    };
  }, [resize]);

  useEffect(() => {
    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (!visible.current || !titleRef.current) return;

      smoothedPointer.current.x += (pointer.current.x - smoothedPointer.current.x) * 0.075;
      smoothedPointer.current.y += (pointer.current.y - smoothedPointer.current.y) * 0.075;
      const titleRect = titleRef.current.getBoundingClientRect();
      const maxDistance = Math.max(titleRect.width * 0.62, 1);

      lettersRef.current.forEach((letter) => {
        if (!letter) return;
        if (reducedMotion.current) {
          letter.style.fontVariationSettings = "'wght' 500, 'wdth' 100, 'slnt' 0";
          return;
        }
        const rect = letter.getBoundingClientRect();
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const raw = Math.max(0, 1 - distance(smoothedPointer.current, center) / maxDistance);
        const proximity = raw * raw * (3 - 2 * raw);
        const weight = Math.round(360 + proximity * 300);
        const width = Math.round(92 + proximity * 18);
        const slant = (-2 + proximity * 2).toFixed(2);
        letter.style.fontVariationSettings = `'wght' ${weight}, 'wdth' ${width}, 'slnt' ${slant}`;
      });
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div ref={containerRef} className={`text-pressure ${className}`}>
      <h1
        ref={titleRef}
        aria-label={text}
        style={{ fontSize, color: textColor }}
      >
        {text.split('').map((character, index) => (
          <span
            aria-hidden="true"
            key={`${character}-${index}`}
            ref={(element) => {
              lettersRef.current[index] = element;
            }}
          >
            {character}
          </span>
        ))}
      </h1>
    </div>
  );
}
