import { motion } from "framer-motion";
import { games, type Game } from "../data";

function LibraryCard({ game, onOpen }: { game: Game; onOpen: (id: string) => void }) {
  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      transition={{ type: "spring", stiffness: 350, damping: 25 }}
      className="group flex items-center gap-4 rounded-2xl border border-(--color-border) bg-(--color-surface) p-3"
    >
      <div
        className="h-16 w-24 shrink-0 overflow-hidden rounded-xl"
        style={{ background: game.gradient }}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-(--color-text)">{game.title}</div>
        <div className="text-sm text-(--color-muted)">{game.subtitle}</div>
      </div>
      <button
        onClick={() => onOpen(game.id)}
        className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
          <path d="M8 5v14l11-7z" />
        </svg>
        Play
      </button>
    </motion.div>
  );
}

export function LibraryView({ onOpenGame }: { onOpenGame: (id: string) => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-4"
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
        <p className="text-sm text-(--color-muted)">All your streamed games in one place.</p>
      </div>

      <div className="space-y-3">
        {games.map((g) => (
          <LibraryCard key={g.id} game={g} onOpen={onOpenGame} />
        ))}

        <div className="flex items-center justify-center rounded-2xl border border-dashed border-(--color-border) p-8 text-sm text-(--color-muted)">
          Moonlight discovery coming in a later step — this is placeholder data.
        </div>
      </div>
    </motion.div>
  );
}
