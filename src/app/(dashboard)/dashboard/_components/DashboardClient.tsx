"use client";

// Bare placeholder — frontend is frozen. This only exists so the dashboard
// route compiles and renders real data; the actual UI is being designed
// separately and will replace this component.

interface DashboardClientProps {
  initialData: Record<string, unknown>;
  user: {
    id?: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

export function DashboardClient({ initialData, user }: DashboardClientProps) {
  return (
    <pre style={{ padding: 16, fontSize: 12, whiteSpace: "pre-wrap" }}>
      {JSON.stringify({ user, initialData }, null, 2)}
    </pre>
  );
}
