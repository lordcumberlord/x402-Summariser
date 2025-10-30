import { app } from "./agent";

const port = Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz") {
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return app.fetch(req);
  },
});

console.log(
  `🚀 Agent ready at http://${server.hostname}:${server.port}/.well-known/agent.json`
);
