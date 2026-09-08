import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { apps } from "../data";

function AppTile({
  name,
  category,
  gradient,
  index,
}: {
  name: string;
  category: string;
  gradient: string;
  index: number;
}) {
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18, delay: index * 0.02 }}
      whileHover={{ y: -3 }}
      className="group flex flex-col gap-3 rounded-2xl p-3 text-left transition-colors hover:bg-(--color-surface)"
    >
      <div
        className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-2xl text-3xl font-semibold text-white/80"
        style={{ background: gradient }}
      >
        <span>{name.charAt(0)}</span>
        <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/15" />
      </div>
      <div className="px-0.5">
        <div className="truncate text-sm font-medium text-(--color-text)">{name}</div>
        <div className="truncate text-xs text-(--color-muted)">{category}</div>
      </div>
    </motion.button>
  );
}

export function AppsView() {
  const [query, setQuery] = useState("");
  const filtered = apps.filter((a) =>
    (a.name + a.category).toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="mx-auto max-w-6xl space-y-8"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
          <p className="text-sm text-(--color-muted)">
            Launch Windows apps. Curate and customize your own collection.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <MagnifyingGlass size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-(--color-muted)" />
            <input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search apps…"
              className="h-9 w-56 rounded-full border border-(--color-border) bg-(--color-surface) pl-9 pr-4 text-sm text-(--color-text) outline-none transition placeholder:text-(--color-muted) focus:border-(--color-accent)"
            />
          </div>
          <button className="flex h-9 items-center gap-1.5 rounded-full bg-(--color-accent) px-4 text-sm font-medium text-white transition hover:brightness-110">
            <Plus size={16} weight="bold" />
            Add
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        <AnimatePresence>
          {filtered.map((a, i) => (
            <AppTile key={a.id} name={a.name} category={a.category} gradient={a.gradient} index={i} />
          ))}
        </AnimatePresence>
        {filtered.length === 0 && (
          <div className="col-span-full py-12 text-center text-sm text-(--color-muted)">
            No apps match “{query}”.
          </div>
        )}
      </div>
    </motion.div>
  );
}
