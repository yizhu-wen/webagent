const fs = require("fs");
const http = require("http");
const path = require("path");

const rootDir = __dirname;
const host = "127.0.0.1";
const port = 8010;

const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav"
};

function resolveStaticPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(rootDir, normalizedPath);

  if (!filePath.startsWith(rootDir)) {
    return null;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  return filePath;
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const filePath = resolveStaticPath(request.url || "/");
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
    return;
  }

  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fs.statSync(filePath).size
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Static test server running at http://${host}:${port}/`);
});
