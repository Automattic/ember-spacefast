import type { PageProps } from "spacepress/app";
import { EmberShell } from "../../../components/EmberShell";

export const metadata = { robots: { index: false, follow: false } };

export default function Join({ params }: PageProps<"join/[code]">) {
  return <EmberShell invite={null} path={"/join/" + encodeURIComponent(params.code)} />;
}
