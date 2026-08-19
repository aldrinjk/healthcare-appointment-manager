import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

type AppLayoutProps = {
  children: ReactNode;
};

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <div className="app-shell">
      <header className="site-header">
        <div>
          <p className="eyebrow">Healthcare Appointment Manager</p>
          <h1>Foundation</h1>
        </div>
        <nav aria-label="Primary navigation">
          <NavLink to="/">Home</NavLink>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
