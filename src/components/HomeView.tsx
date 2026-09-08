import { motion } from "framer-motion";
import { games, recentIds, type Game } from "../data";

function GameCard({ game }: { game: Game }) {
  return (
    <motion.button
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className="group flex flex-col gap-2.5 rounded-2xl text-left focus:outline-none"
    >
      <div
        className="relative aspect-[3/4] w-full overflow-hidden rounded-2xl"
        style={{ background: game.gradient }}
      >
        <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20" />
        <span className="absolute bottom-3 left-3 text-xs font-semibold uppercase tracking-wider text-white/80">
          {game.subtitle}
        </span>
      </div>
      <div className="px-0.5 text-sm font-medium text-(--color-text)">{game.title}</div>
    </motion.button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-4 text-lg font-semibold tracking-tight text-(--color-text)">{children}</h2>
  );
}

export function HomeView({ onOpenGame }: { onOpenGame: (id: string) => void }) {
  const recent = recentIds
    .map((id) => games.find((g) => g.id === id))
    .filter((g): g is Game => Boolean(g));

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-10"
    >
      {/* Hero banner */}
      <div
        className="relative overflow-hidden rounded-3xl border border-(--color-border) p-8"
        style={{
          background:
            "linear-gradient(120deg, rgba(111,120,200,0.13), rgba(74,164,155,0.05) 55%, transparent)",
        }}
      >
        <div className="relative z-10 max-w-md">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-(--color-accent-2)">
            Good evening
          </p>          <h1 className="text-3xl font-semibold tracking-tight">Ready when you are</h1>
          <p className="mt-2 text-sm leading-relaxed text-(--color-muted)">
            Pick a game and stream it from your host. This shell is the lightweight gateway to your
            Moonlight sessions.
          </p>
          <button
            onClick={() => onOpenGame("cyber")}
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-(--color-accent) px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-(--color-accent)/15 transition hover:brightness-110"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M8 5v14l11-7z" />
            </svg>
            Continue: Cyber Runner
          </button>
        </div>
      </div>

      <section>
        <SectionTitle>Continue playing</SectionTitle>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {recent.map((g) => (
            <button key={g.id} onClick={() => onOpenGame(g.id)} className="text-left">
              <GameCard game={g} />
            </button>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Featured</SectionTitle>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {games.slice(0, 5).map((g) => (
            <button key={g.id} onClick={() => onOpenGame(g.id)} className="text-left">
              <GameCard game={g} />
            </button>
          ))}
        </div>
      </section>
    </motion.div>
  );
}
