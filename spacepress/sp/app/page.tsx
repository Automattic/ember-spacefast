import { EmberShell } from "../components/EmberShell";
import { text } from "spacepress";
import { type PageProps } from "spacepress/app";

export const search = { invite: text().max(200).optional() };
export const metadata = { robots: { index: false, follow: false } };

export default function Ember({ search }: PageProps<"", { invite: string | null }>) {
  return <EmberShell invite={search.invite} />;
}
