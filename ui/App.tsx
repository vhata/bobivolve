// Bobivolve dashboard shell. Player-facing UI. Reads from a SimTransport
// (currently nothing wired); rendering here is intentionally minimal until
// the Worker host lands and the transport delivers SimEvents.

export function App(): React.JSX.Element {
  return (
    <div className="bobivolve-app">
      <header className="bobivolve-header">
        <h1>Bobivolve</h1>
        <p className="bobivolve-tagline">Pre-Release 0 — sim core landed; dashboard wiring next.</p>
      </header>
      <main>
        <p>Once the Worker host arrives, this is where the swarm shows itself.</p>
      </main>
    </div>
  );
}
