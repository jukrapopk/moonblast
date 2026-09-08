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
    gradient: "linear-gradient(135deg,#4a5278,#3a5f6b)",
    accent: "#4a5278",
  },
  {
    id: "drift",
    title: "Neon Drift",
    subtitle: "Racing",
    gradient: "linear-gradient(135deg,#6e4a4a,#6b5440)",
    accent: "#6e4a4a",
  },
  {
    id: "vault",
    title: "Crystal Vault",
    subtitle: "Adventure",
    gradient: "linear-gradient(135deg,#3a5f6b,#3a4f78)",
    accent: "#3a5f6b",
  },
  {
    id: "orbit",
    title: "Orbit Zero",
    subtitle: "Space Sim",
    gradient: "linear-gradient(135deg,#554a78,#5d4a68)",
    accent: "#554a78",
  },
  {
    id: "forge",
    title: "Ember Forge",
    subtitle: "RPG",
    gradient: "linear-gradient(135deg,#6b5440,#6e4a4a)",
    accent: "#6b5440",
  },
  {
    id: "ghost",
    title: "Ghost Protocol",
    subtitle: "Stealth",
    gradient: "linear-gradient(135deg,#414a5e,#2b3342)",
    accent: "#414a5e",
  },
];

/** "Recently played" for the home view */
export const recentIds = ["cyber", "drift", "orbit"];
