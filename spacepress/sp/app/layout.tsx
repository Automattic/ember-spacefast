import type { LayoutProps } from "spacepress/app";

export const template = "blank";
export const metadata = { title: "Ember", scripts: ["/assets/spacepress-ember.js"] };

export default function Layout({ children }: LayoutProps) {
  return <>{children}</>;
}
