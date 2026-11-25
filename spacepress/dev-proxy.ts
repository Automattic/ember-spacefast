import { createServer, request } from "node:http";

const [listen, backend] = process.argv.slice(2).map(Number);
if (!listen || !backend) throw new Error("Usage: node spacepress/dev-proxy.ts <listen-port> <studio-port>");

createServer((incoming, response) => {
  const raw = incoming.url ?? "/";
  let path: string;
  try {
    if (!raw.startsWith("/") || raw.startsWith("//")) throw new Error("Expected an origin path");
    path = decodeURIComponent(new URL(raw, "http://localhost").pathname).toLowerCase();
  } catch {
    response.writeHead(400).end("Invalid request path");
    return;
  }
  // Studio's development server does not apply Apache's .htaccess rule.
  if (path.split(/[\\/]/).some(part => part === "spacepress-private" || part === "typedpress-private")) {
    response.writeHead(403).end("Private file directory");
    return;
  }

  const upstream = request({
    hostname: "localhost", port: backend, path: raw, method: incoming.method, headers: incoming.headers,
  }, result => {
    response.writeHead(result.statusCode ?? 502, result.headers);
    result.pipe(response);
  });
  upstream.on("error", error => {
    if (response.headersSent) response.destroy(error);
    else response.writeHead(502).end("Studio is unavailable");
  });
  incoming.pipe(upstream);
}).listen(listen, "127.0.0.1");
