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
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  Cpu,
  Gauge,
  MessageCircleMore,
  Mic,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  SquarePen,
  Terminal,
} from 'lucide-react';

const ease = [0.16, 1, 0.3, 1] as const;
const installCommand = "curl --proto '=https' --tlsv1.2 -fsSL https://get.openrelay.sh/install.sh | sh";

const chapters = [
  { time: '10:18', title: 'Start on your Mac.', copy: 'Relay begins inside the folder that already has the work.' },
  { time: '10:20', title: 'Let it keep moving.', copy: 'The live run stays visible without keeping you at the screen.' },
  { time: '10:34', title: 'Review on iPhone.', copy: 'The same thread arrives with the result—not a miniature desktop.' },
];

function Reveal({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const reducedMotion = Boolean(useReducedMotion());
  return (
    <motion.div
      className={className}
      initial={reducedMotion ? false : { opacity: 0, y: 22 }}
      whileInView={reducedMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.18 }}
      transition={{ duration: 0.8, delay, ease }}
    >
      {children}
    </motion.div>
  );
}

function MacWorkspace({
  screenOpacity = 1,
  progress = 1,
}: {
  screenOpacity?: number | MotionValue<number>;
  progress?: number | MotionValue<number>;
}) {
  return (
    <div className="mac-device">
      <div className="mac-shadow" aria-hidden="true" />
      <img className="mac-hardware" src="/imac-hardware-v2.png" alt="" aria-hidden="true" />
      <motion.div className="mac-screen" style={{ opacity: screenOpacity }}>
        <div className="mac-titlebar"><span>● ● ●</span><strong>checkout</strong><small>10:18</small></div>
        <div className="mac-body">
          <aside><b>RELAY</b><span>checkout</span><span className="selected">payment.ts</span><span>retry.ts</span><span>tests</span></aside>
          <main>
            <div className="mac-tabs"><span>payment.ts</span><span>checkout.test.ts</span></div>
            <div className="mac-code"><i /><i className="indent" /><i className="blue" /><i /><i className="green" /><i /></div>
            <div className="mac-job"><div><span>RUNNING · CODEX</span><small>2 / 3 checks</small></div><b><motion.i style={{ scaleX: progress }} /></b></div>
          </main>
        </div>
      </motion.div>
      <div className="mac-reflection" aria-hidden="true" />
    </div>
  );
}

type PhoneMotionProps = {
  userOpacity?: number | MotionValue<number>;
  jobOpacity?: number | MotionValue<number>;
  runningOpacity?: number | MotionValue<number>;
  resultOpacity?: number | MotionValue<number>;
  resultY?: number | MotionValue<number>;
  progress?: number | MotionValue<number>;
};

function RelayPhone({
  userOpacity = 1,
  jobOpacity = 1,
  runningOpacity = 1,
  resultOpacity = 0,
  resultY = 10,
  progress = 1,
}: PhoneMotionProps) {
  return (
    <div className="relay-phone">
      <img className="phone-hardware" src="/phone-hardware-v3-cropped.png" alt="" aria-hidden="true" />
      <div className="phone-screen">
        <div className="dynamic-island" aria-hidden="true" />
        <div className="phone-status"><span>9:41</span><div aria-hidden="true"><i className="signal" /><i className="wifi" /><i className="battery" /></div></div>

        <div className="app-topbar">
          <SquarePen />
          <div><strong>checkout</strong><small>~/work/checkout</small></div>
        </div>
        <div className="threads-access"><MessageCircleMore /><strong>Threads</strong><span>8</span><ChevronRight /></div>

        <div className="phone-conversation">
          <motion.div className="phone-user-bubble" style={{ opacity: userOpacity }}>
            <small>YOU</small>
            <p>Audit checkout failures, fix the duplicate capture, and run focused tests.</p>
          </motion.div>

          <motion.div className="phone-job-card" style={{ opacity: jobOpacity }}>
            <div className="job-head">
              <motion.span className="job-running-label" style={{ opacity: runningOpacity }}>RUNNING · 0:12</motion.span>
              <motion.span className="job-success-label" style={{ opacity: resultOpacity }}>SUCCEEDED · 16s</motion.span>
              <small>CODEX</small>
            </div>
            <div className="job-state-wrap">
              <motion.div className="job-running-state" style={{ opacity: runningOpacity }}>
                <div className="live-log"><span>› inspecting payment flow</span><span>› found duplicate capture path</span><span>› adding bounded recovery guard</span><i /></div>
                <div className="job-progress"><b><motion.i style={{ scaleX: progress }} /></b><small>Focused checks · 2 / 3</small></div>
                <footer><button type="button">Cancel</button><button type="button">View full log</button></footer>
              </motion.div>
              <motion.div className="job-result-state" style={{ opacity: resultOpacity, y: resultY }}>
                <strong>Recovery guard added.</strong>
                <p>The duplicate capture path is bounded. All three focused checks pass.</p>
                <div><span><Check />payment.ts</span><span><Check />checkout.test.ts</span></div>
                <footer><small>3 files changed</small><button type="button">View full log</button></footer>
              </motion.div>
            </div>
          </motion.div>
        </div>

        <div className="phone-composer">
          <div className="model-chips"><span><Cpu />CODEX · GPT-5.6 <b>TASK</b><ChevronDown /></span><span><Gauge />HIGH<ChevronDown /></span></div>
          <div className="message-field"><Mic /><span>Message...</span><motion.b style={{ opacity: runningOpacity }}><CircleStop /></motion.b><motion.b className="send-state" style={{ opacity: resultOpacity }}><ArrowUp /></motion.b></div>
        </div>
        <div className="phone-home" aria-hidden="true" />
        <div className="phone-glass" aria-hidden="true" />
      </div>
    </div>
  );
}

function OpeningFilm() {
  const ref = useRef<HTMLElement>(null);
  const reducedMotion = Boolean(useReducedMotion());
  const [activeChapter, setActiveChapter] = useState(0);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const progress = useSpring(scrollYProgress, { stiffness: 78, damping: 25, mass: 0.26 });

  const sceneScale = useTransform(progress, [0, 1], [1.015, 1.07]);
  const sceneY = useTransform(progress, [0, 1], ['0%', '-2.4%']);
  const introOpacity = useTransform(progress, [0, 0.13, 0.21], [1, 1, 0]);
  const introY = useTransform(progress, [0, 0.21], [0, -28]);
  const macX = useTransform(progress, [0, 0.42, 0.78, 1], ['0vw', '-2vw', '-21vw', '-24vw']);
  const macY = useTransform(progress, [0, 0.52, 1], [0, 13, 38]);
  const macScale = useTransform(progress, [0, 0.46, 0.8, 1], [1, 0.94, 0.68, 0.58]);
  const macOpacity = useTransform(progress, [0, 0.7, 0.94], [1, 0.86, 0.08]);
  const macScreenOpacity = useTransform(progress, [0.25, 0.46], [1, 0.2]);
  const macProgress = useTransform(progress, [0.05, 0.31], [0.18, 1]);
  const phoneOpacity = useTransform(progress, [0.28, 0.4], [0, 1]);
  const phoneX = useTransform(progress, [0.28, 0.6, 0.92], ['15vw', '3vw', '0vw']);
  const phoneY = useTransform(progress, [0.28, 0.6, 0.92], ['18vh', '2vh', '0vh']);
  const phoneScale = useTransform(progress, [0.28, 0.6, 0.92], [0.62, 0.88, 1]);
  const userOpacity = useTransform(progress, [0.4, 0.5], [0, 1]);
  const jobOpacity = useTransform(progress, [0.48, 0.58], [0, 1]);
  const runningOpacity = useTransform(progress, [0.51, 0.67, 0.78, 0.84], [0, 1, 1, 0]);
  const resultOpacity = useTransform(progress, [0.78, 0.87], [0, 1]);
  const resultY = useTransform(progress, [0.78, 0.87], [12, 0]);
  const phoneProgress = useTransform(progress, [0.54, 0.78], [0.08, 1]);
  const transferOpacity = useTransform(progress, [0.28, 0.4, 0.68, 0.76], [0, 1, 1, 0]);
  const transferScale = useTransform(progress, [0.29, 0.58], [0.04, 1]);
  const captionOpacity = useTransform(progress, [0.16, 0.23, 0.96, 1], [0, 1, 1, 0]);
  const washOpacity = useTransform(progress, [0.975, 1], [0, 1]);
  const guideScale = useSpring(scrollYProgress, { stiffness: 110, damping: 28, mass: 0.2 });

  useMotionValueEvent(scrollYProgress, 'change', (latest) => {
    const next = latest < 0.34 ? 0 : latest < 0.72 ? 1 : 2;
    setActiveChapter((current) => current === next ? current : next);
  });

  if (reducedMotion) {
    return (
      <section className="film-static" id="handoff">
        <div className="scene-photo" /><div className="scene-grade" />
        <div className="static-copy"><span>Relay for iPhone</span><h1>Leave the desk.<br /><em>Keep the thread.</em></h1></div>
        <div className="static-mac"><MacWorkspace /></div><div className="static-phone"><RelayPhone resultOpacity={1} runningOpacity={0} /></div>
      </section>
    );
  }

  return (
    <section className="opening-film" ref={ref} id="handoff">
      <div className="film-stage">
        <motion.div className="film-scene" style={{ scale: sceneScale, y: sceneY }}><div className="scene-photo" /><div className="scene-air" /></motion.div>
        <div className="scene-grade" />
        <motion.div className="film-intro" style={{ opacity: introOpacity, y: introY }}>
          <div className="eyebrow"><i />Relay for iPhone</div>
          <h1>Leave the desk.<br /><em>Keep the thread.</em></h1>
          <p>Start an agent inside the real workspace. Relay keeps it moving, then brings the same thread to your iPhone.</p>
          <a href="#product">See the real app <ArrowDown /></a>
        </motion.div>

        <div className="film-devices">
          <motion.div className="film-mac" style={{ x: macX, y: macY, scale: macScale, opacity: macOpacity }}><MacWorkspace screenOpacity={macScreenOpacity} progress={macProgress} /></motion.div>
          <motion.div className="transfer-line" style={{ opacity: transferOpacity, scaleX: transferScale }} aria-hidden="true"><i /></motion.div>
          <motion.div className="film-phone" style={{ x: phoneX, y: phoneY, scale: phoneScale, opacity: phoneOpacity }}>
            <RelayPhone userOpacity={userOpacity} jobOpacity={jobOpacity} runningOpacity={runningOpacity} resultOpacity={resultOpacity} resultY={resultY} progress={phoneProgress} />
          </motion.div>
        </div>

        <motion.div className="film-caption" style={{ opacity: captionOpacity }}>
          <AnimatePresence mode="wait">
            <motion.div key={chapters[activeChapter].time} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.42, ease }}>
              <span>{chapters[activeChapter].time}</span><h2>{chapters[activeChapter].title}</h2><p>{chapters[activeChapter].copy}</p>
            </motion.div>
          </AnimatePresence>
        </motion.div>
        <div className="scroll-note"><span>Scroll to hand off</span><i /></div><div className="film-guide"><motion.span style={{ scaleX: guideScale }} /></div><motion.div className="film-wash" style={{ opacity: washOpacity }} />
      </div>
    </section>
  );
}

function NativeConversation() {
  return (
    <div className="native-conversation">
      <header><SquarePen /><div><strong>checkout</strong><small>~/work/checkout</small></div></header>
      <div className="native-threads"><MessageCircleMore /><strong>Threads</strong><span>1 handed off</span><b>8</b><ChevronRight /></div>
      <main>
        <div className="native-user"><small>YOU</small><p>Audit checkout failures, fix the duplicate capture, and run focused tests.</p></div>
        <div className="native-job">
          <div className="native-job-head"><span>RUNNING · <i>0:12</i></span><small>CODEX</small></div>
          <div className="native-log"><code>› inspecting payment flow</code><code>› found duplicate capture path</code><code>› adding bounded recovery guard</code><b /></div>
          <footer><button type="button">Cancel</button><button type="button">View full log</button></footer>
        </div>
      </main>
      <div className="native-composer"><div><span><Cpu />CODEX · GPT-5.6 <b>TASK</b><ChevronDown /></span><span><Gauge />HIGH<ChevronDown /></span></div><label><Mic /><i>Message...</i><b><CircleStop /></b></label></div>
    </div>
  );
}

function ThreadDrawer() {
  return (
    <div className="thread-drawer">
      <header><span>Threads</span><MoreHorizontal /></header>
      <button className="new-conversation" type="button"><SquarePen />New conversation</button>
      <small className="drawer-label">CONTINUE FROM YOUR COMPUTER</small>
      <div className="handoff-card">
        <header><span>CODEX</span><b>READY</b></header>
        <h3>Checkout recovery</h3>
        <p>checkout · from Komal’s Mac · now</p>
        <code>3 files changed, 42 insertions(+)</code>
        <blockquote>The payment path is isolated and the focused checks are ready to continue.</blockquote>
        <button type="button">Continue this work</button>
      </div>
      <small className="drawer-label this-folder">THIS FOLDER</small>
      <div className="thread-row"><span><strong>Fix duplicate capture path</strong><small>checkout · Codex · 1 invocation</small></span><b>ACTIVE</b></div>
      <div className="thread-row"><span><strong>Audit checkout recovery</strong><small>checkout · Claude Code · conversation</small></span><b>CHAT</b></div>
    </div>
  );
}

function StatusFeed() {
  return (
    <div className="status-feed">
      <header><h3>Status</h3><div><span className="selected">Activity</span><span>Health</span></div><p>2 active · 8 recent</p></header>
      <main>
        <div className="feed-row active"><MessageCircleMore /><span><strong>Checkout recovery</strong><small>checkout · now</small></span><div><b>CODEX</b><em>RUNNING</em></div></div>
        <div className="feed-row"><MessageCircleMore /><span><strong>Improve onboarding copy</strong><small>relay · 8m ago</small></span><div><b>CLAUDE CODE</b><em>SUCCEEDED</em></div></div>
        <div className="feed-row"><MessageCircleMore /><span><strong>Review auth boundary</strong><small>relay-server · 22m ago</small></span><div><b>CODEX</b><em>THREAD</em></div></div>
        <div className="feed-row"><MessageCircleMore /><span><strong>Polish mobile composer</strong><small>ios · 1h ago</small></span><div><b>CURSOR</b><em>SUCCEEDED</em></div></div>
      </main>
    </div>
  );
}

function App() {
  const [installCopied, setInstallCopied] = useState(false);
  const copyInstallCommand = async () => {
    try { await navigator.clipboard.writeText(installCommand); }
    catch {
      const textArea = document.createElement('textarea'); textArea.value = installCommand; textArea.style.position = 'fixed'; textArea.style.opacity = '0'; document.body.appendChild(textArea); textArea.select(); document.execCommand('copy'); textArea.remove();
    }
    setInstallCopied(true); window.setTimeout(() => setInstallCopied(false), 1800);
  };

  return (
    <div className="site" id="top">
      <header className="topbar"><a href="#top" className="wordmark" aria-label="Relay home">Relay</a><nav><a href="#handoff">Handoff</a><a href="#product">The app</a><a href="#privacy">Privacy</a></nav><a className="nav-cta" href="#start">Private beta <ArrowUpRight /></a></header>
      <main>
        <OpeningFilm />

        <section className="product-section" id="product">
          <div className="product-copy"><Reveal className="section-kicker">Relay on iPhone</Reveal><Reveal delay={0.05}><h2>The real app.<br /><em>In your hand.</em></h2></Reveal><Reveal delay={0.1}><p>The same Threads, live job state, model controls, and composer—shaped for the phone.</p></Reveal></div>
          <Reveal className="conversation-wrap" delay={0.08}><NativeConversation /></Reveal>
        </section>

        <section className="handoff-section">
          <div className="handoff-copy"><Reveal className="section-kicker">Continue from your computer</Reveal><Reveal delay={0.05}><h2>Pick up the exact work.</h2></Reveal><Reveal delay={0.1}><p>The Mac session appears where Relay already puts it: at the top of Threads, ready to continue.</p></Reveal></div>
          <Reveal className="drawer-wrap" delay={0.08}><ThreadDrawer /></Reveal>
          <div className="handoff-connection" aria-hidden="true"><span>MAC SESSION</span><i><b /></i><span>IPHONE THREAD</span></div>
        </section>

        <section className="signal-section">
          <div className="signal-heading"><Reveal><div className="section-kicker">Signal, not supervision</div><h2>Know what is moving.<br /><em>Return when it matters.</em></h2></Reveal><Reveal delay={0.08}><p>Live work is ember. Finished work returns to cream. Relay stays quiet everywhere else.</p></Reveal></div>
          <Reveal className="status-wrap" delay={0.08}><StatusFeed /></Reveal>
        </section>

        <section className="privacy-section" id="privacy">
          <Reveal className="privacy-copy"><div className="section-kicker">The real boundary</div><h2>The phone controls.<br /><em>Your machine executes.</em></h2><p>Relay sends intent and streams results. Files, tools, and provider sessions remain on the registered machine.</p><span><ShieldCheck />Certificate-authenticated access</span></Reveal>
          <Reveal className="privacy-map" delay={0.08}>
            <div><small>CONTROL</small><strong>Relay on iPhone</strong><span>Prompt · follow · answer · review</span></div><i><b>AUTHENTICATED</b></i><div className="runner"><small>EXECUTION</small><strong>Private runner</strong><span>Codex · Claude Code · Cursor</span></div><i><b>REGISTERED</b></i><div><small>CONTEXT</small><strong>Your workspace</strong><span>Files and tools stay in place</span></div>
          </Reveal>
        </section>

        <section className="start-section" id="start">
          <div className="start-glow" />
          <Reveal className="start-copy"><div className="section-kicker">Relay · private beta</div><h2>Leave the desk.<br /><em>Keep the thread.</em></h2></Reveal>
          <Reveal className="install-card" delay={0.08}><div className="install-heading"><span>Install Relay CLI</span><small>macOS</small></div><div className="install-command"><code><i>$</i>{installCommand}</code><button type="button" onClick={copyInstallCommand}>{installCopied ? <Check /> : <Copy />}<span>{installCopied ? 'Copied' : 'Copy'}</span></button></div><footer><span>Private runner</span><span>iPhone control surface</span></footer></Reveal>
        </section>
      </main>
      <footer className="site-footer"><a href="#top" className="wordmark">Relay</a><p>Private iPhone control for remote agent work.</p><div><span>Codex</span><span>Claude Code</span><span>Cursor</span></div><small>Private beta</small></footer>
    </div>
  );
}

export default App;
