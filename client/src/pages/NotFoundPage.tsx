import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="app-shell">
      <section className="status-panel">
        <p className="eyebrow">404</p>
        <h1>Page not found</h1>
        <p>The requested page does not exist.</p>
        <Link to="/">Return home</Link>
      </section>
    </main>
  );
}
