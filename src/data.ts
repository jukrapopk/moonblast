export interface App {
  id: string;
  name: string;
  category: string;
  /** Muted gradient used as the app tile placeholder */
  gradient: string;
}

export const apps: App[] = [
  { id: "chrome", name: "Chrome", category: "Browser", gradient: "linear-gradient(135deg,#3a3f57,#394b45)" },
  { id: "vscode", name: "VS Code", category: "Dev tools", gradient: "linear-gradient(135deg,#31416b,#2b3a5e)" },
  { id: "steam", name: "Steam", category: "Gaming", gradient: "linear-gradient(135deg,#3a3f66,#323c44)" },
  { id: "yt", name: "YouTube", category: "Media", gradient: "linear-gradient(135deg,#563b45,#4a3a3a)" },
  { id: "spotify", name: "Spotify", category: "Music", gradient: "linear-gradient(135deg,#333c4a,#2f4a42)" },
  { id: "discord", name: "Discord", category: "Social", gradient: "linear-gradient(135deg,#454a75,#3b3f63)" },
  { id: "obs", name: "OBS Studio", category: "Streaming", gradient: "linear-gradient(135deg,#3b3b52,#333c4a)" },
  { id: "photos", name: "Photos", category: "Media", gradient: "linear-gradient(135deg,#4a4460,#3f3a52)" },
];

export interface Machine {
  id: string;
  name: string;
  address: string;
  paired: boolean;
  online: boolean;
}

/** Sample machines — real host discovery comes in Step 2 */
export const machines: Machine[] = [
  { id: "rig", name: "Living Room Rig", address: "192.168.1.20", paired: true, online: true },
  { id: "battlestation", name: "Battlestation", address: "192.168.1.14", paired: true, online: false },
  { id: "laptop", name: "Media Laptop", address: "192.168.1.31", paired: false, online: true },
];
