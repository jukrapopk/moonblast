import { PageShell } from "./PageShell";
import { Section } from "./ui/Section";
import { Row } from "./ui/Row";
import { Toggle } from "./ui/Toggle";

export function SettingsView() {
  return (
    <PageShell title="Settings" subtitle="App-level settings.">
      <Section title="General">
        <Row label="Start with Windows" description="Launch Moonblast when you sign in to Windows.">
          <Toggle defaultOn={false} />
        </Row>
      </Section>

      <Section title="Fullscreen Mode">
        <Row
          label="Suppress Explorer & background processes"
          description="Similar to Fullscreen Xbox Mode. Planned for v2."
        >
          <Toggle disabled />
        </Row>
        <Row label="Hide taskbar & auto-fullscreen" description="Enter a clean fullscreen shell on launch.">
          <Toggle disabled />
        </Row>
      </Section>

      <Section title="About">
        <div className="py-4 text-base text-(--color-muted)">
          Moonblast is a lightweight Fullscreen Mode alternative built on Tauri + Rust.
          Moonlight streaming settings live on the Moonlight page.
        </div>
      </Section>
    </PageShell>
  );
}
