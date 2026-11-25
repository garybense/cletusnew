import { createFileRoute } from "@tanstack/react-router";
import { MissionDashboard } from "@/components/mission/dashboard";
import { getSnapshotServer } from "@/lib/cletus/server";

export const Route = createFileRoute("/")({
  loader: async () => getSnapshotServer(),
  component: Home,
});

function Home() {
  const initialSnapshot = Route.useLoaderData();
  return <MissionDashboard initialSnapshot={initialSnapshot} />;
}
