import { get_current_user_id, home_url, wp_login_url } from "php/wordpress";
import { Link } from "spacepress/app";

export function EmberShell({ invite, path = "/" }: { invite: string | null; path?: string }) {
  if (!get_current_user_id()) {
    const redirect = home_url(invite ? "/?invite=" + encodeURIComponent(invite) : path);
    return <main style={{ fontFamily: "system-ui", margin: "12vh auto", maxWidth: "28rem", padding: "1.5rem" }}>
      <h1>Ember</h1>
      <a href={wp_login_url(redirect)}>Sign in with WordPress</a>
    </main>;
  }
  return <div id="ember-native-app" style={{ minHeight: "100dvh" }}>
    <p>Loading Ember…</p>
    <Link href="/">Return to Ember home</Link>
  </div>;
}
