// FileZilla Site Manager import.
//
// Parses sitemanager.xml WITHOUT any XML dependency: tolerant string/regex
// parsing over <Server>...</Server> blocks. Produces the ftp-servers.json
// structure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Default sitemanager.xml locations per platform.
export function defaultSiteManagerPaths() {
  const home = os.homedir();
  const paths = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    paths.push(path.join(appData, "FileZilla", "sitemanager.xml"));
  }
  // Linux/macOS (and a fallback everywhere)
  paths.push(path.join(home, ".config", "filezilla", "sitemanager.xml"));
  return paths;
}

function decodeEntities(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagValue(block, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  return decodeEntities(m[1].trim());
}

function passValue(block) {
  const m = block.match(/<Pass\b([^>]*)>([\s\S]*?)<\/Pass>/i);
  if (!m) return { present: false, value: null };
  const attrs = m[1] || "";
  const raw = m[2] || "";
  if (/encoding\s*=\s*"base64"/i.test(attrs)) {
    try {
      return { present: true, value: Buffer.from(raw.trim(), "base64").toString("utf8") };
    } catch {
      return { present: true, value: "" };
    }
  }
  return { present: raw.trim().length > 0, value: decodeEntities(raw.trim()) };
}

// FileZilla protocol enum -> our protocol string.
function mapProtocol(p) {
  switch (String(p)) {
    case "0": // FTP
    case "6": // Insecure FTP
      return "ftp";
    case "1": // SFTP (SSH)
      return "sftp";
    case "3": // FTPS (implicit)
    case "4": // FTPES (explicit over TLS)
      return "ftps";
    default:
      return null;
  }
}

// Decode FileZilla's RemoteDir "1 0 4 site 3 sub" -> "/site/sub".
// Format: <fmt> <type> then repeated <len> <segment> pairs. Segment text is
// length-prefixed, so it may itself contain spaces.
export function decodeRemoteDir(s) {
  if (typeof s !== "string") return "";
  const str = s.trim();
  if (!str) return "";
  let i = 0;
  const readToken = () => {
    let j = i;
    while (j < str.length && str[j] !== " ") j++;
    const tok = str.slice(i, j);
    i = j + 1;
    return tok;
  };
  readToken(); // format id
  readToken(); // type/prefix
  const segs = [];
  while (i < str.length) {
    const lenTok = readToken();
    if (lenTok === "") break;
    const len = parseInt(lenTok, 10);
    if (!Number.isFinite(len) || len < 0) break;
    const seg = str.slice(i, i + len);
    i += len + 1; // segment + trailing space
    segs.push(seg);
  }
  if (segs.length === 0) return "";
  return "/" + segs.join("/");
}

// Turn a display name into a config key: lowercase, alnum + dash.
export function sanitizeKey(name) {
  let key = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!key) key = "server";
  return key;
}

// Parse a sitemanager.xml string. Returns { defaultServer, servers, warnings }.
export function parseSiteManager(xml) {
  const warnings = [];
  const servers = {};
  const usedKeys = new Set();
  let defaultServer = null;

  const blocks = xml.match(/<Server\b[^>]*>[\s\S]*?<\/Server>/gi) || [];
  let index = 0;
  for (const block of blocks) {
    index += 1;
    const rawName = tagValue(block, "Name") || `Server ${index}`;
    const protocolRaw = tagValue(block, "Protocol");
    const protocol = mapProtocol(protocolRaw ?? "0");
    if (!protocol) {
      warnings.push(`skipping "${rawName}": unsupported FileZilla protocol "${protocolRaw}"`);
      continue;
    }
    const implicitTLS = protocolRaw === "3"; // FTPS (implicit); Protocol 4 (FTPES) stays plain "ftps"
    const host = tagValue(block, "Host");
    if (!host) {
      warnings.push(`skipping "${rawName}": no <Host>`);
      continue;
    }
    const user = tagValue(block, "User") || "anonymous";
    const portRaw = tagValue(block, "Port");
    const remoteDir = decodeRemoteDir(tagValue(block, "RemoteDir") || "");

    // unique key
    let key = sanitizeKey(rawName);
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}-${n}`)) n += 1;
      key = `${key}-${n}`;
    }
    usedKeys.add(key);

    const entry = { protocol, host };
    if (implicitTLS) entry.implicitTLS = true;
    if (portRaw && /^\d+$/.test(portRaw)) {
      const port = Number(portRaw);
      const isDefaultPort =
        (protocol === "sftp" && port === 22) || (protocol !== "sftp" && port === 21);
      if (!isDefaultPort) entry.port = port;
    }
    entry.user = user;

    const pass = passValue(block);
    if (pass.present && pass.value) {
      entry.password = pass.value;
    } else {
      const placeholder = `\${ENV:${key.toUpperCase().replace(/-/g, "_")}_PASSWORD}`;
      entry.password = placeholder;
      warnings.push(
        `"${rawName}": no stored password — set "${entry.password}" via an environment variable`
      );
    }

    if (remoteDir) entry.root = remoteDir;

    if (protocol === "ftp") {
      warnings.push(
        `"${rawName}": plain FTP is NOT encrypted — connections will be refused until you ` +
          `switch this server to sftp/ftps or explicitly set "allowInsecure": true on it`
      );
    }

    servers[key] = entry;
    if (!defaultServer) defaultServer = key;
  }

  return { defaultServer, servers, warnings };
}

// Build the final config object (pretty JSON-ready).
export function buildConfig(parsed) {
  const config = {};
  if (parsed.defaultServer) config.defaultServer = parsed.defaultServer;
  config.servers = parsed.servers;
  return config;
}

// CLI entry for `import-filezilla`. `opts` = { file, out, force }.
// `log` is where diagnostics go (default console.error); returns an exit code.
export function runImport(opts, log = console.error) {
  let file = opts.file;
  if (!file) {
    const candidates = defaultSiteManagerPaths();
    file = candidates.find((p) => {
      try {
        return fs.existsSync(p) && fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (!file) {
      log("Error: no sitemanager.xml found. Searched:");
      for (const p of candidates) log(`  - ${p}`);
      log("Pass --file <path> to point at your FileZilla sitemanager.xml.");
      return 1;
    }
  }

  let xml;
  try {
    xml = fs.readFileSync(file, "utf8");
  } catch (err) {
    log(`Error: cannot read ${file}: ${err.message}`);
    return 1;
  }

  const parsed = parseSiteManager(xml);
  for (const w of parsed.warnings) log(`Warning: ${w}`);
  const serverCount = Object.keys(parsed.servers).length;
  if (serverCount === 0) {
    log(`Error: no importable servers found in ${file}.`);
    return 1;
  }
  log(`Imported ${serverCount} server(s) from ${file}.`);

  const config = buildConfig(parsed);
  const json = JSON.stringify(config, null, 2) + "\n";

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    if (fs.existsSync(outPath) && !opts.force) {
      log(`Error: ${outPath} already exists. Pass --force to overwrite.`);
      return 1;
    }
    try {
      fs.writeFileSync(outPath, json, "utf8");
    } catch (err) {
      log(`Error: cannot write ${outPath}: ${err.message}`);
      return 1;
    }
    log(`Wrote ${outPath}. Review it, then point your MCP client at this server.`);
    log(
      "Warning: the generated config contains plaintext passwords - keep it out of version control (.gitignore it) and restrict file permissions (e.g. chmod 600)."
    );
    return 0;
  }

  // No --out: print JSON to stdout (this CLI mode never speaks JSON-RPC).
  process.stdout.write(json);
  log(
    "Warning: the generated config contains plaintext passwords - keep it out of version control (.gitignore it) and restrict file permissions (e.g. chmod 600)."
  );
  return 0;
}
