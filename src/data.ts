export interface Game {
  id: string;
  title: string;
  subtitle: string;
  /** CSS gradient stops used as placeholder cover art */
  gradient: string;
  accent: string;
}

export const games: Game[] = [
  {
    id: "cyber",
    title: "Cyber Runner",
    subtitle: "Action",
    gradient: "linear-gradient(135deg,#7c6cff,#23d8c6)",
    accent: "#7c6cff",
  },
  {
    id: "drift",
    title: "Neon Drift",
    subtitle: "Racing",
    gradient: "linear-gradient(135deg,#ff6b6b,#ffa05c)",
    accent: "#ff6b6b",
  },
  {
    id: "vault",
    title: "Crystal Vault",
    subtitle: "Adventure",
    gradient: "linear-gradient(135deg,#23d8c6,#2f6bff)",
    accent: "#23d8c6",
  },
  {
    id: "orbit",
    title: "Orbit Zero",
    subtitle: "Space Sim",
    gradient: "linear-gradient(135deg,#a78bfa,#f472b6)",
    accent: "#a78bfa",
  },
  {
    id: "forge",
    title: "Ember Forge",
    subtitle: "RPG",
    gradient: "linear-gradient(135deg,#f59e0b,#ef4444)",
    accent: "#f59e0b",
  },
  {
    id: "ghost",
    title: "Ghost Protocol",
    subtitle: "Stealth",
    gradient: "linear-gradient(135deg,#64748b,#0f172a)",
    accent: "#64748b",
  },
];

/** "Recently played" for the home view */
export const recentIds = ["cyber", "drift", "orbit"];
