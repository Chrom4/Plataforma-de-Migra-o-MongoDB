import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyDir = process.env.KEYS_DIR || "/var/keys";

async function loadServerConfig() {
  const customPath = process.env.SERVERS_CONFIG_PATH
    ? path.resolve(process.env.SERVERS_CONFIG_PATH)
    : path.join(__dirname, "servers.local.js");

  if (fs.existsSync(customPath)) {
    const mod = await import(pathToFileURL(customPath).href);
    return {
      SOURCE_SERVERS: mod.SOURCE_SERVERS,
      TARGET_SERVERS: mod.TARGET_SERVERS,
    };
  }

  const example = await import("./servers.example.js");
  return {
    SOURCE_SERVERS: example.SOURCE_SERVERS,
    TARGET_SERVERS: example.TARGET_SERVERS,
  };
}

const { SOURCE_SERVERS, TARGET_SERVERS } = await loadServerConfig();

export { SOURCE_SERVERS, TARGET_SERVERS };

export const SERVERS = { ...SOURCE_SERVERS, ...TARGET_SERVERS };

export function getSourceServer(name) {
  return SOURCE_SERVERS[name] || null;
}

export function getTargetServer(name) {
  return TARGET_SERVERS[name] || null;
}

export function getServer(name) {
  return getSourceServer(name) || getTargetServer(name);
}

export function listServers() {
  return Object.entries(SERVERS).map(([name, data]) => ({
    name,
    ip: data.ip,
    user: data.user,
    path: data.path,
  }));
}

export function listServerOptions() {
  const toOption = ([name, data]) => ({
    name,
    ip: data.ip,
    user: data.user,
    path: data.path,
  });

  return {
    sources: Object.entries(SOURCE_SERVERS).map(toOption),
    targets: Object.entries(TARGET_SERVERS).map(toOption),
  };
}

export function resolvePrivateKey(server) {
  if (!server.key) {
    return undefined;
  }
  return `${keyDir}/${server.key}`;
}
