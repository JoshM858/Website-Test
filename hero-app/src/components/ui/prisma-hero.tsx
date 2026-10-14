import { motion, useInView } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { useRef, type CSSProperties } from "react";

/* ---------------- WordsPullUp ---------------- */
interface WordsPullUpProps {
  text: string;
  className?: string;
  showAsterisk?: boolean;
  style?: CSSProperties;
}

export const WordsPullUp = ({ text, className = "", showAsterisk = false, style }: WordsPullUpProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true });
  const words = text.split(" ");

  return (
    <div ref={ref} className={`inline-flex flex-wrap ${className}`} style={style}>
      {words.map((word, i) => {
        const isLast = i === words.length - 1;
        return (
          <motion.span
            key={i}
            initial={{ y: 20, opacity: 0 }}
            animate={isInView ? { y: 0, opacity: 1 } : {}}
            transition={{ duration: 0.6, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="inline-block relative"
            style={{ marginRight: isLast ? 0 : "0.25em" }}
          >
            {word}
            {showAsterisk && isLast && (
              <span className="absolute top-[0.65em] -right-[0.3em] text-[0.31em]">*</span>
            )}
          </motion.span>
        );
      })}
    </div>
  );
};

/* ---------------- WordsPullUpMultiStyle ---------------- */
interface Segment {
  text: string;
  className?: string;
}

interface WordsPullUpMultiStyleProps {
  segments: Segment[];
  className?: string;
  style?: CSSProperties;
}

export const WordsPullUpMultiStyle = ({ segments, className = "", style }: WordsPullUpMultiStyleProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true });

  const words: { word: string; className?: string }[] = [];
  segments.forEach((seg) => {
    seg.text.split(" ").forEach((w) => {
      if (w) words.push({ word: w, className: seg.className });
    });
  });

  return (
    <div ref={ref} className={`inline-flex flex-wrap justify-center ${className}`} style={style}>
      {words.map((w, i) => (
        <motion.span
          key={i}
          initial={{ y: 20, opacity: 0 }}
          animate={isInView ? { y: 0, opacity: 1 } : {}}
          transition={{ duration: 0.6, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
          className={`inline-block ${w.className ?? ""}`}
          style={{ marginRight: "0.25em" }}
        >
          {w.word}
        </motion.span>
      ))}
    </div>
  );
};

/* ---------------- Hero ---------------- */
// Links point at the main Recall landing page one level up.
const navItems = [
  { label: "Features", href: "../index.html#features" },
  { label: "How it works", href: "../index.html#how" },
  { label: "Live demo", href: "../index.html#network" },
  { label: "Privacy", href: "../privacy.html" },
  { label: "Get an invite", href: "../index.html#access" },
];

const PrismaHero = () => {
  return (
    <section className="h-screen w-full">
      <div className="relative h-full w-full overflow-hidden rounded-2xl md:rounded-[2rem]">

        {/* Background video */}
        <video
          autoPlay
          loop
          muted
          playsInline
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
          src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260405_170732_8a9ccda6-5cff-4628-b164-059c500a2b41.mp4"
        />

        {/* Noise overlay */}
        <div className="noise-overlay pointer-events-none absolute inset-0 opacity-[0.7] mix-blend-overlay" />

        {/* Gradient overlay */}
        <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-black/30 via-transparent to-black/60" />

        {/* Navbar */}
        <nav aria-label="Primary" className="absolute left-1/2 top-0 z-20 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-b-2xl bg-background px-4 py-2 sm:gap-6 md:gap-12 md:rounded-b-3xl md:px-8 lg:gap-14">
            {navItems.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="whitespace-nowrap text-[10px] text-primary/80 transition-colors hover:text-primary sm:text-xs md:text-sm"
              >
                {item.label}
              </a>
            ))}
          </div>
        </nav>

        {/* Hero content */}
        <div className="absolute bottom-0 left-0 right-0 px-4 pb-2 sm:px-6 md:px-10">
          <div className="grid grid-cols-12 items-end gap-4">

            <div className="col-span-12 lg:col-span-8">
              <h1 className="font-medium leading-[0.85] tracking-[-0.07em] text-primary text-[26vw] sm:text-[24vw] md:text-[22vw] lg:text-[20vw] xl:text-[19vw] 2xl:text-[20vw]">
                <WordsPullUp text="Recall" showAsterisk />
              </h1>
            </div>

            <div className="col-span-12 flex flex-col gap-5 pb-6 lg:col-span-4 lg:pb-10">

              <motion.p
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.8, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="text-xs leading-[1.2] text-primary/70 sm:text-sm md:text-base"
              >
                Recall turns your course cohort into quiz squads. Pull questions from your own notes, run live rounds with your study group, and see what&rsquo;s actually sticking before the exam does. Invite-only, by design.
              </motion.p>

              <motion.a
                href="../index.html#access"
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.8, delay: 0.7, ease: [0.16, 1, 0.3, 1] }}
                className="group inline-flex items-center gap-2 self-start rounded-full bg-primary py-1 pl-5 pr-1 text-sm font-medium text-primary-foreground transition-all hover:gap-3 sm:text-base"
              >
                Get an invite
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent transition-transform group-hover:scale-110 sm:h-10 sm:w-10">
                  <ArrowRight className="h-4 w-4 text-accent-foreground" />
                </span>
              </motion.a>

            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export { PrismaHero };
