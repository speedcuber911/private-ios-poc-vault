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

const surfaceMoments = [
  {
    id: 'start',
    step: '01',
    title: 'Start',
    statement: 'Choose the real workspace.',
    signal: 'WORKSPACE READY',
  },
  {
    id: 'watch',
    step: '02',
    title: 'Watch',
    statement: 'See the run as it happens.',
    signal: 'VERIFICATION LIVE',
  },
  {
    id: 'steer',
    step: '03',
    title: 'Steer',
    statement: 'Continue the same thread.',
    signal: 'CONTEXT INTACT',
  },
  {
    id: 'open',
    step: '04',
    title: 'Open',
    statement: 'Review the finished work.',
    signal: 'RESULT READY',
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
  openOpacity = 1,
  closedOpacity = 0,
}: {
  lidRotation?: number | MotionValue<number>;
  openOpacity?: number | MotionValue<number>;
  closedOpacity?: number | MotionValue<number>;
}) {
  return (
    <div className="real-laptop">
      <motion.div className="real-laptop-open" style={{ opacity: openOpacity }}>
        <div className="real-laptop-base-photo"><img src="/devices/laptop-open-trim.webp" alt="" /></div>
        <motion.div className="real-laptop-lid-photo" style={{ rotateX: lidRotation }}>
          <img src="/devices/laptop-open-trim.webp" alt="" />
          <div className="real-laptop-screen">
            <div className="real-laptop-bar">
              <span>Relay</span>
              <small><i /> RUNNING</small>
            </div>
            <div className="real-laptop-task">
              <small>CHECKOUT / CODEX</small>
              <h3>Audit checkout failures<br />and ship the fix.</h3>
              <div><Check size={10} /><span>Failure isolated</span><strong>DONE</strong></div>
              <div><i /><span>Focused verification</span><strong>LIVE</strong></div>
            </div>
          </div>
        </motion.div>
      </motion.div>
      <motion.img className="real-laptop-closed" src="/devices/laptop-closed-trim.webp" alt="" style={{ opacity: closedOpacity }} />
    </div>
  );
}

type PhoneMode = 'start' | 'watch' | 'steer' | 'open';

function PhoneVisual({
  screenOpacity = 1,
  mode = 'watch',
}: {
  screenOpacity?: number | MotionValue<number>;
  mode?: PhoneMode;
}) {
  return (
    <div className="real-phone">
      <img src="/devices/phone-v2-trim.webp" alt="" />
      <motion.div className="real-phone-screen" style={{ opacity: screenOpacity }}>
        <div className="real-phone-statusbar">
          <strong>9:41</strong>
          <div><i /><i /><span /></div>
        </div>
        <div className="real-phone-nav">
          <span>{mode === 'start' ? 'Workspaces' : 'Threads'}</span>
          <strong>Relay</strong>
          <i>KM</i>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            className={`real-phone-view real-phone-view-${mode}`}
            key={mode}
            initial={{ opacity: 0, x: 14, filter: 'blur(5px)' }}
            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: -12, filter: 'blur(4px)' }}
            transition={{ duration: 0.32, ease }}
          >
            {mode === 'start' && (
              <>
                <div className="phone-mode-kicker">NEW RUN / 01</div>
                <div className="phone-mode-heading">Choose the<br />workspace.</div>
                <div className="phone-workspace-list">
                  <div className="active"><i>R</i><span><strong>relay</strong><small>~/work/relay</small></span><Check size={9} /></div>
                  <div><i>R</i><span><strong>rocketizer</strong><small>~/work/rocketizer</small></span></div>
                  <div><i>S</i><span><strong>scratch</strong><small>~/work/scratch</small></span></div>
                </div>
                <div className="phone-primary-action"><span>USE RELAY</span><ArrowUpRight size={10} /></div>
              </>
            )}

            {mode === 'watch' && (
              <>
                <div className="real-phone-meta"><small>CHECKOUT · CODEX</small><span><i /> RUNNING</span></div>
                <div className="real-phone-title">
                  <h3>Checkout repair</h3>
                  <strong>00:42</strong>
                </div>
                <div className="real-phone-user">Audit checkout failures and ship the fix.</div>
                <div className="real-phone-update">
                  <small>LIVE UPDATE</small>
                  <p>Payment failure isolated. Verification is running now.</p>
                  <div><i /><span>3 checks passed</span><strong>LIVE</strong></div>
                </div>
                <div className="real-phone-result">
                  <div><small>RESULT</small><strong>Ready to review</strong></div>
                  <ArrowUpRight size={10} />
                </div>
                <div className="real-phone-composer"><span>Continue thread</span><i><ArrowUpRight size={10} /></i></div>
              </>
            )}

            {mode === 'steer' && (
              <>
                <div className="real-phone-meta"><small>CHECKOUT · CODEX</small><span><i /> RUNNING</span></div>
                <div className="real-phone-title"><h3>Continue thread</h3><strong>00:46</strong></div>
                <div className="phone-steer-agent"><small>CODEX</small><p>The payment path is fixed and the focused checks pass.</p><span><i /> Awaiting direction</span></div>
                <div className="phone-steer-user">Run the full checkout suite too.</div>
                <div className="phone-steer-live"><i /><span>CONTINUING WITH FULL SUITE</span></div>
                <div className="real-phone-composer phone-composer-active"><span>Send another direction</span><i><ArrowUpRight size={10} /></i></div>
              </>
            )}

            {mode === 'open' && (
              <>
                <div className="phone-mode-kicker">RUN COMPLETE / 04</div>
                <div className="phone-complete-mark"><Check size={19} /></div>
                <div className="phone-complete-heading">Ready to<br />review.</div>
                <div className="phone-complete-proof"><span><strong>03</strong> files</span><span><strong>12</strong> checks</span></div>
                <div className="phone-artifact-card">
                  <div><small>PRIVATE PREVIEW</small><strong>Checkout recovery</strong></div>
                  <ArrowUpRight size={11} />
                </div>
                <div className="phone-primary-action phone-open-action"><span>OPEN RESULT</span><ArrowUpRight size={10} /></div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
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
  const lidRotation = useTransform(progress, [0.13, 0.3], [0, -82]);
  const openLaptopOpacity = useTransform(progress, [0, 0.28, 0.34], [1, 1, 0]);
  const closedLaptopOpacity = useTransform(progress, [0.28, 0.35, 0.78, 0.9], [0, 1, 1, 0.18]);
  const laptopX = useTransform(progress, [0.3, 0.64], ['0vw', '-19vw']);
  const laptopScale = useTransform(progress, [0.3, 0.64], [1, 0.72]);
  const laptopOpacity = useTransform(progress, [0.72, 0.9], [1, 0.2]);
  const phoneX = useTransform(progress, [0.42, 0.65, 0.9], ['13vw', '0vw', '-2vw']);
  const phoneScale = useTransform(progress, [0.42, 0.66], [0.88, 1]);
  const phoneRotateZ = useTransform(progress, [0.42, 0.67], [2, 0]);
  const phoneOpacity = useTransform(progress, [0.39, 0.55], [0, 1]);
  const phoneScreenOpacity = useTransform(progress, [0.43, 0.58], [0.35, 1]);
  const signalProgress = useTransform(progress, [0.31, 0.61], [0, 1]);
  const signalOpacity = useTransform(progress, [0.29, 0.4, 0.69, 0.8], [0, 1, 1, 0]);
  const signalArrivalOpacity = useTransform(signalProgress, [0.86, 1], [0, 1]);
  const transferStatusOpacity = useTransform(progress, [0.31, 0.39, 0.63, 0.72], [0, 1, 1, 0]);
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
          <motion.div className="laptop-motion" style={{ x: laptopX, scale: laptopScale, opacity: laptopOpacity }}>
            <LaptopVisual
              lidRotation={lidRotation}
              openOpacity={openLaptopOpacity}
              closedOpacity={closedLaptopOpacity}
            />
          </motion.div>
          <motion.svg className="handoff-signal" viewBox="0 0 1000 430" preserveAspectRatio="none" style={{ opacity: signalOpacity }} aria-hidden="true">
            <motion.path className="signal-halo" d="M 330 300 C 470 315, 565 122, 765 220" pathLength={signalProgress} />
            <motion.path d="M 330 300 C 470 315, 565 122, 765 220" pathLength={signalProgress} />
            <motion.path className="signal-trail signal-trail-one" d="M 330 300 C 470 315, 565 122, 765 220" pathLength={signalProgress} />
            <motion.path className="signal-trail signal-trail-two" d="M 330 300 C 470 315, 565 122, 765 220" pathLength={signalProgress} />
            <motion.circle cx="765" cy="220" r="8" style={{ opacity: signalArrivalOpacity }} />
            <motion.circle className="signal-ring" cx="765" cy="220" r="18" style={{ opacity: signalArrivalOpacity }} />
          </motion.svg>
          <motion.div className="handoff-transfer-status" style={{ opacity: transferStatusOpacity }}>
            <i /><span>RUN CONTINUES</span><strong>THREAD IN TRANSIT</strong>
          </motion.div>
          <motion.div className="phone-motion" style={{ x: phoneX, scale: phoneScale, rotateZ: phoneRotateZ, opacity: phoneOpacity }}>
            <PhoneVisual screenOpacity={phoneScreenOpacity} />
          </motion.div>
        </div>

        <div className="handoff-ruler"><motion.span style={{ scaleX: rulerScale }} /></div>
      </div>
    </section>
  );
}

function SurfaceSection() {
  const [active, setActive] = useState(surfaceMoments[1].id);
  const moment = surfaceMoments.find((item) => item.id === active) ?? surfaceMoments[0];

  return (
    <section className="surface-v3" id="product">
      <div className="surface-v3-topline">
        <span>02 — THE LIVE THREAD</span>
        <small>START · WATCH · STEER · OPEN</small>
      </div>
      <Reveal className="surface-v3-heading">
        <h2>The whole run.<br /><em>In your hand.</em></h2>
      </Reveal>

      <div className={`surface-v3-stage moment-${moment.id}`}>
        <div className="surface-v3-orbit" aria-hidden="true">
          <i /><i /><i />
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            className="surface-v3-statement"
            key={moment.id}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -18 }}
            transition={{ duration: 0.42, ease }}
          >
            <span>{moment.step} / 04</span>
            <strong>{moment.title}</strong>
            <p>{moment.statement}</p>
          </motion.div>
        </AnimatePresence>

        <motion.div
          className="surface-v3-phone"
          animate={{ rotate: active === 'steer' ? -3 : active === 'open' ? 2 : 0, y: active === 'start' ? 8 : 0 }}
          transition={{ duration: 0.7, ease }}
        >
          <div className="surface-v3-phone-aura" aria-hidden="true" />
          <PhoneVisual mode={moment.id as PhoneMode} />
        </motion.div>

        <AnimatePresence mode="wait">
          <motion.div
            className="surface-v3-signal"
            key={moment.signal}
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.36, ease }}
          >
            <i /><span>{moment.signal}</span>
          </motion.div>
        </AnimatePresence>

        <div className="surface-v3-rail" role="tablist" aria-label="Relay control moments">
          {surfaceMoments.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={active === item.id}
              className={active === item.id ? 'active' : ''}
              key={item.id}
              onClick={() => setActive(item.id)}
              onPointerEnter={() => setActive(item.id)}
              onFocus={() => setActive(item.id)}
            >
              <span>{item.step}</span>
              <strong>{item.title}</strong>
            </button>
          ))}
        </div>
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
        <a className="beta-link" href="#product">Private beta <ArrowUpRight size={13} /></a>
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
          </motion.div>
        </section>

        <HandoffStory reducedMotion={reducedMotion} />
        <SurfaceSection />

        <section className="story-v6" id="privacy">
          <div className="story-v6-topline">
            <span>03 — PRIVATE EXECUTION</span>
            <small>PHONE → WORKSPACE → RESULT</small>
          </div>

          <Reveal className="story-v6-canvas">
            <img
              src="/relay-private-compute-v1.webp"
              alt="A phone sending a task into a protected private workspace and receiving the finished result"
              loading="lazy"
              decoding="async"
            />
            <div className="story-v6-copy">
              <h2>A whole machine.<br /><em>Just for your task.</em></h2>
              <p>Relay opens a private cloud workspace, lets your agent do the work there, then sends the finished result back to your phone.</p>
            </div>
          </Reveal>

          <div className="story-v6-flow" aria-label="How Relay cloud execution works">
            <div><small>01</small><strong>Send a task</strong><span>From your phone</span></div>
            <i aria-hidden="true" />
            <div><small>02</small><strong>Work privately</strong><span>Inside your workspace</span></div>
            <i aria-hidden="true" />
            <div><small>03</small><strong>Get the result</strong><span>Back on your phone</span></div>
          </div>

          <div className="story-v6-proof">
            <span><i /> One workspace per user</span>
            <span><i /> Encrypted connection</span>
            <span><i /> Cleared after the trial</span>
          </div>
        </section>

        <section className="closing-v4" id="start-relay">
          <div className="closing-v4-topline">
            <span>04 — KEEP MOVING</span>
            <small>RELAY / PRIVATE BETA</small>
          </div>
          <div className="closing-v4-layout">
            <div className="closing-v4-copy">
              <Reveal><h2>One command.<br /><em>Then walk away.</em></h2></Reveal>
              <p>Install Relay on the machine that holds your work. Start the agent there. Keep the live thread on iPhone.</p>
              <Reveal className="closing-v4-action" delay={0.08}>
                <div>
                  <small>INSTALL RELAY CLI</small>
                  <code><i>$</i> curl -fsSL get.openrelay.sh/install.sh | sh</code>
                </div>
                <button type="button" onClick={copyInstallCommand} aria-label={installCopied ? 'Install command copied' : 'Copy install command'}>
                  {installCopied ? <Check size={16} /> : <Copy size={16} />}
                  <span>{installCopied ? 'COPIED' : 'COPY'}</span>
                </button>
              </Reveal>
              <div className="closing-v4-note"><i /><span>Files and execution stay on your machine.</span></div>
            </div>
            <Reveal className="closing-v4-device" delay={0.1}>
              <div className="closing-v4-halo" aria-hidden="true"><i /><i /></div>
              <PhoneVisual mode="open" />
            </Reveal>
          </div>
          <div className="closing-v4-bottom">
            <strong>RELAY</strong>
            <a href="#top" className="return-link">Back to top <RotateCcw size={14} /></a>
          </div>
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
