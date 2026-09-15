import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const relative = normalize(pathname).replace(/^([/\\])+/, "");
    let path = join(root, relative || "index.html");
    if (!path.startsWith(root) || !(await stat(path).catch(() => null))?.isFile()) path = join(root, "index.html");
    const body = await readFile(path);
    response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(String(error));
  }
}).listen(1420, "127.0.0.1");
