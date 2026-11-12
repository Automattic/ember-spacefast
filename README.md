# Ember for Spacefast

Start a room for your next project. Drop in the screenshot that explains the bug. Keep the follow-up in a thread so everyone can find the answer later.

Ember is open-source team chat with rooms, direct messages, reactions, and searchable history. This fork runs on Spacefast Zero, which handles sign-in, storage, and live updates.

**See Ember running** or use the button below to start a workspace of your own. [Open Ember](https://ember.space.fast/) · [Explore the public overview](https://ember.space.fast/about)

[![Deploy with Spacefast](https://badge.space.fast/assets/deploy-with-spacefast.svg)](https://my.spacefast.com/new?git=https%3A%2F%2Fgithub.com%2FAutomattic%2Fember-spacefast)

![Ember in dark mode, with an inline image, code snippets, reactions, and a file attachment](docs/screenshots/dark.png)

*Upstream Ember shown with a fictional team and sample conversations.*

## What to try first

- Invite a teammate and open a room for something you’re working on together.
- Share a screenshot or code snippet. Open the picture full-size or reply in a thread.
- Search for a message you sent and jump back to the conversation.

New attachments in private rooms and DMs can be shared with end-to-end encryption once participants enroll and verify their devices.

## Run it locally

Install Node.js 22 or newer and Git. From the repository root:

```sh
cd spacefast
npm ci
cp .env.server.example .env.server
```

Set `EMBER_ADMIN_EMAIL` in `.env.server` to the workspace owner’s verified sign-in address, then run:

```sh
npm run dev
```

This builds Ember and starts the local Spacefast Zero runtime with SQLite. Run `npm test` for the automated checks.

## Deploy from the CLI

From `spacefast/`, prepare the serving package and deploy a preview to your Space:

```sh
stage=$(npm run --silent package:serving | node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).path')
npm --prefix "$stage" install --ignore-scripts
./node_modules/.bin/sf publish "$stage" --space YOUR_SPACE --target preview --wait
```

Set production credentials as server-side variables on your Space. The serving package excludes local configuration, fixtures, and the editable upstream snapshot.

## Built from upstream Ember

The original app and packages are at their upstream paths. The Spacefast build lives in `spacefast/` and applies its compatibility changes to generated output. [Official Ember repository](https://github.com/NYLLON-SOFTWARE/ember-cloudflare) · [Upstream update workflow](spacefast/UPSTREAM.md)
