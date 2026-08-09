import React, { useEffect, useRef, useState } from 'react';
import {
  MotionConfig, motion, useScroll, useTransform, useMotionValueEvent,
} from 'framer-motion';
import Lenis from 'lenis';

const BASE = import.meta.env.BASE_URL;
const APP_URL = '/app';

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

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <nav className={`nav${scrolled ? ' scrolled' : ''}`}>
      <div className="wrap nav-inner">
        <a className="nav-logo" href="/">🎈 Party&nbsp;Plus&nbsp;One</a>
        <div className="nav-links">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a className="btn sm" href={APP_URL}>Host a party</a>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const videoScale = useTransform(scrollYProgress, [0, 1], [1, 1.12]);
  const textY = useTransform(scrollYProgress, [0, 1], [0, -80]);
  const textOpacity = useTransform(scrollYProgress, [0, 0.6], [1, 0]);
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
        <motion.span className="eyebrow" variants={fadeUp}>Invites people actually answer</motion.span>
        <motion.h1 variants={fadeUp}>Throw the party.<br />We'll text the invites.</motion.h1>
        <motion.p className="sub" variants={fadeUp}>
          Create an event in a minute. Every guest gets a personal link by text or
          email and RSVPs in one tap — no app, no account, no ads.
        </motion.p>
        <motion.div className="hero-ctas" variants={fadeUp}>
          <a className="btn" href={APP_URL}>Host a party — it's free</a>
          <a className="btn ghost" href="#how">See how it works</a>
        </motion.div>
      </motion.div>
      <motion.div className="scroll-cue" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ delay: 1.4, duration: 0.8 }}>SCROLL</motion.div>
    </header>
  );
}

/* The signature move: a pinned video whose playhead follows your scroll. */
const SCRUB_STEPS = [
  { range: [0.02, 0.3], step: 'Step one', title: 'Set the scene in a minute', body: 'Name it, pick a vibe and a cover — or upload your own photo. Cost, dress code, playlist, all optional.' },
  { range: [0.36, 0.62], step: 'Step two', title: 'Every guest gets a personal text', body: 'Paste names and numbers. We send each person their own link — no group chat chaos.' },
  { range: [0.68, 0.95], step: 'Step three', title: 'Watch the yeses roll in', body: "One tap to RSVP. Waitlists, date polls, and a day-before reminder run themselves." },
];

function ScrubCaption({ progress, range, step, title, body }) {
  const [a, b] = range;
  const inPad = Math.min(0.06, (b - a) / 3);
  const opacity = useTransform(progress, [a, a + inPad, b - inPad, b], [0, 1, 1, 0]);
  const y = useTransform(progress, [a, a + inPad], [24, 0]);
  return (
    <motion.div className="scrub-caption" style={{ opacity, y }}>
      <span className="step">{step}</span>
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

const FEATURES = [
  { icon: '💬', title: 'Text + email invites', body: 'Guests get a personal RSVP link by SMS or email — whichever you have for them. Reply STOP always honored.' },
  { icon: '⚡', title: 'One-tap RSVP', body: "I'm in / Maybe / Can't make it. No download, no signup, no password — the link is the identity." },
  { icon: '📊', title: 'Date polls', body: "Can't pick a night? Offer up to eight options, let guests vote, then lock the winner in one tap." },
  { icon: '🎨', title: 'Covers, fonts & 1,900 emoji', body: 'Sixteen designed covers, AI-generated art, photo uploads, four title typefaces, and the full emoji library.' },
  { icon: '🎟️', title: 'Capacity & waitlists', body: 'Cap the guest list and extra yeses queue up automatically. Admit someone and they get the good-news text.' },
  { icon: '⏰', title: 'Reminders that send themselves', body: 'A day-before nudge goes out automatically, and you can blast updates to everyone but the decliners.' },
];

function Features() {
  return (
    <section className="section wrap" id="features">
      <Reveal className="section-head">
        <motion.span className="eyebrow" variants={fadeUp}>Everything a host needs</motion.span>
        <motion.h2 variants={fadeUp}>Partiful-level features, zero platform tax</motion.h2>
        <motion.p variants={fadeUp}>
          Built for real parties — birthdays, bar crawls, housewarmings — not for
          harvesting your guest list.
        </motion.p>
      </Reveal>
      <Reveal className="grid">
        {FEATURES.map((f) => (
          <motion.div className="card" key={f.title} variants={fadeUp}>
            <div className="icon" aria-hidden>{f.icon}</div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </motion.div>
        ))}
      </Reveal>
    </section>
  );
}

function Promise() {
  return (
    <div className="promise">
      <Reveal className="promise-inner">
        {['No accounts for guests', 'No ads, ever', 'No data harvesting'].map((t) => (
          <motion.div className="promise-item" key={t} variants={fadeUp}>
            <span>✦</span> {t}
          </motion.div>
        ))}
      </Reveal>
    </div>
  );
}

function Finale() {
  return (
    <section className="finale">
      <div className="finale-glow" />
      <Reveal>
        <motion.h2 variants={fadeUp}>Your next party starts<br />with one text.</motion.h2>
        <motion.p variants={fadeUp}>Free to host. One tap to RSVP. Confetti not included (yet).</motion.p>
        <motion.div variants={fadeUp}>
          <a className="btn" href={APP_URL}>Host a party</a>
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
      <Nav />
      <Hero />
      <Scrub />
      <Features />
      <Promise />
      <Finale />
      <footer className="footer">
        <span>© {new Date().getFullYear()} Party Plus One</span>
        <span>Built by <a href="https://christopherrathbun.com" target="_blank" rel="noopener noreferrer">Christopher Rathbun</a></span>
      </footer>
    </MotionConfig>
  );
}
