# Interactive architecture notebook

[Français](README.fr.md) | English

This single HTML guide documents the architecture, flows, evidence and roadmap of `ftp-deploy-mcp` in French and English. It works offline and makes no deployment calls.

## Build and open

From the repository root, using Node 22 or 24:

```sh
node scripts/build-guide.mjs
node scripts/build-guide.mjs --output ./enterprise-guide.html
```

Both commands rebuild `site/index.html`; the second also writes an identical copy to the requested path. Open the HTML directly in a browser (`file://`). No server, CDN or additional package is required. GitHub links require a connection when opened.

## Languages and interactions

Choose **Français** or **English** in the navigation. French is the default. `?lang=en` or `?lang=fr` selects the initial language; otherwise a saved preference is used when browser storage is available. Storage failures do not prevent use.

Switching language preserves the architecture view, selected component, zoom, scenario, current step, search and filters. Search matches the active language. SVG, PNG, JSON and CSV exports follow that language. Print styles produce a PDF in the active language. Original image prompts are preserved verbatim, including their quoted source-language labels.

## Sources and updates

- `project-data.json`: matching `locales.fr` and `locales.en` content, facts, source revision, evidence, work packages, scenarios, commits and image provenance. Update both locales together and keep historical results scoped to their original revision.
- `i18n.json`: matching interface strings, accessible labels and export labels. `static` keys identify French text in the shared template; values contain each translation. `dynamic` entries use named placeholders.
- `guide.template.html`: one shared layout, styles and renderer. Data is inserted through `textContent`, without rendering untrusted HTML.
- `assets/architecture-cible.png` and `assets/architecture-target.png`: French and English ChatGPT Image concept illustrations; both are embedded in the output.
- `assets/architecture-cible.prompt.txt` and `assets/architecture-target.prompt.txt`: exact original prompts, also copied into the data for offline provenance.
- `index.html`: generated output. Edit sources and rebuild; escaped JSON and base64 PNGs are embedded.
- `../scripts/build-guide.mjs`: deterministic assembly. Missing translations, inconsistent keys/array lengths, changed identifiers/statuses/numeric facts, unmatched placeholders, untranslated static labels and invalid image paths/signatures fail the build. Prose still requires bilingual editorial review.

Internal source links use the data's `head` commit; history entries keep their own revisions. API names, paths and identifiers are not translated. No real access configuration or secret is embedded. JSON export omits image base64 bytes but preserves provenance and localized status labels.

## Reading evidence

**Delivered** means the work package's criteria and evidence are documented. **In progress** denotes incomplete work; **Planned** describes a target addition. Progress counts delivered work packages without weighting their effort or promising a delivery date.

Scenarios are educational sequences, not executed tests. Target illustrations are not functional evidence. A passing CI does not by itself qualify autonomous production deployment or a multiuser service. Transfer guarantees depend on protocol/server capabilities, and process-local locks do not establish multiprocess exclusion.
