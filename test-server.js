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

const pixelImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+QnqVAAAAAElFTkSuQmCC";

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
  if (
    request.method === "POST"
    && (request.url || "").split("?")[0] === "/api/analyze-recording"
  ) {
    request.resume();
    request.on("end", () => {
      const body = JSON.stringify({
        ok: true,
        figures: [
          { name: "stage4_signal_events_amplitude_change.png", url: pixelImage },
          { name: "stage4_signal_events_phase_change.png", url: pixelImage },
          { name: "micro_doppler_left_band.png", url: pixelImage },
          { name: "micro_doppler_right_band.png", url: pixelImage }
        ],
        predictions: null
      });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      });
      response.end(body);
    });
    return;
  }

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
