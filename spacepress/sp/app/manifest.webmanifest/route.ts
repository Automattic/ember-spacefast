import { accountView } from "../../workspace";

export const guard = "anyone";

export async function GET() {
  const account = await accountView();
  return {
    headers: { "content-type": "application/manifest+json; charset=utf-8" },
    body: JSON.stringify({
      id: "/", name: account.name, short_name: account.name, start_url: "/", scope: "/",
      display: "standalone", background_color: "#ffffff",
      icons: [
        { src: "/assets/ember-icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/assets/ember-icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    }),
  };
}
