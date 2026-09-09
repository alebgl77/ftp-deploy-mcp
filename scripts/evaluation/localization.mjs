import fs from "node:fs";
import { textOf } from "./fixture.mjs";

const pair = (en, fr) => ({ en, fr });
const TOOL_IDS = ["ftp_list_servers", "ftp_test", "ftp_list", "ftp_read", "ftp_upload", "ftp_deploy", "ftp_download", "ftp_mkdir", "ftp_rename", "ftp_delete"];
const INPUT_IDS = {
  ftp_list_servers: [], ftp_test: ["server"], ftp_list: ["server", "path", "limit", "offset"],
  ftp_read: ["server", "path", "max_bytes"], ftp_upload: ["server", "local_path", "remote_path"],
  ftp_deploy: ["server", "local_dir", "remote_dir", "include", "exclude", "dry_run"],
  ftp_download: ["server", "remote_path", "local_path", "overwrite"], ftp_mkdir: ["server", "path"],
  ftp_rename: ["server", "from_path", "to_path"], ftp_delete: ["server", "path", "recursive"],
};

export function verifyMetadata(c, i18n, catalogs, evidence) {
  const sorted = (values) => [...values].sort().join("\n");
  c.check("locale-tool-ids", pair("Tool IDs retain their exact API names", "Les IDs des outils conservent leurs noms API exacts"), sorted(c.tools.map((tool) => tool.name)) === sorted(TOOL_IDS));
  let fields = 0;
  for (const tool of c.tools) {
    for (const property of ["title", "description"]) {
      const key = `mcp.${tool.name}.${property}`;
      c.check(`locale-${tool.name}-${property}`, pair("Advertised metadata matches the selected catalog", "Les métadonnées annoncées correspondent au catalogue sélectionné"), tool[property] === i18n.t(key));
      c.check(`locale-${tool.name}-${property}-translation`, pair("French and English catalog text are distinct", "Les textes français et anglais du catalogue sont distincts"), catalogs.fr[key] !== catalogs.en[key]);
    }
    const prefix = `mcp.${tool.name}.input.`;
    const expectedFields = INPUT_IDS[tool.name];
    c.check(`locale-${tool.name}-field-ids`, pair("Input field IDs remain unchanged", "Les IDs des champs d’entrée restent inchangés"), sorted(Object.keys(tool.inputSchema.properties ?? {})) === sorted(expectedFields));
    for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      const key = field === "server" ? "mcp.common.input.server.description" : `${prefix}${field}.description`;
      c.check(`locale-${tool.name}-${field}`, pair("Field description matches the selected catalog", "La description du champ correspond au catalogue sélectionné"), schema.description === i18n.t(key, { defaultBytes: 262144, hardMax: 1048576 }));
      fields++;
    }
  }
  const output = c.tool("ftp_test").outputSchema;
  const success = output.oneOf?.find((schema) => schema.properties?.protocol) ?? output;
  c.check("locale-protocol-enums", pair("Protocol enum values remain ftp/ftps/sftp", "Les valeurs de protocole restent ftp/ftps/sftp"), sorted(success.properties.protocol.enum) === sorted(["ftp", "ftps", "sftp"]));
  evidence.metadataVerified = true;
  evidence.toolTitles = 10;
  evidence.toolDescriptions = 10;
  evidence.inputDescriptions = fields;
}

export function verifyBusinessSample(c, i18n, name, args, outcome, evidence) {
  if (outcome.kind !== "response") return;
  const result = outcome.result;
  const error = result.structuredContent?.error;
  let key; let params; let expectedCode;
  if (error) {
    if (error.code === "READ_ONLY") { key = "runtime.tools.readOnly"; params = { name: args.server ?? "alpha" }; expectedCode = "READ_ONLY"; }
    else if (c.calls.at(-1)?.tool === "ftp_upload" && args.server === "unknown") { key = "runtime.config.unknownServer"; params = { name: "unknown", available: "alpha" }; expectedCode = "SERVER_UNKNOWN"; }
    else if (c.tools && error.code === "INVALID_ARGUMENT" && c.caseID === "SCRIPT-024") { key = "error.INVALID_ARGUMENT"; params = {}; expectedCode = "INVALID_ARGUMENT"; }
    else if (c.caseID === "SCRIPT-017") { key = "runtime.remote.escape"; params = { path: "../escape", root: "/" }; expectedCode = "PATH_REJECTED"; }
    if (!key) return;
    const expected = i18n.t(key, params);
    c.check(`locale-${name}-error-message`, pair("Structured error message matches the selected catalog", "Le message d’erreur structuré correspond au catalogue sélectionné"), error.message === expected);
    c.check(`locale-${name}-error-code`, pair("Error code remains an unchanged machine identifier", "Le code d’erreur reste un identifiant machine inchangé"), error.code === expectedCode);
    c.check(`locale-${name}-error-wrapper`, pair("Visible error wrapper uses the selected catalog", "L’en-tête d’erreur visible utilise le catalogue sélectionné"), textOf(result) === i18n.t("error.result", { code: expectedCode, message: expected }));
    evidence.errorSamples.push({ toolID: name, catalogKey: key, matched: true, codePreserved: true });
    return;
  }
  if (result.isError === true) return;
  if (name === "ftp_upload" && ["SCRIPT-002", "SCRIPT-003", "SCRIPT-004", "SCRIPT-034", "SCRIPT-040"].includes(c.caseID)) {
    key = "runtime.tools.upload.done";
    const selectedName = args.server ?? c.configuration.defaultServer ?? "alpha";
    const selected = c.configuration.servers[selectedName];
    const localPath = fs.realpathSync(c.localPath(args.local_path));
    params = { localPath, remotePath: "/target.txt", size: `${fs.statSync(localPath).size} B`, protocol: "sftp", host: selected.host };
    c.check("locale-upload-data-ids", pair("Server and path values are preserved as data", "Les valeurs de serveur et de chemin restent des données inchangées"), result.structuredContent.server === selectedName && result.structuredContent.remote_path === "/target.txt" && result.structuredContent.local_path === localPath);
  } else if (name === "ftp_download" && ["SCRIPT-011", "SCRIPT-035"].includes(c.caseID)) {
    key = "runtime.tools.download.done";
    params = { remotePath: "/target.txt", localPath: c.localPath(args.local_path), size: `${c.priorBytes.length} B` };
  } else if (name === "ftp_read" && c.caseID === "SCRIPT-039") {
    key = "runtime.tools.read.heading";
    const bytes = c.primary.bytes("/instructions.txt");
    const expected = i18n.t(key, { path: "/instructions.txt", size: `${bytes.length} B`, note: "" }) + "\n\n" + bytes.toString("utf8");
    c.check("locale-read-header-and-data", pair("Read header is localized and remote contents remain unchanged", "L’en-tête de lecture est traduit et le contenu distant reste inchangé"), textOf(result) === expected);
    evidence.successSamples.push({ toolID: name, catalogKey: key, matched: true, dataPreserved: true });
    return;
  } else return;
  c.check(`locale-${name}-success-message`, pair("Success text matches the selected catalog", "Le texte de réussite correspond au catalogue sélectionné"), textOf(result) === i18n.t(key, params));
  evidence.successSamples.push({ toolID: name, catalogKey: key, matched: true, dataPreserved: true });
}
