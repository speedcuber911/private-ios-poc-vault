import { Component, lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import { ArrowDown, ArrowUpRight, Check, RotateCcw } from 'lucide-react';
import TextPressure from './components/reactbits/TextPressure';

const RelayLoom = lazy(() => import('./components/RelayLoom'));
const ease = [0.16, 1, 0.3, 1] as const;

const capabilities = [
  {
    id: 'files',
    title: 'Files',
    label: 'Browse the real workspace',
    copy: 'Open registered workspaces and start from the folder that already contains the context.',
  },
  {
    id: 'runs',
    title: 'Runs',
    label: 'Send the long task away',
    copy: 'Start Codex, Claude Code, or Cursor work, follow live progress, and cancel when the direction changes.',
  },
  {
    id: 'threads',
    title: 'Threads',
    label: 'Return without reconstructing',
    copy: 'Every conversation and invocation stays attached to the folder where the work began.',
  },
  {
    id: 'previews',
    title: 'Previews',
    label: 'See the thing, not the log',
    copy: 'Open authenticated POCs and bounded artifacts directly from the result.',
  },
];

function SceneFallback() {
  return <div className="scene-fallback" aria-hidden="true"><span /><span /><span /></div>;
}

class SceneErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <SceneFallback /> : this.props.children;
  }
}

function SafeRelayLoom({ progress, variant }: { progress?: MotionValue<number>; variant: 'hero' | 'story' }) {
  return (
    <SceneErrorBoundary>
      <Suspense fallback={<SceneFallback />}>
        <RelayLoom progress={progress} variant={variant} />
      </Suspense>
    </SceneErrorBoundary>
  );
}

function Reveal({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 42 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.95, delay, ease }}
    >
      {children}
    </motion.div>
  );
}

function ThesisWord({ word, progress, range }: { word: string; progress: MotionValue<number>; range: [number, number] }) {
  const opacity = useTransform(progress, range, [0.14, 1]);
  const y = useTransform(progress, range, [24, 0]);
  return <motion.span style={{ opacity, y }}>{word}&nbsp;</motion.span>;
}

function Thesis() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 75%', 'end 55%'] });
  const words = 'A phone should not become a tiny laptop. It should become a relay.'.split(' ');
  return (
    <section className="thesis" ref={ref} id="system">
      <div className="thesis-index">01 — THE PREMISE</div>
      <p>
        {words.map((word, index) => {
          const start = (index / words.length) * 0.82;
          return <ThesisWord key={`${word}-${index}`} word={word} progress={scrollYProgress} range={[start, Math.min(start + 0.18, 1)]} />;
        })}
      </p>
      <div className="thesis-note">No miniature desktop.<br />No remote-screen theatre.<br />Only the controls that move work forward.</div>
    </section>
  );
}

function StoryBeat({
  index,
  title,
  copy,
  progress,
  range,
  className,
}: {
  index: string;
  title: string;
  copy: string;
  progress: MotionValue<number>;
  range: [number, number, number, number];
  className: string;
}) {
  const opacity = useTransform(progress, range, [0, 1, 1, 0]);
  const y = useTransform(progress, range, [70, 0, 0, -70]);
  return (
    <motion.div className={`story-beat ${className}`} style={{ opacity, y }}>
      <span>{index}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
    </motion.div>
  );
}

function HandoffStory({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const progressScale = useSpring(scrollYProgress, { stiffness: 110, damping: 24, mass: 0.2 });

  if (reducedMotion) {
    return (
      <section className="handoff-story handoff-story-static" ref={ref}>
        <div className="static-beats">
          <article><span>01 / POINT</span><h2>Choose the exact place.</h2><p>Browse to a registered folder. The workspace—not a pasted explanation—becomes the starting context.</p></article>
          <article><span>02 / RELEASE</span><h2>Let the work leave your hands.</h2><p>The agent runs where its tools, accounts, and files already live. Watch it closely or close the app.</p></article>
          <article><span>03 / RETURN</span><h2>Come back to the thread.</h2><p>Review the result, continue the conversation, preview the artifact, or hand the session to another node.</p></article>
        </div>
      </section>
    );
  }

  return (
    <section className="handoff-story" ref={ref}>
      <div className="handoff-stage">
        <div className="stage-label stage-label-left">PHONE / INTENT</div>
        <div className="stage-label stage-label-right">RUNNER / EXECUTION</div>
        <div className="story-scene">
          {reducedMotion ? <SceneFallback /> : <SafeRelayLoom progress={scrollYProgress} variant="story" />}
        </div>
        <StoryBeat
          index="01 / POINT"
          title="Choose the exact place."
          copy="Browse to a registered folder. The workspace—not a pasted explanation—becomes the starting context."
          progress={scrollYProgress}
          range={[0, 0.04, 0.24, 0.34]}
          className="story-beat-one"
        />
        <StoryBeat
          index="02 / RELEASE"
          title="Let the work leave your hands."
          copy="The agent runs where its tools, accounts, and files already live. Watch it closely or close the app."
          progress={scrollYProgress}
          range={[0.28, 0.39, 0.57, 0.68]}
          className="story-beat-two"
        />
        <StoryBeat
          index="03 / RETURN"
          title="Come back to the thread."
          copy="Review the result, continue the conversation, preview the artifact, or hand the session to another node."
          progress={scrollYProgress}
          range={[0.62, 0.73, 0.94, 1]}
          className="story-beat-three"
        />
        <div className="story-ruler"><motion.span style={{ scaleX: progressScale }} /></div>
      </div>
    </section>
  );
}

function CapabilityPreview({ active }: { active: string }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        className={`capability-preview preview-${active}`}
        key={active}
        initial={{ opacity: 0, y: 28, clipPath: 'inset(0 0 18% 0)' }}
        animate={{ opacity: 1, y: 0, clipPath: 'inset(0 0 0% 0)' }}
        exit={{ opacity: 0, y: -18, clipPath: 'inset(18% 0 0 0)' }}
        transition={{ duration: 0.55, ease }}
      >
        <header><span>relay / product</span><small>PRIVATE NODE</small></header>
        {active === 'files' && (
          <div className="files-preview">
            <div className="preview-path">workspaces / <strong>relay</strong></div>
            {['product', 'relay-server', 'ios', 'AGENTS.md'].map((item, index) => (
              <div className="file-line" key={item}><span>0{index + 1}</span><strong>{item}</strong><small>{index < 3 ? 'folder' : '12 KB'}</small></div>
            ))}
          </div>
        )}
        {active === 'runs' && (
          <div className="runs-preview">
            <div className="run-clock"><span>RUNNING</span><strong>00:42</strong></div>
            <div className="run-prompt">“Fix the handoff path and prove the failed case.”</div>
            {['Read workspace contract', 'Trace import failure', 'Run focused verification'].map((item, index) => (
              <div className="run-line" key={item}><Check size={14} /><span>{item}</span><small>{index === 2 ? 'live' : 'done'}</small></div>
            ))}
          </div>
        )}
        {active === 'threads' && (
          <div className="threads-preview">
            <div className="thread-question">Make the failed handoff recoverable.</div>
            <div className="thread-answer"><span>CODEX / TASK</span><p>The import path now reports terminal failures and keeps the workspace boundary pinned.</p></div>
            <div className="thread-proof">3 files changed <strong>checks passed</strong></div>
          </div>
        )}
        {active === 'previews' && (
          <div className="previews-preview">
            <div className="preview-ready"><span>ARTIFACT 04</span><strong>READY</strong></div>
            <div className="preview-stack"><i>HTML</i><i>CSS</i><i>JS</i></div>
            <div className="preview-open">OPEN AUTHENTICATED PREVIEW <ArrowUpRight size={15} /></div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

function CapabilityIndex() {
  const [active, setActive] = useState(capabilities[0].id);
  return (
    <section className="capabilities" id="product">
      <div className="capability-heading">
        <span>02 — THE SURFACE</span>
        <h2>Four verbs.<br />Nothing ornamental.</h2>
      </div>
      <div className="capability-layout">
        <div className="capability-list" role="tablist" aria-label="Relay capabilities">
          {capabilities.map((capability, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={active === capability.id}
              className={active === capability.id ? 'active' : ''}
              key={capability.id}
              onClick={() => setActive(capability.id)}
              onPointerEnter={() => setActive(capability.id)}
              onFocus={() => setActive(capability.id)}
            >
              <span>0{index + 1}</span>
              <strong>{capability.title}</strong>
              <div><small>{capability.label}</small><p>{capability.copy}</p></div>
              <ArrowUpRight size={19} />
            </button>
          ))}
        </div>
        <div className="capability-preview-wrap">
          <CapabilityPreview active={active} />
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const reducedMotion = Boolean(useReducedMotion());
  const { scrollYProgress } = useScroll();
  const pageProgress = useSpring(scrollYProgress, { stiffness: 130, damping: 30, mass: 0.25 });
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const heroScale = useTransform(heroProgress, [0, 1], [1, reducedMotion ? 1 : 0.88]);
  const heroOpacity = useTransform(heroProgress, [0, 0.8], [1, 0]);
  const heroY = useTransform(heroProgress, [0, 1], ['0%', reducedMotion ? '0%' : '18%']);

  return (
    <div className="site" id="top">
      <motion.div className="page-progress" style={{ scaleX: pageProgress }} />
      <header className="topbar">
        <a href="#top" className="brand" aria-label="Relay home">Relay</a>
        <nav aria-label="Primary navigation">
          <a href="#system">Premise</a>
          <a href="#product">Product</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <a className="beta-link" href="#product">Private beta <ArrowUpRight size={13} /></a>
      </header>

      <main>
        <section className="hero" ref={heroRef}>
          <motion.div className="hero-inner" style={{ scale: heroScale, opacity: heroOpacity, y: heroY }}>
            <div className="hero-scene">
              {reducedMotion ? <SceneFallback /> : <SafeRelayLoom variant="hero" />}
            </div>
            <div className="hero-label hero-label-left">REMOTE INTENT</div>
            <div className="hero-label hero-label-right">LOCAL EXECUTION</div>
            <TextPressure text="RELAY" className="hero-pressure" minFontSize={68} />
            <div className="hero-copy">
              <h2>Carry the work.<br /><em>Not the workstation.</em></h2>
              <p>Relay is the private iPhone control surface for agent work running on your machine.</p>
            </div>
            <a className="hero-scroll" href="#system"><span>Enter the handoff</span><ArrowDown size={16} /></a>
            <div className="hero-count">01 / 05</div>
          </motion.div>
        </section>

        <Thesis />
        <HandoffStory reducedMotion={reducedMotion} />
        <CapabilityIndex />

        <section className="privacy" id="privacy">
          <div className="privacy-kicker">03 — THE BOUNDARY</div>
          <Reveal>
            <h2>Your machine.<br />Your accounts.<br />Your files.</h2>
          </Reveal>
          <div className="privacy-rules">
            <Reveal delay={0.05}><span>01</span><p>Agent subscription state stays isolated on the runner.</p></Reveal>
            <Reveal delay={0.12}><span>02</span><p>Every file and agent route stays inside registered workspace boundaries.</p></Reveal>
            <Reveal delay={0.19}><span>03</span><p>Trial infrastructure is optional, short-lived, and named plainly when used.</p></Reveal>
          </div>
          <div className="privacy-stamp">AUTHENTICATED CONTROL / BOUNDED EXECUTION</div>
        </section>

        <section className="closing">
          <div className="closing-intro">04 — KEEP THE THREAD</div>
          <p>The desk is a place.<br />The work is not.</p>
          <TextPressure text="RELAY" className="closing-pressure" minFontSize={62} />
          <a href="#top" className="return-link">Return to the signal <RotateCcw size={14} /></a>
        </section>
      </main>

      <footer>
        <a href="#top" className="brand">Relay</a>
        <p>Private iPhone control for remote agent work.</p>
        <div><span>CODEX</span><span>CLAUDE CODE</span><span>CURSOR</span></div>
        <small>2026 / PRIVATE BETA</small>
      </footer>
    </div>
  );
}
