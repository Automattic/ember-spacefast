import { EmberShell } from "../../components/EmberShell";

export const metadata = { robots: { index: false, follow: false } };

export default function EmberRoute() {
  return <EmberShell invite={null} />;
}
