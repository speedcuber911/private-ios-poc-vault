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
    statement: 'Start in the right workspace.',
    detail: 'Choose a registered folder, agent, model, and effort level. Relay starts the run where the project already lives.',
    outcome: 'RUN FROM IPHONE',
  },
  {
    id: 'watch',
    step: '02',
    title: 'Watch',
    statement: 'Know what the agent is doing.',
    detail: 'Follow live progress and verification without reading a raw terminal stream or keeping the laptop open.',
    outcome: 'LIVE PROGRESS',
  },
  {
    id: 'steer',
    step: '03',
    title: 'Continue',
    statement: 'Continue without losing context.',
    detail: 'Send the next instruction into the same provider-locked thread and the same workspace—exactly where the work began.',
    outcome: 'SAME THREAD',
  },
  {
    id: 'open',
    step: '04',
    title: 'Review',
    statement: 'Review the result, not a wall of logs.',
    detail: 'Read the answer, inspect bounded output, and open job-scoped artifacts from the phone when the work is ready.',
    outcome: 'RESULT IN HAND',
  },
];

const cloudPhases = [
  {
    step: '01 / SEND',
    title: 'Send the task.',
    copy: 'Relay sends the instruction and thread identity—not a copy of your workspace.',
  },
  {
    step: '02 / EXECUTE',
    title: 'The cloud workspace does the work.',
    copy: 'Codex or Claude runs inside the registered project folder, with the tools and context already there.',
  },
  {
    step: '03 / RETURN',
    title: 'The result returns to the thread.',
    copy: 'Progress, the final answer, and job-scoped artifacts come back to your iPhone.',
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

function ScrollNarrativeCopy({
  className,
  progress,
  range,
  children,
}: {
  className: string;
  progress: MotionValue<number>;
  range: [number, number, number, number];
  children: React.ReactNode;
}) {
  const opacity = useTransform(progress, range, [0, 1, 1, 0]);
  const y = useTransform(progress, range, [24, 0, 0, -22]);

  return <motion.div className={className} style={{ opacity, y }}>{children}</motion.div>;
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
              <small>RUNNING</small>
            </div>
            <div className="real-laptop-task">
              <small>CHECKOUT / CODEX</small>
              <h3>Audit checkout failures<br />and ship the fix.</h3>
              <div><Check size={10} /><span>Failure isolated</span><strong>DONE</strong></div>
              <div><span className="ui-step-index">02</span><span>Focused verification</span><strong>LIVE</strong></div>
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
                  <div className="active"><i>01</i><span><strong>relay</strong><small>~/work/relay</small></span><Check size={9} /></div>
                  <div><i>02</i><span><strong>rocketizer</strong><small>~/work/rocketizer</small></span></div>
                  <div><i>03</i><span><strong>scratch</strong><small>~/work/scratch</small></span></div>
                </div>
                <div className="phone-primary-action"><span>USE RELAY</span><ArrowUpRight size={10} /></div>
              </>
            )}

            {mode === 'watch' && (
              <>
                <div className="real-phone-meta"><small>CHECKOUT · CODEX</small><span>RUNNING</span></div>
                <div className="real-phone-title">
                  <h3>Checkout repair</h3>
                  <strong>00:42</strong>
                </div>
                <div className="real-phone-user">Audit checkout failures and ship the fix.</div>
                <div className="real-phone-update">
                  <small>LIVE UPDATE</small>
                  <p>Payment failure isolated. Verification is running now.</p>
                  <div><span className="ui-step-index">03</span><span>3 checks passed</span><strong>LIVE</strong></div>
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
                <div className="real-phone-meta"><small>CHECKOUT · CODEX</small><span>RUNNING</span></div>
                <div className="real-phone-title"><h3>Continue thread</h3><strong>00:46</strong></div>
                <div className="phone-steer-agent"><small>CODEX</small><p>The payment path is fixed and the focused checks pass.</p><span>Awaiting direction</span></div>
                <div className="phone-steer-user">Run the full checkout suite too.</div>
                <div className="phone-steer-live"><span>CONTINUING WITH FULL SUITE</span></div>
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
  const transferStatusOpacity = useTransform(progress, [0.31, 0.39, 0.63, 0.72], [0, 1, 1, 0]);
  const landscapeScale = useTransform(progress, [0, 1], [1.08, 1]);
  const shadeOpacity = useTransform(progress, [0, 0.48, 1], [0.76, 0.62, 0.38]);
  const sceneOpacity = useTransform(progress, [0.88, 0.97], [1, 0]);
  const rulerScale = useSpring(scrollYProgress, { stiffness: 120, damping: 26, mass: 0.2 });

  if (reducedMotion) return <StaticHandoff />;

  return (
    <section className="handoff-story" ref={ref} id="system">
      <div className="handoff-stage">
        <motion.div className="handoff-landscape" style={{ scale: landscapeScale }} aria-hidden="true" />
        <motion.div className="handoff-shade" style={{ opacity: shadeOpacity }} aria-hidden="true" />
        <motion.div className="handoff-meta" style={{ opacity: sceneOpacity }}><span>01 — THE HANDOFF</span><small>SCROLL TO TRANSFER</small></motion.div>

        <div className="handoff-copy-stack">
          {handoffChapters.map((chapter, index) => {
            const ranges: [number, number, number, number][] = [
              [-0.05, 0, 0.18, 0.25],
              [0.18, 0.25, 0.42, 0.49],
              [0.42, 0.49, 0.66, 0.73],
              [0.66, 0.73, 0.88, 0.96],
            ];
            return (
              <ScrollNarrativeCopy className="handoff-caption" progress={progress} range={ranges[index]} key={chapter.index}>
                <span>{chapter.index}</span>
                <h2>{chapter.title}</h2>
                <p>{chapter.copy}</p>
              </ScrollNarrativeCopy>
            );
          })}
        </div>

        <motion.div className="handoff-devices" style={{ opacity: sceneOpacity }}>
          <motion.div className="laptop-motion" style={{ x: laptopX, scale: laptopScale, opacity: laptopOpacity }}>
            <LaptopVisual
              lidRotation={lidRotation}
              openOpacity={openLaptopOpacity}
              closedOpacity={closedLaptopOpacity}
            />
          </motion.div>
          <motion.svg className="handoff-signal" viewBox="0 0 1000 430" preserveAspectRatio="none" style={{ opacity: signalOpacity }} aria-hidden="true">
            <motion.path d="M 330 300 C 470 315, 565 122, 765 220" pathLength={signalProgress} />
          </motion.svg>
          <motion.div className="handoff-transfer-status" style={{ opacity: transferStatusOpacity }}>
            <span>RUN CONTINUES</span><strong>THREAD IN TRANSIT</strong>
          </motion.div>
          <motion.div className="phone-motion" style={{ x: phoneX, scale: phoneScale, rotateZ: phoneRotateZ, opacity: phoneOpacity }}>
            <PhoneVisual screenOpacity={phoneScreenOpacity} />
          </motion.div>
        </motion.div>

        <motion.div className="handoff-ruler" style={{ opacity: sceneOpacity }}><motion.span style={{ scaleX: rulerScale }} /></motion.div>
      </div>
    </section>
  );
}

function SurfaceSection() {
  const [active, setActive] = useState(surfaceMoments[1].id);
  const moment = surfaceMoments.find((item) => item.id === active) ?? surfaceMoments[0];

  return (
    <section className="control-story" id="product">
      <div className="chapter-bar chapter-bar-dark">
        <span>02 — WHAT RELAY GIVES YOU</span>
        <small>START · WATCH · CONTINUE · REVIEW</small>
      </div>
      <div className="control-intro">
        <Reveal>
          <h2>Everything you need<br /><em>after you leave the desk.</em></h2>
        </Reveal>
        <p>Relay turns a remote agent run into four clear phone actions. No miniature desktop. No terminal to babysit.</p>
      </div>

      <div className="control-layout">
        <div className="control-device">
          <motion.div
            className="control-phone"
            animate={{ rotate: active === 'steer' ? -2 : active === 'open' ? 1.5 : 0, y: active === 'start' ? 6 : 0 }}
            transition={{ duration: 0.6, ease }}
          >
            <PhoneVisual mode={moment.id as PhoneMode} />
          </motion.div>
          <div className="control-device-caption">
            <span>RELAY FOR IPHONE</span>
            <strong>{moment.outcome}</strong>
          </div>
        </div>

        <div className="control-list" role="tablist" aria-label="Relay phone controls">
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
              <div>
                <small>{item.title}</small>
                <strong>{item.statement}</strong>
                <p>{item.detail}</p>
              </div>
              <b>{active === item.id ? 'ON IPHONE' : 'VIEW'}</b>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function CloudExecutionSection({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [phase, setPhase] = useState(0);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const progress = useSpring(scrollYProgress, { stiffness: 105, damping: 27, mass: 0.24 });
  const phoneY = useTransform(progress, [0, 0.38, 0.7, 1], [18, 32, 26, -10]);
  const phoneScale = useTransform(progress, [0, 0.34, 0.68, 1], [1, 0.88, 0.88, 1.02]);
  const workspaceY = useTransform(progress, [0, 0.34, 0.7, 1], [-8, 0, -8, 14]);
  const workspaceScale = useTransform(progress, [0, 0.32, 0.7, 1], [0.93, 1.035, 1.035, 0.96]);
  const outboundTravel = useTransform(progress, [0.08, 0.34], [0, 1]);
  const outboundScale = useTransform(progress, [0.08, 0.24, 0.34], [0.74, 1, 0.72]);
  const outboundRotate = useTransform(progress, [0.08, 0.34], [-4, 0]);
  const outboundOpacity = useTransform(progress, [0.05, 0.1, 0.31, 0.37], [0, 1, 1, 0]);
  const resultTravel = useTransform(progress, [0.69, 0.92], [0, 1]);
  const resultScale = useTransform(progress, [0.69, 0.82, 0.92], [0.76, 1, 0.72]);
  const resultRotate = useTransform(progress, [0.69, 0.92], [3, 0]);
  const resultOpacity = useTransform(progress, [0.67, 0.72, 0.9, 0.96], [0, 1, 1, 0]);
  const runProgress = useTransform(progress, [0.3, 0.68], [0, 1]);
  const scanY = useTransform(progress, [0.28, 0.68], ['-20%', '330%']);
  const scanOpacity = useTransform(progress, [0.26, 0.31, 0.64, 0.7], [0, 1, 1, 0]);
  const sceneOpacity = useTransform(progress, [0.92, 0.99], [1, 0]);

  useMotionValueEvent(scrollYProgress, 'change', (latest) => {
    const nextPhase = latest < 0.3 ? 0 : latest < 0.68 ? 1 : 2;
    setPhase((current) => current === nextPhase ? current : nextPhase);
  });

  const phoneMode: PhoneMode = phase === 0 ? 'start' : phase === 1 ? 'watch' : 'open';

  return (
    <section className="cloud-story" id="privacy" ref={ref}>
      <div className="cloud-stage">
        <motion.div className="chapter-bar chapter-bar-light" style={{ opacity: sceneOpacity }}>
          <span>03 — CLOUD EXECUTION</span>
          <small>SEND · RUN · RETURN</small>
        </motion.div>

        <motion.div className="cloud-copy-stack" style={{ opacity: sceneOpacity }}>
          {cloudPhases.map((item, index) => {
            const ranges: [number, number, number, number][] = [
              [-0.05, 0, 0.24, 0.31],
              [0.24, 0.31, 0.62, 0.7],
              [0.62, 0.7, 0.9, 0.97],
            ];
            return (
              <ScrollNarrativeCopy className="cloud-copy" progress={progress} range={ranges[index]} key={item.step}>
                <span>{item.step}</span>
                <h2>{item.title}</h2>
                <p>{item.copy}</p>
              </ScrollNarrativeCopy>
            );
          })}
        </motion.div>

        <motion.div className="cloud-visual" style={{ opacity: sceneOpacity }} aria-label="A Relay job envelope leaving the iPhone, docking in the registered cloud workspace, executing against project files, and returning as a result bundle">
          <motion.div className="cloud-phone" style={{ y: reducedMotion ? 0 : phoneY, scale: reducedMotion ? 1 : phoneScale }}>
            <PhoneVisual mode={phoneMode} />
            <small>IPHONE / CONTROL</small>
          </motion.div>

          <motion.div className="cloud-workspace-wrap" style={{ y: reducedMotion ? 0 : workspaceY, scale: reducedMotion ? 1 : workspaceScale }}>
            <div className="cloud-workspace">
              <div className="cloud-workspace-bar">
                <span>RELAY CLOUD WORKSPACE</span>
                <small>{phase === 0 ? 'READY' : phase === 1 ? 'EXECUTING' : 'COMPLETE'}</small>
              </div>
              <div className="cloud-workspace-body">
                <motion.div className="cloud-run-scan" style={{ y: reducedMotion ? 0 : scanY, opacity: reducedMotion ? 0 : scanOpacity }} aria-hidden="true" />
                <div className="cloud-workspace-title">
                  <small>CHECKOUT / CODEX</small>
                  <h3>Audit checkout failures<br />and ship the fix.</h3>
                </div>
                <div className="cloud-job-dock">
                  <span>JOB 7F2A</span>
                  <strong>{phase === 0 ? 'AWAITING HANDOFF' : phase === 1 ? 'EXECUTING IN WORKSPACE' : 'RESULT SEALED'}</strong>
                </div>
                <div className={`cloud-run-step ${phase >= 1 ? 'complete' : ''}`}>
                  <span>01</span><strong>Read payment path <em>checkout/payment.ts</em></strong><small>{phase >= 1 ? 'DONE' : 'QUEUED'}</small>
                </div>
                <div className={`cloud-run-step ${phase === 1 ? 'active' : phase > 1 ? 'complete' : ''}`}>
                  <span>02</span><strong>Run focused verification <em>checkout.test.ts</em></strong><small>{phase === 1 ? 'RUNNING' : phase > 1 ? 'DONE' : 'QUEUED'}</small>
                </div>
                <div className={`cloud-run-step ${phase > 1 ? 'complete' : ''}`}>
                  <span>03</span><strong>Seal result bundle <em>3 files · 12 checks</em></strong><small>{phase > 1 ? 'READY' : 'QUEUED'}</small>
                </div>
                <div className="cloud-run-progress"><motion.i style={{ scaleX: reducedMotion ? 1 : runProgress }} /></div>
              </div>
              <div className="cloud-workspace-foot">
                <span>REGISTERED WORKSPACE</span>
                <strong>/srv/relay-workspaces/checkout</strong>
              </div>
            </div>
            <small>CLOUD WORKSPACE / EXECUTION</small>
          </motion.div>

          <motion.div
            className="cloud-job-card cloud-job-card-out"
            style={{ opacity: reducedMotion ? 0 : outboundOpacity, scale: reducedMotion ? 1 : outboundScale, rotate: reducedMotion ? 0 : outboundRotate, '--travel': outboundTravel } as unknown as React.CSSProperties}
          >
            <small>JOB 7F2A / OUTBOUND</small>
            <strong>Audit checkout failures</strong>
            <span>THREAD ID + WORKSPACE ID</span>
          </motion.div>
          <motion.div
            className="cloud-job-card cloud-job-card-back"
            style={{ opacity: reducedMotion ? 0 : resultOpacity, scale: reducedMotion ? 1 : resultScale, rotate: reducedMotion ? 0 : resultRotate, '--travel': resultTravel } as unknown as React.CSSProperties}
          >
            <small>RESULT 7F2A / RETURN</small>
            <strong>Checkout recovery ready</strong>
            <span>3 FILES · 12 CHECKS · PREVIEW</span>
          </motion.div>
        </motion.div>

        <motion.div className="cloud-proof" style={{ opacity: sceneOpacity }}>
          <span>MTLS-PROTECTED</span>
          <span>REGISTERED WORKSPACE</span>
          <span>JOB-SCOPED RESULTS</span>
        </motion.div>
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
          <a href="#privacy">Cloud</a>
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

        <CloudExecutionSection reducedMotion={reducedMotion} />

        <section className="closing-v4" id="start-relay">
          <div className="closing-v4-topline">
            <span>04 — KEEP MOVING</span>
            <small>RELAY / PRIVATE BETA</small>
          </div>
          <div className="closing-v4-layout">
            <div className="closing-v4-copy">
              <Reveal><h2>One command.<br /><em>Then walk away.</em></h2></Reveal>
              <p>Install Relay, choose the registered workspace, and start the agent. Execution stays with the runner; the live thread stays with you.</p>
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
              <div className="closing-v4-note"><span>The runner keeps the workspace. iPhone keeps the thread.</span></div>
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
