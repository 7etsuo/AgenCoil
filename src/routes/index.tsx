import { createFileRoute } from "@tanstack/react-router";
import { CoilApp } from "@/components/coil-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <CoilApp />;
}
