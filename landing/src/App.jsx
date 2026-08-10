import React, { useEffect, useRef, useState } from 'react';
import {
  MotionConfig, motion, AnimatePresence, useScroll, useTransform, useMotionValueEvent,
} from 'framer-motion';
import Lenis from 'lenis';

const BASE = import.meta.env.BASE_URL;
const APP_URL = '/app';
const MARK = `${BASE}mark.svg`;

/* Shared motion variants */
const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: 'easeOut' } },
};
const stagger = { show: { transition: { staggerChildren: 0.08 } } };

function Reveal({ children, className }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-80px' }}
      variants={stagger}
    >
      {children}
    </motion.div>
  );
}

function TopBar() {
  return (
    <div className="topbar">
      <div className="wrap topbar-inner">
        <a className="wordmark" href="/">
          <img src={MARK} alt="" />
          <span>Party Plus One</span>
        </a>
        <a className="mono toplink" href={APP_URL}><span className="arw">↳</span> Host a party</a>
      </div>
    </div>
  );
}

/* Floating dock, fluid.glass-style — slides in once the hero is behind you. */
function Dock() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const on = () => setVisible(window.scrollY > window.innerHeight * 0.9);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <AnimatePresence>
      {visible && (
        <motion.nav className="dock"
          initial={{ y: 80, x: '-50%', opacity: 0 }}
          animate={{ y: 0, x: '-50%', opacity: 1 }}
          exit={{ y: 80, x: '-50%', opacity: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}>
          <img src={MARK} alt="" />
          <a className="mono dock-link" href="#how">How</a>
          <a className="mono dock-link" href="#inside">Inside</a>
          <a className="cta" href={APP_URL}><span className="arw">↳</span> Host a party</a>
        </motion.nav>
      )}
    </AnimatePresence>
  );
}

function Hero() {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const videoScale = useTransform(scrollYProgress, [0, 1], [1, 1.1]);
  const textY = useTransform(scrollYProgress, [0, 1], [0, -70]);
  const textOpacity = useTransform(scrollYProgress, [0, 0.55], [1, 0]);
  return (
    <header className="hero" ref={ref}>
      <div className="hero-fallback" />
      <motion.video
        style={{ scale: videoScale }}
        autoPlay muted loop playsInline
        poster={`${BASE}hero-poster.jpg`}
        src={`${BASE}hero.mp4`}
      />
      <div className="hero-shade" />
      <motion.div className="hero-content" style={{ y: textY, opacity: textOpacity }}
        initial="hidden" animate="show" variants={stagger}>
        <motion.span className="mono eyebrow" variants={fadeUp}>◆ Invites people actually answer</motion.span>
        <motion.h1 variants={fadeUp}>Throw the party.<br />We'll text the invites.</motion.h1>
        <motion.p className="sub" variants={fadeUp}>
          Create an event in a minute. Every guest gets a personal link by text
          or email and RSVPs in one tap. No app, no account, no ads.
        </motion.p>
        <motion.div className="hero-ctas" variants={fadeUp}>
          <a className="cta" href={APP_URL}><span className="arw">↳</span> Host a party</a>
          <a className="cta ghost" href="#how"><span className="arw">↓</span> How it works</a>
        </motion.div>
      </motion.div>
      <motion.div className="mono scroll-cue" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ delay: 1.4, duration: 0.8 }}>Scroll</motion.div>
    </header>
  );
}

/* The signature move: a pinned film whose playhead follows your scroll. */
const SCRUB_STEPS = [
  { range: [0.02, 0.3], step: '◆ 01 — Create', title: 'Set the scene in a minute.', body: 'Name it, pick a cover — or upload your own photo. Cost, dress code, playlist, all optional.' },
  { range: [0.36, 0.62], step: '◆ 02 — Invite', title: 'Every guest gets a personal text.', body: 'Paste names and numbers. Each person gets their own link — no group chat chaos.' },
  { range: [0.68, 0.95], step: '◆ 03 — Host', title: 'Watch the yeses roll in.', body: 'One tap to RSVP. Waitlists, date polls, and the day-before reminder run themselves.' },
];

function ScrubCaption({ progress, range, step, title, body }) {
  const [a, b] = range;
  const inPad = Math.min(0.06, (b - a) / 3);
  const opacity = useTransform(progress, [a, a + inPad, b - inPad, b], [0, 1, 1, 0]);
  const y = useTransform(progress, [a, a + inPad], [24, 0]);
  return (
    <motion.div className="scrub-caption" style={{ opacity, y }}>
      <span className="mono step">{step}</span>
      <h2>{title}</h2>
      <p>{body}</p>
    </motion.div>
  );
}

function Scrub() {
  const wrap = useRef(null);
  const video = useRef(null);
  const { scrollYProgress } = useScroll({ target: wrap, offset: ['start start', 'end end'] });
  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const v = video.current;
    if (v && v.duration && !isNaN(v.duration)) {
      v.currentTime = Math.min(v.duration - 0.05, Math.max(0, p * v.duration));
    }
  });
  return (
    <section className="scrub" id="how" ref={wrap}>
      <div className="scrub-sticky">
        <video ref={video} muted playsInline preload="auto"
          poster={`${BASE}aerial-poster.jpg`} src={`${BASE}aerial.mp4`} />
        <div className="scrub-shade" />
        {SCRUB_STEPS.map((s) => (
          <ScrubCaption key={s.step} progress={scrollYProgress} {...s} />
        ))}
      </div>
    </section>
  );
}

/* The index — what's inside, as an editorial list. No cards, no icons. */
const INDEX = [
  { n: '01', title: 'Text + email invites', body: 'Guests get a personal RSVP link by SMS or email — whichever you have for them. Reply STOP always honored.' },
  { n: '02', title: 'One-tap RSVP', body: "I'm in, maybe, or can't make it. No download, no signup, no password — the link is the identity." },
  { n: '03', title: 'Date polls', body: "Can't pick a night? Offer up to eight options, let guests vote, then lock the winner in one tap." },
  { n: '04', title: 'Covers, fonts & 1,900 emoji', body: 'Sixteen designed covers, AI-generated art, photo uploads, four title typefaces, the full emoji library.' },
  { n: '05', title: 'Capacity & waitlists', body: 'Cap the guest list and extra yeses queue up automatically. Admit someone and they get the good-news text.' },
  { n: '06', title: 'Reminders that send themselves', body: 'A day-before nudge goes out automatically, and you can blast updates to everyone but the decliners.' },
];

function Index() {
  return (
    <section className="section wrap" id="inside">
      <Reveal>
        <motion.span className="mono section-label" variants={fadeUp}>◆ What's inside</motion.span>
        <motion.h2 className="section-title" variants={fadeUp}>
          Built for real parties — birthdays, bar crawls, housewarmings.
        </motion.h2>
      </Reveal>
      <Reveal className="index">
        {INDEX.map((f) => (
          <motion.div className="index-row" key={f.n} variants={fadeUp}>
            <span className="num">{f.n}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </motion.div>
        ))}
      </Reveal>
    </section>
  );
}

/* The one light passage — the promise, on paper. */
function Paper() {
  return (
    <section className="paper-band">
      <Reveal className="wrap">
        <motion.span className="mono section-label" variants={fadeUp}>◆ The deal</motion.span>
        <motion.h2 variants={fadeUp}>
          Your guest list is a guest list. Not a product.
        </motion.h2>
        <motion.div className="paper-rows" variants={fadeUp}>
          <div className="row"><span className="mono">No accounts</span><p>Guests never sign up for anything. The link in their text is the whole system.</p></div>
          <div className="row"><span className="mono">No ads</span><p>Nothing is promoted, sponsored, or "suggested" — to you or your guests.</p></div>
          <div className="row"><span className="mono">No harvesting</span><p>Contact info is used to send the invites you asked for. That's the entire list of uses.</p></div>
        </motion.div>
      </Reveal>
    </section>
  );
}

function Finale() {
  return (
    <section className="finale">
      <Reveal>
        <motion.h2 variants={fadeUp}>Your next party starts<br />with one text.</motion.h2>
        <motion.p variants={fadeUp}>Free to host. One tap to RSVP. Confetti not included (yet).</motion.p>
        <motion.div variants={fadeUp}>
          <a className="cta" href={APP_URL}><span className="arw">↳</span> Host a party</a>
        </motion.div>
      </Reveal>
    </section>
  );
}

export default function App() {
  useEffect(() => {
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true });
    let raf;
    const loop = (t) => { lenis.raf(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); lenis.destroy(); };
  }, []);
  return (
    <MotionConfig reducedMotion="user">
      <TopBar />
      <Hero />
      <Scrub />
      <Index />
      <Paper />
      <Finale />
      <footer className="footer">
        <span>© {new Date().getFullYear()} Party Plus One</span>
        <span><a href="https://christopherrathbun.com" target="_blank" rel="noopener noreferrer">Built by Christopher Rathbun</a></span>
      </footer>
      <Dock />
    </MotionConfig>
  );
}
