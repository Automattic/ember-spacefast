import type { LayoutProps } from "spacepress/app";

export const template = "blank";
export const metadata = {
  title: "Ember",
  links: [
    { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    { rel: "apple-touch-icon", href: "/assets/ember-touch-icon.png" },
    { rel: "manifest", href: "/manifest.webmanifest" },
  ],
  scripts: ["/assets/spacepress-ember.js"],
};

export default function Layout({ children }: LayoutProps) {
  return <>{children}</>;
}
