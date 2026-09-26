# Performances et intégration des agents

[English](./AGENT-PERFORMANCE.md)

Les optimisations réduisent les calculs locaux répétés dans le serveur MCP.
Elles s'appliquent à tout client utilisant ses outils stdio, quel que soit le
fournisseur du modèle. L'architecture, les noms des outils, les arguments, les
schémas de réponse, la vérification des transferts, l'annulation et les limites
d'admission sont conservés.

- L'adaptateur FTP/SFTP sélectionné est chargé au premier usage. Le coût de
  l'import est reporté à la première connexion ; les suivants utilisent le
  cache de modules de Node.
- Chaque redactor garde en cache les secrets littéraux triés et les motifs
  compilés des secrets courts, puis les reconstruit à l'ajout d'un nouveau
  secret distinct. La mémoire supplémentaire croît avec le nombre de secrets ;
  l'ordre des remplacements et le comportement normal/strict sont préservés.
- Un comptage incrémental exact des octets JSON évite de sérialiser à répétition
  les échantillons qui grandissent. La troncature du texte évite aussi une
  sérialisation complète en double. Le contenu et les plafonds des réponses
  sont préservés.

## Connecter un agent

Installez les sources comme indiqué dans le [README](../README.fr.md). Utilisez
Node.js 22 ou plus récent et des chemins absolus explicites. Cette définition
générique utilise le checkout comme répertoire de travail du processus et
sélectionne directement la configuration des serveurs :

```json
{
  "command": "node",
  "args": [
    "/chemin/absolu/vers/ftp-deploy-mcp/src/index.js",
    "--config",
    "/chemin/absolu/vers/ftp-servers.json"
  ],
  "cwd": "/chemin/absolu/vers/ftp-deploy-mcp"
}
```

Adaptez la configuration englobante au client. S'il n'accepte pas `cwd`, fixez
explicitement le répertoire de travail du lanceur ; conservez les deux chemins
absolus dans les arguments. `localRoot`, dans la configuration des serveurs,
détermine l'arborescence locale autorisée. `FTP_MCP_CONFIG` est une alternative
à `--config`, qui reste prioritaire. Voir la
[configuration](../README.fr.md#configuration-des-serveurs).

| Client agent | Mode d'intégration |
| --- | --- |
| Claude Code / Claude Desktop | Ajoutez la commande et les arguments sous `mcpServers` ; voir la [configuration du client](../README.fr.md#configuration-du-client). |
| OpenAI Agents SDK pour JavaScript | Créez `MCPServerStdio` avec les options de lancement, connectez-le et ajoutez-le aux `mcpServers` de l'agent. Fermez-le à la fin. Voir le [guide MCP du SDK](https://openai.github.io/openai-agents-js/guides/mcp/). |
| Gemini CLI | Ajoutez les options de lancement sous `mcpServers` dans `settings.json` ; voir le [guide MCP de Gemini CLI](https://geminicli.com/docs/tools/mcp-server/). |
| Qwen-Agent | Fournissez une configuration d'outil contenant `mcpServers` avec la commande et les arguments ; voir l'[exemple MCP de Qwen-Agent](https://github.com/QwenLM/Qwen-Agent#how-to-use-mcp). |

Ces modes décrivent la compatibilité stdio ; ils ne constituent pas des
résultats de tests de bout en bout propres à chaque fournisseur. Une
intégration MCP distante hébergée nécessite un serveur MCP HTTP accessible ou
un pont distinct. Ce dépôt expose stdio et n'ajoute ni serveur HTTP ni pont.

Pour un catalogue stable, OpenAI Agents SDK accepte l'option
`cacheToolsList: true` dans `MCPServerStdio`. Elle évite de répéter la découverte
des outils côté client. Invalidez ce cache avec `invalidateToolsCache()` si le
catalogue change ; voir les [conseils de cache du SDK](https://openai.github.io/openai-agents-js/guides/mcp/#other-things-to-know).

## Cibler les appels

- Appelez `ftp_list` avec un `limit` adapté (50 par défaut, 200 au maximum).
  Suivez le `next_offset` renvoyé seulement si d'autres entrées sont utiles.
  La pagination borne la réponse MCP ; l'adaptateur récupère toujours la liste
  du dossier distant.
- Appelez `ftp_read` avec un `max_bytes` explicite, par exemple 8192 pour un
  petit fichier de configuration. Le défaut est de 256 Kio et le plafond de 1 Mio.
- Attendez chaque mutation dont dépend la suivante. Terminez par exemple un
  envoi avant de renommer sa destination. Les lectures indépendantes peuvent
  se chevaucher ; les verrous FIFO et les [limites d'admission](./RESOURCE-BOUNDS.fr.md)
  restent actifs.
- Examinez un appel `ftp_deploy` avec `dry_run: true` avant le déploiement réel.
  Cette simulation n'effectue aucune entrée-sortie réseau et ne vérifie pas
  la cible distante.

Des réponses bornées et pertinentes, ainsi que la mesure du nombre d'appels,
du temps d'exécution et des erreurs suivent les
[conseils de conception d'outils d'Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents).

## Reproduire les contrôles

Depuis un checkout complet avec les dépendances de développement :

```bash
npm ci --ignore-scripts
npm run test:performance
npm test
npm run test:eval-runner
npm run eval:scripted
```

`test:performance` exécute `test/redaction-performance.test.mjs` et
`test/agent-performance.test.mjs` ; ces régressions font aussi partie de
`npm test`.

Le benchmark d'exécution exige un checkout intact comme premier argument.
Créez et installez cette référence une fois, ou utilisez un checkout existant
du même commit :

```bash
git worktree add --detach ../ftp-deploy-mcp-baseline a068aa5c3b1e53caaffc2c7907966ff5a2e9cb0f
npm --prefix ../ftp-deploy-mcp-baseline ci --ignore-scripts
npm run benchmark:agents -- ../ftp-deploy-mcp-baseline 200
```

Le dernier argument optionnel est le nombre positif d'itérations (200 par
défaut). `benchmark:agents` exécute `scripts/benchmark-agent-performance.mjs`
avec des fixtures locales, vérifie l'équivalence des sorties et rapporte le
travail de sérialisation et la durée. Sa mesure de découverte couvre l'import
des modules, l'enregistrement et la liste des outils, sans le handshake stdio
complet. Consignez le commit, la version de Node.js, le système d'exploitation
et la charge avec les mesures ; répétez les comparaisons sur la même machine.
Sur les premières versions de Node.js 22 sans instrumentation des imports,
les contrôles utilisant ces hooks sont ignorés et les nombres de modules sont
indisponibles ; les mesures de durée du benchmark restent exécutées.

Le microbenchmark de masquage est optionnel et compare des sorties de fixtures
identiques à celles de l'implémentation précédente. Il affiche des médianes
indicatives sans assertion sur la durée. Dans un shell POSIX :

```bash
REDACTION_BENCHMARK=1 node --test test/redaction-performance.test.mjs
```

Dans PowerShell :

```powershell
$env:REDACTION_BENCHMARK = '1'
node --test test/redaction-performance.test.mjs
Remove-Item Env:REDACTION_BENCHMARK
```

Les tests et benchmarks mesurent le comportement de l'implémentation et son
exécution locale. Les [évaluations scriptées](./SCRIPTED-EVALUATIONS.fr.md)
exercent les handlers MCP sans modèle. Ils ne démontrent ni qualité du modèle,
ni économie de tokens, ni latence d'un fournisseur, ni débit FTP/SFTP en
production. Les [instructions d'évaluation d'agents](../evaluations/README.fr.md)
couvrent séparément les essais avec un modèle.
