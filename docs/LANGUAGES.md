# CLI languages

[Français](./LANGUAGES.fr.md)

The command line uses English by default. Select French with either:

```sh
node src/index.js --lang fr --help
node src/index.js setup --lang fr
node src/index.js doctor --lang fr
node src/index.js import-filezilla --lang fr --file ./sitemanager.xml --out ./servers.json
```

`FTP_MCP_LANG=fr` selects the same language through the environment.
`--lang en` or `--lang fr` takes precedence over the environment, including
an invalid environment value. The option is extracted before the subcommand
parser and may appear before or after the subcommand. `--lang=fr` also works.
Only the exact values `en` and `fr` are accepted; an invalid or incomplete
option exits unsuccessfully before setup or import writes. OS locale settings
such as `LANG` are not used.

## Current scope

Translated surfaces include general and subcommand help, setup prompts and
choices, connection-test labels and hints, doctor diagnostics, FileZilla import
warnings, and server startup/fatal messages. Some diagnostic details returned
by the configuration, path, security and adapter modules still use English.
MCP tool descriptions and business responses are also still English in this
release. This is CLI localization, not complete runtime translation.

Native filesystem or network error details remain data from their original
source. Remote content, server names, identifiers, paths, protocol values,
JSON configuration keys and secrets are never translated. Stdio server mode
continues to reserve stdout for JSON-RPC and sends diagnostics to stderr.

The interactive wizard accepts `yes/y` and `oui/o`, and `no/n` and
`non`. French authentication choices accept `clé` or `cle` as well as
`key`; protocol values remain `ftp`, `ftps` and `sftp`.
The sensitive transport confirmation still requires the exact announced
word `insecure`. Saying `oui` does not grant that exception.

Setup writes `FTP_MCP_LANG` into generated MCP client entries, including
`en`, so the configured server keeps the setup language after restart.
Existing different client entries remain protected by the normal confirmation
or `--force` policy. The Trae snippet includes the same language setting.

## Translation API

`createI18n(locale)` creates an immutable context with `locale` and
`t(key, params)`. Callers pass this context explicitly; there is no mutable
global locale and no model-controlled tool argument for choosing a language.
Catalog keys are grouped by namespace in `src/locales/en.js` and
`src/locales/fr.js`. Tests require matching keys and named placeholders.
Parameter values are inserted once, without interpreting their contents.

An absent French message falls back to its English catalog entry. An unknown
key or missing parameter throws a developer diagnostic instead of inventing
a translation. The optional catalog argument to `createI18n` is copied and
frozen, allowing isolated tests of fallback without modifying global catalogs.
