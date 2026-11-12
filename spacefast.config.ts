import { defineConfig } from "spacefast/config";

export default defineConfig({
  "name": "Ember",
  "build": {"outputDirectory": "dist"},
  "meta": {"title":"Ember — team chat", "description":"Rooms, direct messages, threads, searchable history and private file sharing. Powered by native Spacefast services.", "favicon":"/favicon.svg", "image":"/assets/ember-social.png"},
  "crons": [{ "path": "/bot-delivery/recover", "schedule": "12h" }, { "path": "/push-delivery/recover", "schedule": "12h" }, { "path": "/assistant/recover", "schedule": "*/5 * * * *" }],
  "runtime": {
    "kind": "zero",
    "server": "server/index.ts",
    "client": "client/index.tsx"
  }
});
