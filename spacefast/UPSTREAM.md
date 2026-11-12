# Upstream Ember

This is a GitHub fork of [NYLLON-SOFTWARE/ember-cloudflare](https://github.com/NYLLON-SOFTWARE/ember-cloudflare). The Spacefast build verifies the revision and checksum in `upstream/base.json`, materializes the upstream-derived files, and applies `upstream/ember-web.patch` and the replacements in `upstream/adapters/`. The bundled server parsers retain their upstream and dependency licenses.

To update the pin, check out the desired commit in a clean clone of the official repository, then run these commands from this fork:

```sh
npm run source:pin -- FULL_COMMIT /path/to/clean/ember-checkout
npm run build
npm run source:check
npm run typecheck:server
npm test
```

If the patch conflicts, inspect the affected files and update the patch against the new revision before retrying. Review upstream changes to the rich-text and Slack parsers separately when updating the bundled server code.

Edit the Spacefast replacement files in `upstream/adapters/`. To record a change to an upstream-derived file, edit its generated copy and run `npm run source:capture`, then review the patch and rebuild.
