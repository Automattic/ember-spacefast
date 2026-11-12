# Ember for Spacefast

[![Deploy with Spacefast](https://badge.space.fast/assets/deploy-with-spacefast.svg)](https://my.spacefast.com/new?git=https%3A%2F%2Fgithub.com%2FAutomattic%2Fember-spacefast)

Ember is a team chat app. This fork adapts [Ember for Cloudflare](https://github.com/NYLLON-SOFTWARE/ember-cloudflare) to Spacefast Zero for sign-in, storage, and live updates. Try it at [ember.space.fast](https://ember.space.fast/).

## Develop locally

Install Node.js 22 or newer and Git. Copy `.env.server.example` to `.env.server` and set the workspace owner’s verified sign-in address before creating a workspace. Then run:

```sh
cd spacefast
npm ci
npm test
npm run dev
```

`npm run dev` builds the app and starts a local Zero runtime backed by SQLite.

## Publish to Spacefast

Use the deploy button to import this repository. From the `spacefast/` directory, you can also prepare the serving package and publish it with the CLI:

```sh
stage=$(npm run --silent package:serving | node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).path')
npm --prefix "$stage" install --ignore-scripts
./node_modules/.bin/sf publish "$stage" --space YOUR_SPACE --target preview --wait
```

Configure production credentials as server-side variables on your Space. The serving package excludes local configuration, fixtures, and the editable upstream snapshot.

## Follow upstream

The official Ember app and packages live at their original paths. The `spacefast/` directory holds the build for Spacefast Zero, including a pinned upstream snapshot and the changes applied to generated output. [Upstream update workflow](spacefast/UPSTREAM.md)
