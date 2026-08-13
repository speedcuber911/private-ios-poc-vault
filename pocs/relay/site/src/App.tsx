import { useRef, useState } from 'react';
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import { ArrowDown, ArrowUpRight, Check, Copy, RotateCcw } from 'lucide-react';
import TextPressure from './components/reactbits/TextPressure';

const ease = [0.16, 1, 0.3, 1] as const;
const installCommand = "curl --proto '=https' --tlsv1.2 -fsSL https://get.openrelay.sh/install.sh | sh";
const relayAppOrigin = import.meta.env.VITE_RELAY_APP_ORIGIN || '#';

const capabilities = [
  {
    id: 'files',
    title: 'Files',
    label: 'Start with the real workspace',
    copy: 'Choose a registered folder. Relay sends the task to the machine that already has the code, tools, and context.',
  },
  {
    id: 'runs',
    title: 'Runs',
    label: 'Leave the long task running',
    copy: 'Start Codex, Claude Code, or Cursor work, follow live progress, and cancel when the direction changes.',
  },
  {
    id: 'threads',
    title: 'Threads',
    label: 'Continue without reconstructing',
    copy: 'Every conversation stays attached to the workspace where it began, even after you leave the desk.',
  },
  {
    id: 'previews',
    title: 'Previews',
    label: 'See the result on your phone',
    copy: 'Open authenticated POCs and bounded artifacts directly from the completed run.',
  },
];

const handoffChapters = [
  {
    index: '01 / START',
    title: 'Begin where the work lives.',
    copy: 'Pick the registered workspace on your machine. Relay starts the agent with the real files, tools, and account context.',
  },
  {
    index: '02 / LEAVE',
    title: 'Now close the laptop.',
    copy: 'Execution stays on the runner. The job does not depend on a miniature desktop or a remote screen.',
  },
  {
    index: '03 / RECEIVE',
    title: 'The live thread meets you on iPhone.',
    copy: 'Progress, logs, approvals, and results arrive in a control surface designed for the phone.',
  },
  {
    index: '04 / CONTINUE',
    title: 'Review it. Continue it. Move on.',
    copy: 'Open the artifact, answer the agent, or leave it running—without returning to the desk.',
  },
];

function Reveal({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.8, delay, ease }}
    >
      {children}
    </motion.div>
  );
}

function LaptopVisual({
  lidRotation = 0,
  screenOpacity = 1,
}: {
  lidRotation?: number | MotionValue<number>;
  screenOpacity?: number | MotionValue<number>;
}) {
  return (
    <div className="laptop">
      <motion.div className="laptop-lid" style={{ rotateX: lidRotation }}>
        <motion.div className="laptop-screen" style={{ opacity: screenOpacity }}>
          <div className="laptop-toolbar">
            <div><i /><i /><i /></div>
            <span>relay / checkout</span>
            <small>RUNNING</small>
          </div>
          <div className="laptop-workspace">
            <div className="laptop-rail"><span>01</span><span>02</span><span>03</span></div>
            <div className="laptop-task">
              <small>CODEX · TASK</small>
              <h3>Audit checkout failures and ship the fix.</h3>
              <div className="laptop-step done"><Check size={12} /><span>Read workspace contract</span><small>done</small></div>
              <div className="laptop-step done"><Check size={12} /><span>Trace the failed path</span><small>done</small></div>
              <div className="laptop-step live"><i /><span>Run focused verification</span><small>live</small></div>
            </div>
          </div>
        </motion.div>
      </motion.div>
      <div className="laptop-base"><span /></div>
    </div>
  );
}

function PhoneVisual() {
  return (
    <div className="phone">
      <div className="phone-frame">
        <div className="phone-island" />
        <div className="phone-screen">
          <div className="phone-top"><strong>Relay</strong><span>Running <i /></span></div>
          <div className="phone-context"><small>CHECKOUT · CODEX</small><strong>00:42</strong></div>
          <h3>Checkout repair</h3>
          <p className="phone-prompt">Audit checkout failures and ship the fix.</p>
          <div className="phone-update">
            <small>LIVE UPDATE</small>
            <p>The failed payment path is isolated. Running the focused verification now.</p>
          </div>
          <div className="phone-result"><span>3 files changed</span><strong>checks passing</strong></div>
          <div className="phone-action">Continue thread <ArrowUpRight size={13} /></div>
        </div>
      </div>
    </div>
  );
}

function StaticHandoff() {
  return (
    <section className="handoff-static" id="system">
      <div className="handoff-landscape" aria-hidden="true" />
      <div className="handoff-static-copy">
        <span>01 — THE HANDOFF</span>
        <h2>Close the lid.<br />Keep the thread.</h2>
        <p>Relay leaves execution on your machine and carries the controls to your phone.</p>
      </div>
      <div className="handoff-static-devices"><LaptopVisual /><PhoneVisual /></div>
    </section>
  );
}

function HandoffStory({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [activeChapter, setActiveChapter] = useState(0);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const progress = useSpring(scrollYProgress, { stiffness: 105, damping: 25, mass: 0.22 });
  const lidRotation = useTransform(progress, [0.12, 0.34], [0, -88]);
  const screenOpacity = useTransform(progress, [0.12, 0.3], [1, 0.18]);
  const laptopX = useTransform(progress, [0.18, 0.62], ['0vw', '-17vw']);
  const laptopY = useTransform(progress, [0.18, 0.48], [0, 54]);
  const laptopScale = useTransform(progress, [0.2, 0.62], [1, 0.7]);
  const laptopOpacity = useTransform(progress, [0.58, 0.84], [1, 0.28]);
  const phoneX = useTransform(progress, [0.38, 0.62, 0.86], ['12vw', '0vw', '-4vw']);
  const phoneY = useTransform(progress, [0.38, 0.6], [62, 0]);
  const phoneScale = useTransform(progress, [0.38, 0.62], [0.84, 1]);
  const phoneOpacity = useTransform(progress, [0.36, 0.52], [0, 1]);
  const signalProgress = useTransform(progress, [0.3, 0.58], [0, 1]);
  const signalOpacity = useTransform(progress, [0.28, 0.4, 0.68, 0.78], [0, 1, 1, 0]);
  const signalArrivalOpacity = useTransform(signalProgress, [0.9, 1], [0, 1]);
  const landscapeScale = useTransform(progress, [0, 1], [1.08, 1]);
  const shadeOpacity = useTransform(progress, [0, 0.48, 1], [0.76, 0.62, 0.38]);
  const rulerScale = useSpring(scrollYProgress, { stiffness: 120, damping: 26, mass: 0.2 });

  useMotionValueEvent(scrollYProgress, 'change', (latest) => {
    const nextChapter = latest < 0.235 ? 0 : latest < 0.475 ? 1 : latest < 0.735 ? 2 : 3;
    setActiveChapter((current) => current === nextChapter ? current : nextChapter);
  });

  if (reducedMotion) return <StaticHandoff />;

  return (
    <section className="handoff-story" ref={ref} id="system">
      <div className="handoff-stage">
        <motion.div className="handoff-landscape" style={{ scale: landscapeScale }} aria-hidden="true" />
        <motion.div className="handoff-shade" style={{ opacity: shadeOpacity }} aria-hidden="true" />
        <div className="handoff-meta"><span>01 — THE HANDOFF</span><small>SCROLL TO TRANSFER</small></div>

        <AnimatePresence mode="wait">
          <motion.div
            className="handoff-caption"
            key={handoffChapters[activeChapter].index}
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -18 }}
            transition={{ duration: 0.34, ease }}
          >
            <span>{handoffChapters[activeChapter].index}</span>
            <h2>{handoffChapters[activeChapter].title}</h2>
            <p>{handoffChapters[activeChapter].copy}</p>
          </motion.div>
        </AnimatePresence>

        <div className="handoff-devices">
          <motion.div className="laptop-motion" style={{ x: laptopX, y: laptopY, scale: laptopScale, opacity: laptopOpacity }}>
            <LaptopVisual lidRotation={lidRotation} screenOpacity={screenOpacity} />
          </motion.div>
          <motion.svg className="handoff-signal" viewBox="0 0 1000 430" preserveAspectRatio="none" style={{ opacity: signalOpacity }} aria-hidden="true">
            <motion.path d="M 345 282 C 500 155, 620 150, 760 230" pathLength={signalProgress} />
            <motion.circle cx="760" cy="230" r="7" style={{ opacity: signalArrivalOpacity }} />
          </motion.svg>
          <motion.div className="phone-motion" style={{ x: phoneX, y: phoneY, scale: phoneScale, opacity: phoneOpacity }}>
            <PhoneVisual />
          </motion.div>
        </div>

        <div className="handoff-ruler"><motion.span style={{ scaleX: rulerScale }} /></div>
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
        initial={{ opacity: 0, y: 22, clipPath: 'inset(0 0 12% 0)' }}
        animate={{ opacity: 1, y: 0, clipPath: 'inset(0 0 0% 0)' }}
        exit={{ opacity: 0, y: -14, clipPath: 'inset(12% 0 0 0)' }}
        transition={{ duration: 0.48, ease }}
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
            <div className="run-prompt">“Audit checkout failures and ship the fix.”</div>
            {['Read workspace contract', 'Trace the failed path', 'Run focused verification'].map((item, index) => (
              <div className="run-line" key={item}><Check size={14} /><span>{item}</span><small>{index === 2 ? 'live' : 'done'}</small></div>
            ))}
          </div>
        )}
        {active === 'threads' && (
          <div className="threads-preview">
            <div className="thread-question">Make the failed checkout recoverable.</div>
            <div className="thread-answer"><span>CODEX / TASK</span><p>The payment failure is isolated and the focused verification is running now.</p></div>
            <div className="thread-proof">3 files changed <strong>checks passing</strong></div>
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
        <h2>Everything you need.<br />Nothing you do not.</h2>
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
        <div className="capability-preview-wrap"><CapabilityPreview active={active} /></div>
      </div>
    </section>
  );
}

export default function App() {
  const [installCopied, setInstallCopied] = useState(false);
  const reducedMotion = Boolean(useReducedMotion());
  const { scrollYProgress } = useScroll();
  const pageProgress = useSpring(scrollYProgress, { stiffness: 130, damping: 30, mass: 0.25 });
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const heroScale = useTransform(heroProgress, [0, 1], [1, reducedMotion ? 1 : 0.96]);
  const heroOpacity = useTransform(heroProgress, [0, 0.86], [1, 0]);
  const heroY = useTransform(heroProgress, [0, 1], ['0%', reducedMotion ? '0%' : '8%']);

  const copyInstallCommand = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = installCommand;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      textArea.remove();
    }

    setInstallCopied(true);
    window.setTimeout(() => setInstallCopied(false), 1800);
  };

  return (
    <div className="site" id="top">
      <motion.div className="page-progress" style={{ scaleX: pageProgress }} />
      <header className="topbar">
        <a href="#top" className="brand" aria-label="Relay home">Relay</a>
        <nav aria-label="Primary navigation">
          <a href="#system">How it works</a>
          <a href="#product">Product</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <a className="beta-link" href={`${relayAppOrigin}/login`}>Sign in <ArrowUpRight size={13} /></a>
      </header>

      <main>
        <section className="hero" ref={heroRef}>
          <motion.div className="hero-inner" style={{ scale: heroScale, opacity: heroOpacity, y: heroY }}>
            <div className="hero-landscape" aria-hidden="true" />
            <div className="hero-landscape-shade" aria-hidden="true" />
            <div className="hero-label hero-label-left">YOUR MACHINE</div>
            <div className="hero-label hero-label-right">YOUR IPHONE</div>
            <TextPressure text="RELAY" className="hero-pressure" minFontSize={64} maxFontSize={220} />
            <div className="hero-install" role="group" aria-label="Install the Relay CLI">
              <span className="hero-install-label">Install CLI</span>
              <code><i aria-hidden="true">$</i><span>{installCommand}</span></code>
              <button type="button" onClick={copyInstallCommand} aria-label={installCopied ? 'Install command copied' : 'Copy install command'}>
                {installCopied ? <Check size={16} /> : <Copy size={16} />}
                <span aria-live="polite">{installCopied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <div className="hero-copy">
              <h2>Start it at your desk.<br /><em>Carry it anywhere.</em></h2>
              <p>Launch, watch, and continue agent work from your iPhone while the machine with your files does the execution.</p>
            </div>
            <div className="hero-product-line" aria-hidden="true"><span>WORKSPACE</span><i /><strong>RELAY</strong><i /><span>IPHONE</span></div>
            <a className="hero-scroll" href="#system"><span>See the handoff</span><ArrowDown size={16} /></a>
            <div className="hero-count">01 / 04</div>
          </motion.div>
        </section>

        <HandoffStory reducedMotion={reducedMotion} />
        <CapabilityIndex />

        <section className="privacy" id="privacy">
          <div className="privacy-kicker">03 — THE BOUNDARY</div>
          <Reveal><h2>Your machine.<br />Your accounts.<br />Your files.</h2></Reveal>
          <div className="privacy-rules">
            <Reveal delay={0.04}><span>01</span><p>Agent subscription state stays isolated on the runner.</p></Reveal>
            <Reveal delay={0.1}><span>02</span><p>Every file and agent route stays inside registered workspace boundaries.</p></Reveal>
            <Reveal delay={0.16}><span>03</span><p>Trial infrastructure is optional, short-lived, and named plainly when used.</p></Reveal>
          </div>
          <div className="privacy-stamp">AUTHENTICATED CONTROL / BOUNDED EXECUTION</div>
        </section>

        <section className="closing">
          <div className="closing-intro">04 — KEEP THE THREAD</div>
          <p>Close the lid.<br />Keep the thread.</p>
          <TextPressure text="RELAY" className="closing-pressure" minFontSize={58} maxFontSize={190} />
          <a href="#top" className="return-link">Return to the beginning <RotateCcw size={14} /></a>
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
