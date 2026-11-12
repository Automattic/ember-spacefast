# Upstream Ember

This is a GitHub fork of [NYLLON-SOFTWARE/ember-cloudflare](https://github.com/NYLLON-SOFTWARE/ember-cloudflare). The Spacefast build verifies the revision and checksum in `upstream/base.json`, materializes the upstream-derived files, and applies `upstream/ember-web.patch` and the replacements in `upstream/adapters/`. The bundled server parsers retain their upstream and dependency licenses.

Merge official Ember into a sync branch to preserve its source history. Check out the same commit in a clean clone of the official repository, then run these commands from this fork’s `spacefast/` directory:

```sh
npm run source:pin -- FULL_COMMIT /path/to/clean/ember-checkout
npm run build
npm run source:check
npm run typecheck:server
npm test
```

If the patch conflicts, inspect the affected files and update the patch against the new revision before retrying. Review upstream changes to the rich-text and Slack parsers separately when updating the bundled server code.

Edit the Spacefast replacement files in `upstream/adapters/`. To record a change to an upstream-derived file, edit its generated copy and run `npm run source:capture`, then review the patch and rebuild.

## Spacefast releases

After an upstream release passes the Spacefast tests and preview checks, tag the merged sync as `<upstream-tag>-spacefast.1`. Increment the Spacefast revision when shipping fixes against the same upstream tag. Mark upstream betas as prereleases on GitHub. Record the upstream tag and pin, any Spacefast-specific limitations, and the Spacefast deployment version in the release notes.
