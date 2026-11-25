import type { PageProps } from "spacepress/app";
import { EmberShell } from "../../components/EmberShell";

export const metadata = { robots: { index: false, follow: false } };

export default function EmberRoute({ params }: PageProps<"[...path]">) {
  const path = "/" + params.path.map(segment =>
    segment.startsWith("@") ? "@" + encodeURIComponent(segment.slice(1)) : encodeURIComponent(segment),
  ).join("/");
  return <EmberShell invite={null} path={path} />;
}
