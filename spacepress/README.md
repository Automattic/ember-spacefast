# Ember on SpacePress

Ember uses the fork's existing React UI with WordPress sign-in and SpacePress actions, tables, private uploads, and background jobs. Open rooms and threads poll for updates every two seconds and fetch missed messages from history when polls resume.

The workspace supports open rooms, private rooms, direct messages, threaded replies, formatting, edits, reactions, search, unread state, favorites, room administration, and device-encrypted files. Invitations use WordPress mail. WordPress Action Scheduler runs push, outgoing bot, and assistant delivery after a message commits.

An existing SpacePress preview upgrades its WordPress tables in place. New messages are indexed as they are written. Action Scheduler indexes existing history in batches of 50 messages per minute. Search includes unindexed messages while the backfill runs.

Spacefast Zero and WordPress each have their own workspace data. A cutover that preserves Zero history still needs an export and a mapping for WordPress users, room memberships, and attachments.

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

Sign in as a WordPress administrator to set up the workspace. On older installs, setup keeps existing rooms and their members. Create WordPress users with the Subscriber role. They need an Ember membership to open rooms. They can accept an email invitation, use the workspace join code, or confirm their name when open sign-up is enabled. WordPress owns registration and password recovery. In Ember, open `/rooms/closeds/new` to create a private room and choose its members.

For a tailnet preview, use `spacepress dev spacepress --port <local-port> --url https://<tailnet-host>:<https-port>` and point Tailscale Serve at the local listener. Keep the URL at the site root. Change Studio's default admin password before sharing the URL.

Studio's built-in server needs a proxy that denies direct access to the private uploads directory. Run `node spacepress/dev-proxy.ts <proxy-port> <local-port>` and point Tailscale Serve at the proxy port. From the `spacepress` directory, run `spacepress wp eval 'echo \SpacePress\Wp\WpFiles::probe() ? "protected" : "exposed";'` to verify that WordPress can protect the directory. On a hosted site, SpacePress uses its configured private uploads backend.

## Build for Spacefast

Use the same build steps, including a final `spacepress build spacepress` after generating the browser assets. Use the `spacepress` directory as the SpacePress project when pushing to a WordPress-enabled Spacefast site. Provision the WordPress users there and verify sign-in and private rooms on that host.

## Optional services

| Feature | WordPress runtime configuration |
| --- | --- |
| Email invitations | Working WordPress mail transport and a sending domain on the host |
| Email-domain admission | `EMBER_SIGNUP_EMAIL_DOMAINS` as a comma-separated list and WordPress mail. The signed-in user receives a 30-minute verification link at their WordPress email address. |
| Incoming Slack webhooks | Create a webhook in Ember's workspace settings and save its private posting URL |
| Outgoing bot replies | `EMBER_BOT_SIGNING_KEY` with at least 32 characters and a public HTTPS callback configured in Ember |
| Browser push | `EMBER_PUSH_PRIVATE_KEY` and `EMBER_PUSH_CONTACT`. Set the matching `EMBER_PUSH_PUBLIC_KEY` to reuse the generated public key |
| AI assistants | `EMBER_OPENAI_API_KEY`, `EMBER_OPENAI_MODEL`, `EMBER_OPENAI_WEBHOOK_SECRET`, and an enabled assistant profile. Register `/assistant/openai` for OpenAI response events. |

Uploading and finalizing a file require an active Ember membership and an open reservation from the past hour. The hourly byte quota applies when Ember creates the reservation. Private-room and direct-message files need an enrolled browser for each person. The browser encrypts chunks before uploading and wraps the file key for the enrolled devices in the room.

## Verify room permissions in a browser

Install the repository's pnpm dependencies and Playwright Chromium. Create three local subscribers and supply a private JSON file with three objects containing `username`, `password`, and `name`, in creator, room member, and non-member order. Run from the repository root:

```sh
node e2e/spacepress-smoke.ts <site-url> <credentials.json> [screenshot-directory]
node e2e/spacepress-parity.ts <site-url> <credentials.json> [admin-credentials.json]
```

The smoke test creates a room, checks delivery in both directions without reload, reloads history, and verifies that a signed-in non-member cannot read or post to the room.

The parity check exercises direct messages, threaded replies, formatted edits, reactions, search isolation, favorites, and encrypted downloads. An administrator credentials object with the same fields adds incoming webhook and integration settings checks.
