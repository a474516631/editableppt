import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const serverPath = path.resolve("plugins/editableppt-image-to-ppt/server.mjs");
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9l3S8AAAAASUVORK5CYII=",
  "base64",
);

test("MCP converts ordered local images and writes one PPTX", async (t) => {
  const requests = [];
  const mock = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer sk_test");
    const url = new URL(request.url, "http://localhost");
    requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/export")) {
      const body = JSON.parse((await streamToBuffer(request)).toString());
      assert.deepEqual(body.ids, ["id-1", "id-2"]);
      response.writeHead(200, {
        "content-type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      });
      response.end(Buffer.from("PK\x03\x04pptx"));
      return;
    }
    const id = url.pathname.endsWith("/advance")
      ? JSON.parse((await streamToBuffer(request)).toString()).id
      : `id-${requests.filter((entry) => entry === "POST /api/image-conversions").length}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        code: 0,
        data: {
          id,
          status: url.pathname.endsWith("/advance") ? "success" : "processing",
        },
      }),
    );
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  t.after(() => mock.close());
  const directory = await mkdtemp(path.join(tmpdir(), "editableppt-mcp-"));
  const first = path.join(directory, "first.png");
  const second = path.join(directory, "second.png");
  await writeFile(first, imageBytes);
  await writeFile(second, imageBytes);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      EDITABLEPPT_API_KEY: "sk_test",
      EDITABLEPPT_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let nextId = 0;
  async function call(method, params) {
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("MCP response timed out")),
        5000,
      );
      pending.set(id, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return response;
  }
  const initialized = await call("initialize", {
    protocolVersion: "2025-03-26",
  });
  assert.equal(initialized.result.serverInfo.name, "editableppt-image-to-ppt");
  const listed = await call("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["convert_images_to_pptx", "get_conversion_status"],
  );
  const started = await call("tools/call", {
    name: "convert_images_to_pptx",
    arguments: { images: [first, second], title: "deck" },
  });
  const jobId = JSON.parse(started.result.content[0].text).job_id;
  let job;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await call("tools/call", {
      name: "get_conversion_status",
      arguments: { job_id: jobId },
    });
    job = JSON.parse(response.result.content[0].text);
    if (job.status !== "processing") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, "success", job.error);
  assert.equal(job.slide_count, 2);
  assert.equal((await readFile(job.output_path)).toString(), "PK\x03\x04pptx");
  assert.deepEqual(requests, [
    "POST /api/image-conversions",
    "POST /api/image-conversions/advance",
    "POST /api/image-conversions",
    "POST /api/image-conversions/advance",
    "POST /api/image-conversions/export",
  ]);
});

test("MCP requires authorization before uploading an image", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "editableppt-no-auth-"));
  const image = path.join(directory, "slide.png");
  await writeFile(image, imageBytes);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      EDITABLEPPT_API_KEY: "",
      XDG_CONFIG_HOME: directory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "convert_images_to_pptx",
        arguments: { images: [image] },
      },
    })}\n`,
  );
  for (let attempt = 0; attempt < 50 && responses.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(responses.length, 1);
  const jobId = JSON.parse(responses[0].result.content[0].text).job_id;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_conversion_status",
        arguments: { job_id: jobId },
      },
    })}\n`,
  );
  for (let attempt = 0; attempt < 50 && responses.length < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const status = JSON.parse(responses[1].result.content[0].text);
  assert.equal(status.status, "failed");
  assert.match(status.error, /Authorization required/);
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
