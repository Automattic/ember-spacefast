export const metadata = {
  title: "About Ember",
  description: "Team chat with rooms, direct messages, threads, searchable history, and private file sharing.",
  openGraph: {
    title: "Ember — team chat",
    description: "Rooms, direct messages, threads, searchable history, and private file sharing.",
    image: "/assets/ember-social.png",
  },
  twitter: { card: "summary_large_image" },
};

export default function About() {
  return <main style={{ margin: "3rem auto", maxWidth: "44rem", padding: "1.5rem", fontFamily: "system-ui", lineHeight: 1.6 }}>
    <h1>About Ember</h1>
    <p>Ember is team chat with rooms, direct messages, threads, searchable history, and private file sharing.</p>
    <p>This workspace runs on SpacePress. Sign in with WordPress to open conversations. Private rooms and direct messages require room membership.</p>
    <a href="/">Open Ember</a>
  </main>;
}
