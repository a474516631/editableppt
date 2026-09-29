import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

const DEFAULT_BASE_URL = "https://editableppt.com";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 20;
const AUTH_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "editableppt",
  "mcp-auth.json",
);

function baseUrl(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  ) {
    throw new Error("The EditablePPT URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Invalid EditablePPT URL");
  return url.origin;
}

async function credentials() {
  if (process.env.EDITABLEPPT_API_KEY) {
    return {
      key: process.env.EDITABLEPPT_API_KEY,
      baseUrl: baseUrl(process.env.EDITABLEPPT_BASE_URL),
    };
  }
  try {
    const saved = JSON.parse(await readFile(AUTH_FILE, "utf8"));
    return {
      key: saved.key,
      baseUrl: baseUrl(process.env.EDITABLEPPT_BASE_URL || saved.baseUrl),
    };
  } catch {
    return null;
  }
}

async function api(auth, endpoint, init = {}) {
  const response = await fetch(new URL(endpoint, auth.baseUrl), {
    ...init,
    headers: { Authorization: `Bearer ${auth.key}`, ...init.headers },
    signal: AbortSignal.timeout(120_000),
  });
  if (
    response.ok &&
    response.headers
      .get("content-type")
      ?.includes(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      )
  ) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0) {
    const error = new Error(
      payload?.message || `EditablePPT returned HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

async function authorize() {
  const url = baseUrl(
    process.argv.find((arg) => arg.startsWith("--base-url="))?.slice(11) ||
      process.env.EDITABLEPPT_BASE_URL,
  );
  process.stderr.write(
    `Open ${url}/settings/apikeys, sign in, and create an API key named "Codex MCP".\n`,
  );
  process.stderr.write("Paste the key here (it will not be echoed): ");
  if (!process.stdin.isTTY)
    throw new Error("Run authorization in an interactive terminal");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  prompt._writeToOutput = () => {};
  const key = await new Promise((resolve) => prompt.question("", resolve));
  prompt.close();
  process.stderr.write("\n");
  if (!/^sk_[A-Za-z0-9_-]+$/.test(key))
    throw new Error("Invalid API key format");
  await api({ key, baseUrl: url }, "/api/image-conversions/auth");
  await mkdir(path.dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
  await writeFile(AUTH_FILE, JSON.stringify({ key, baseUrl: url }), {
    mode: 0o600,
  });
  await chmod(AUTH_FILE, 0o600);
  process.stderr.write(`Authorized. Credentials saved to ${AUTH_FILE}\n`);
}

async function availablePath(input) {
  const parsed = path.parse(input);
  for (let index = 0; index < 100; index++) {
    const candidate = index
      ? path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`)
      : input;
    try {
      await access(candidate, constants.F_OK);
    } catch (error) {
      if (error.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error("Could not choose an available output filename");
}

async function convert(args, onProgress = () => {}) {
  const auth = await credentials();
  if (!auth)
    throw new Error(
      `Authorization required. Open ${DEFAULT_BASE_URL}/settings/apikeys and run "node server.mjs auth" from the plugin directory.`,
    );
  if (
    !Array.isArray(args.images) ||
    args.images.length < 1 ||
    args.images.length > MAX_IMAGES
  ) {
    throw new Error(`Provide 1-${MAX_IMAGES} image paths`);
  }
  const images = [];
  for (const input of args.images) {
    if (typeof input !== "string" || !path.isAbsolute(input))
      throw new Error("Each image path must be absolute");
    if (!/\.(png|jpe?g)$/i.test(input))
      throw new Error("Use PNG or JPG images");
    const file = await stat(input);
    if (!file.isFile() || !file.size || file.size > MAX_IMAGE_BYTES)
      throw new Error(`Image must be a file up to 8 MB: ${input}`);
    images.push(input);
  }
  const title =
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim().slice(0, 120)
      : path.parse(images[0]).name;
  const output =
    args.output_path === undefined
      ? await availablePath(
          path.join(
            path.dirname(images[0]),
            `${title.replace(/[<>:"/\\|?*]/g, "-")}.pptx`,
          ),
        )
      : args.output_path;
  if (
    typeof output !== "string" ||
    !path.isAbsolute(output) ||
    !output.toLowerCase().endsWith(".pptx")
  ) {
    throw new Error("output_path must be an absolute .pptx path");
  }
  try {
    await access(output, constants.F_OK);
    throw new Error(`Output already exists: ${output}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const ids = [];
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    onProgress({
      completed: index,
      total: images.length,
      image: path.basename(image),
    });
    const bytes = await readFile(image);
    let task;
    for (let retry = 0; retry <= 31; retry++) {
      try {
        task = await api(
          auth,
          `/api/image-conversions?title=${encodeURIComponent(path.parse(image).name)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": image.toLowerCase().endsWith(".png")
                ? "image/png"
                : "image/jpeg",
            },
            body: bytes,
          },
        );
        break;
      } catch (error) {
        if (error.status !== 429 || retry === 31) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    process.stderr.write(
      `Converting image ${index + 1}/${images.length}: ${path.basename(image)}\n`,
    );
    const deadline = Date.now() + 11 * 60_000;
    while (task.status === "processing" || task.status === "pending") {
      if (Date.now() > deadline)
        throw new Error(`Conversion timed out: ${image}`);
      task = await api(auth, "/api/image-conversions/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id }),
      });
      if (task.status === "processing" || task.status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    if (task.status !== "success")
      throw new Error(task.error || `Conversion failed: ${image}`);
    ids.push(task.id);
    onProgress({
      completed: ids.length,
      total: images.length,
      image: path.basename(image),
    });
  }
  const pptx = await api(auth, "/api/image-conversions/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, title }),
  });
  await writeFile(output, pptx, { flag: "wx" });
  return { output_path: output, slide_count: ids.length, bytes: pptx.length };
}

const tool = {
  name: "convert_images_to_pptx",
  description:
    "Convert 1-20 local PNG/JPG images, in order, into one editable PowerPoint deck using EditablePPT AI conversion. A signed-in API key is required.",
  inputSchema: {
    type: "object",
    properties: {
      images: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", description: "Absolute local PNG/JPG path" },
      },
      output_path: {
        type: "string",
        description:
          "Optional absolute .pptx output path; existing files are never overwritten",
      },
      title: { type: "string", description: "Optional presentation title" },
    },
    required: ["images"],
  },
};
const statusTool = {
  name: "get_conversion_status",
  description:
    "Check the progress and saved PPTX path of a conversion started by convert_images_to_pptx.",
  inputSchema: {
    type: "object",
    properties: { job_id: { type: "string" } },
    required: ["job_id"],
  },
};
const jobs = new Map();

function startConversion(args) {
  if ([...jobs.values()].some((job) => job.status === "processing")) {
    throw new Error(
      "A conversion is already running; query its status before starting another",
    );
  }
  const id = crypto.randomUUID();
  const job = {
    status: "processing",
    completed: 0,
    total: Array.isArray(args.images) ? args.images.length : 0,
  };
  jobs.set(id, job);
  void convert(args, (progress) => Object.assign(job, progress))
    .then((result) => Object.assign(job, { status: "success", ...result }))
    .catch((error) =>
      Object.assign(job, {
        status: "failed",
        error: error.message || "Conversion failed",
      }),
    );
  return { job_id: id, status: job.status };
}

function respond(id, payload) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`,
  );
}

async function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    respond(message.id, {
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "editableppt-image-to-ppt", version: "0.1.0" },
      },
    });
  } else if (message.method === "tools/list") {
    respond(message.id, { result: { tools: [tool, statusTool] } });
  } else if (
    message.method === "tools/call" &&
    [tool.name, statusTool.name].includes(message.params?.name)
  ) {
    try {
      const args = message.params.arguments || {};
      const result =
        message.params.name === tool.name
          ? startConversion(args)
          : jobs.get(args.job_id) || {
              status: "not_found",
              error: "Unknown conversion job",
            };
      respond(message.id, {
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    } catch (error) {
      respond(message.id, {
        result: {
          isError: true,
          content: [
            { type: "text", text: error.message || "Conversion failed" },
          ],
        },
      });
    }
  } else {
    respond(message.id, {
      error: { code: -32601, message: "Method not found" },
    });
  }
}

if (process.argv[2] === "auth") {
  authorize().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    try {
      void handle(JSON.parse(line));
    } catch {
      process.stderr.write("Invalid MCP request\n");
    }
  });
}
