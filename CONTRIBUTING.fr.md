# Contribuer à ftp-deploy-mcp

[English](./CONTRIBUTING.md) | **Français**

Merci d'envisager une contribution. Ce projet reste volontairement compact et
limite ses dépendances ; lisez les principes ci-dessous avant d'ouvrir une PR.

Le runtime MCP prend en charge Node.js >=22. L'outillage de publication exige **Node.js 24.20.0 exactement** : création et inspection des archives, inventaires source, contrôles du graphe installé, vérification du registre et `npm run test:release` refusent les autres versions avant ces opérations. Utilisez la distribution Node qualifiée, avec son npm fourni, et consignez les versions Node/libuv/npm/tar avec `node scripts/release-toolchain.mjs`. La qualification du consommateur peut toujours exécuter le serveur MCP avec Node 22 et appeler séparément les outils externes de publication avec Node 24.20.0.

La CI conserve les six jobs runtime (Node 22/24 sur Linux, macOS et Windows). La suite complète de publication s'exécute séparément sur les trois systèmes avec Node 24.20.0. macOS comporte trois passes complètes prédéfinies ; tout échec fait échouer le job. Ces passes de qualification sont fixes, sans relance après échec, cas ignoré ni augmentation des limites d'archive. Les workflows supply-chain et de publication npm/MCP utilisent la même version Node exacte.

## Environnement de développement

```bash
git clone https://github.com/alebgl77/ftp-deploy-mcp.git
cd ftp-deploy-mcp
npm ci --ignore-scripts
npm test
```

`npm test` est le principal contrôle du code. Il démarre de vrais serveurs FTP
et SFTP locaux sur des ports de boucle locale et exécute la suite de bout en
bout contre eux : aucun accès réseau externe n'est requis ni utilisé. Pour
les modifications de documentation seules, vérifiez aussi que les exemples
JSON modifiés s'analysent, que les liens Markdown relatifs existent, puis
exécutez `git diff --check`.

## Mettre à jour le graphe de dépendances

`package-lock.json` est l'unique fichier de verrouillage de référence ;
n'ajoutez pas de `npm-shrinkwrap.json` parallèle. Les six dépendances directes de
production sont épinglées à une version exacte. L'installation courante utilise
`npm ci --ignore-scripts` et ne doit pas réécrire le graphe.

Pour une mise à jour voulue, modifiez uniquement les versions exactes approuvées,
régénérez le verrouillage source avec les scripts de cycle de vie désactivés et la version
npm qualifiée, puis consignez cette version npm. Examinez toute entrée du graphe
ajoutée, supprimée ou modifiée, notamment `resolved`, `integrity`, les contraintes
facultatives/de plateforme et les hooks d'installation. N'acceptez pas de
modifications sans rapport issues d'une mise à jour ou d'une correction d'audit
automatique. Exécutez une installation propre, les tests concernés, l'audit des
dépendances et les contrôles de l'archive exacte et du consommateur isolé du
[guide de publication](./docs/RELEASE.fr.md). Présentez ensemble les modifications
des sources, du manifeste et du verrouillage source pour la revue.

La distribution d'installation source contient 82 fichiers, dont ce verrouillage. Le paquet npm distinct contient 81 fichiers sans verrouillage et reste non qualifié après dix dérives observées dans une installation réelle. Les contrôles du graphe installé comparent aussi les dépendances transitives et les peers à l'inventaire source original ; tout écart bloque la publication npm/MCP.

## Principes

- **JavaScript ESM simple.** Pas de TypeScript, d'outil de regroupement ni
  d'étape de compilation. Le contenu de `src/` est exécuté tel quel.
- **Aucune nouvelle dépendance d'exécution sans discussion.** Ouvrez d'abord
  une issue si vous en jugez une nécessaire : les `dependencies` de
  `package.json` sont volontairement limitées.
- **Chaque fonctionnalité s'accompagne d'assertions de test.** Les nouveaux
  outils, options ou comportements ne sont terminés qu'une fois couverts
  dans `test/smoke.test.js`.
- **Les garanties de sécurité reflètent les limites des protocoles.** Les
  sous-racines FTP/FTPS côté client ne sont pas présentées comme un confinement
  sûr contre les liens symboliques ; le compte/chroot dédié côté serveur est
  la frontière. Les protections SFTP doivent documenter la course résiduelle
  côté serveur.
- **Disponibilité des sources et disponibilité d'une publication sont
  distinctes.** N'annoncez pas l'installation par `npx` ou le registre MCP
  avant que l'artefact correspondant soit public et vérifié indépendamment.
- **En mode serveur, `stdout` est réservé à JSON-RPC.** N'utilisez jamais
  `console.log` dans le chemin d'exécution du serveur MCP : toute sortie
  standard est un message du protocole. Les diagnostics et les messages
  destinés aux humains vont sur `stderr` ou dans les commandes `doctor`/`setup`
  (hors mode serveur).

## Exécuter une partie de la suite

Exécutez la suite principale :

```bash
node test/smoke.test.js
```

Exécutez séparément la qualification des transports et les contrôles de publication :

```bash
node --test test/transport-qualification.js
npm run test:release
```

`npm test` exécute la suite principale et la qualification des transports.
Avant d'ouvrir une PR, lancez les deux ainsi que les contrôles de publication
concernés par le changement ; gardez les assertions existantes activées.

## Liste de contrôle d'une PR

- [ ] `npm test` passe (utilisez le total actuel ; ne le figez pas dans la documentation).
- [ ] Aucune nouvelle dépendance d'exécution, ou elle a d'abord été discutée dans une issue.
- [ ] Les comportements ajoutés ou modifiés ont des assertions de test correspondantes.
- [ ] `README.md` (anglais) et `README.fr.md` (français) sont mis à jour si le
      comportement visible par l'utilisateur a changé.
- [ ] Les nouveaux exemples de configuration sont en JSON strict et les liens
      Markdown relatifs pointent vers des cibles existantes.
- [ ] Les modifications sensibles pour la sécurité figurent dans
      [docs/SECURITY-MODEL.fr.md](./docs/SECURITY-MODEL.fr.md).

## Publication (mainteneurs)

N'improvisez pas la première publication à partir de cette courte section.
Suivez le [guide de publication](./docs/RELEASE.fr.md), qui couvre :

- la concordance des versions du paquet, du verrouillage source, du serveur et du tag,
  puis la vérification distincte des versions npm et du registre MCP officiel
  après publication ;
- la validation d'une archive propre et les tests de bout en bout ;
- npm Trusted Publishing, la provenance et le recours à un `NPM_TOKEN` de
  courte durée uniquement si l'amorçage de la première publication l'exige ;
- les opérations manuelles de propriété et de publication sur le registre MCP ;
- les vérifications après publication et le rétablissement par une nouvelle
  version corrective.

Le paquet npm et l'entrée du registre MCP ne sont disponibles qu'une fois
tous les prérequis manuels applicables et toutes les vérifications de ce
guide satisfaits.
