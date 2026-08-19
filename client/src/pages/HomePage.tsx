import { useEffect, useState } from "react";

import { apiGet } from "../api/client";

type HealthResponse = {
  status: "ok";
};

export function HomePage() {
  const [healthStatus, setHealthStatus] = useState<string>("Checking API...");

  useEffect(() => {
    const controller = new AbortController();

    apiGet<HealthResponse>("/health", { signal: controller.signal })
      .then((response) => {
        setHealthStatus(`API status: ${response.status}`);
      })
      .catch(() => {
        setHealthStatus("API status unavailable");
      });

    return () => {
      controller.abort();
    };
  }, []);

  return (
    <section className="status-panel" aria-labelledby="foundation-heading">
      <p className="eyebrow">Milestone 1</p>
      <h2 id="foundation-heading">Clean runnable foundation</h2>
      <p>
        The client, API server, environment configuration, Prisma PostgreSQL
        setup, centralized JSON errors, and health endpoint are ready for the
        domain work in the next milestone.
      </p>
      <p className="status-value">{healthStatus}</p>
    </section>
  );
}
