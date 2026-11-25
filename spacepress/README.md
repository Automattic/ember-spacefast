# Ember on SpacePress

Run Ember's room chat on WordPress using the React UI from the fork's existing Ember source overlay. SpacePress actions handle WordPress sessions, room membership, and messages. An open room polls WordPress every two seconds for updates.

The port covers WordPress sign-in, an open or private room, member selection when creating a private room, sending plain-text messages, and room history. DMs, threads, edits, reactions, search, push notifications, attachments, and the rest of the Zero feature set remain follow-up work. Some controls from the shared Ember UI still appear for these features. This uses a fresh WordPress database.

## Run locally

Use Node.js 24.15+ and a SpacePress compiler built at `92d6b2432c542a76552c53f4071736a2a7660296` from the framework's rename branch. Put the resulting `spacepress` executable on your PATH.

Run from the repository root:

```sh
npm ci --prefix spacefast
spacepress build spacepress
node spacepress/build-client.ts
spacepress dev spacepress
```

The first build generates the typed client. The browser build reuses Ember's source overlay and CSS pipeline and writes the bundle to SpacePress's public assets. Re-run the browser build after editing the browser code or changing server action types.

Create users with WordPress's Subscriber role and sign in through the site's WordPress login. In Ember, open the private-room creation form at `/rooms/closeds/new`, choose the members, and save. The room is visible only to members.

For a tailnet preview, use `spacepress dev spacepress --port <local-port> --url https://<tailnet-host>:<https-port>` and point Tailscale Serve at the local listener. Keep the URL at the site root. Change Studio's default admin password before sharing the URL.

## Build for Spacefast

Use the same build steps, including a final `spacepress build spacepress` after generating the browser assets. Use the `spacepress` directory as the SpacePress project when pushing to a WordPress-enabled Spacefast site. Provision the WordPress users there and verify sign-in and private rooms on that host.

## Verify room permissions in a browser

Install the repository's pnpm dependencies and Playwright Chromium. Create three local subscribers and supply a private JSON file with three objects containing `username`, `password`, and `name`, in creator, room member, and non-member order. Run from the repository root:

```sh
node e2e/spacepress-smoke.ts <site-url> <credentials.json> [screenshot-directory]
```

The smoke test creates a room, checks delivery in both directions without reload, reloads history, and verifies that a signed-in non-member cannot read or post to the room.
