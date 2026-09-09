# Langues de la CLI et des outils MCP

[English](./LANGUAGES.md)

La ligne de commande utilise l’anglais par défaut. Pour choisir le français :

```sh
node src/index.js --lang fr --help
node src/index.js setup --lang fr
node src/index.js doctor --lang fr
node src/index.js import-filezilla --lang fr --file ./sitemanager.xml --out ./servers.json
```

`FTP_MCP_LANG=fr` sélectionne la même langue via l’environnement.
`--lang en` ou `--lang fr` prime sur l’environnement, même si sa valeur
est invalide. L’option est extraite avant l’analyse de la sous-commande et
peut figurer avant ou après celle-ci. `--lang=fr` fonctionne également.
Seules les valeurs exactes `en` et `fr` sont acceptées ; une option
invalide ou incomplète provoque un échec avant toute écriture d’installation
ou d’import. Les paramètres régionaux du système, comme `LANG`, sont ignorés.

## Périmètre actuel

Les éléments traduits comprennent les aides générale et par sous-commande,
les questions et choix de l’installation, les libellés et conseils des tests
de connexion, les diagnostics doctor, les avertissements d’import FileZilla
et les messages de démarrage ou d’erreur fatale, les titres et descriptions
MCP et les descriptions des paramètres. Les messages propres au projet pour
la configuration, les chemins, la sécurité, les transports et transferts,
les succès métier et les enveloppes d’erreur utilisent la langue choisie.
Les codes publics et clés des résultats restent stables ; voir le
[contrat d’erreur](./ERROR-CONTRACT.fr.md).

Les détails natifs d’erreurs système ou réseau restent des données provenant
de leur source. Le contenu distant, les noms de serveurs, identifiants,
chemins, valeurs de protocole, clés JSON et secrets ne sont jamais traduits.
Le mode serveur stdio continue de réserver stdout à JSON-RPC et d’envoyer
ses diagnostics sur stderr.

L’assistant interactif accepte `yes/y` et `oui/o`, ainsi que `no/n`
et `non`. Le choix d’authentification en français accepte `clé` ou
`cle`, en plus de `key` ; les protocoles restent `ftp`, `ftps`
et `sftp`. La confirmation sensible du transport exige toujours le mot
exact annoncé `insecure`. Répondre `oui` n’accorde pas cette dérogation.

L’installation inscrit `FTP_MCP_LANG` dans les entrées des clients MCP,
y compris `en`, afin que le serveur conserve la langue choisie après
redémarrage. Une entrée client différente reste protégée par la confirmation
habituelle ou par l’option `--force`. Le bloc Trae inclut le même réglage.

## API de traduction

`createI18n(locale)` crée un contexte immuable contenant `locale` et
`t(key, params)`. Les appelants transmettent ce contexte explicitement :
aucune langue globale mutable ni argument d’outil contrôlé par le modèle.
Les clés sont organisées par espace de noms dans les fichiers appariés
`en.js`, `runtime.en.js` et `errors.en.js` sous `src/locales`, avec leurs
équivalents français. Les tests exigent les mêmes clés et paramètres nommés.
Les erreurs typées portent un descripteur privé, rendu dans la langue choisie
uniquement à la frontière de sortie.
Les valeurs des paramètres sont insérées une seule fois, sans interprétation
de leur contenu.

Un message français absent utilise son entrée anglaise. Une clé inconnue ou
un paramètre manquant provoque un diagnostic développeur au lieu d’inventer
une traduction. L’argument facultatif de catalogue de `createI18n` est
copié puis figé, ce qui permet de tester le repli de façon isolée sans modifier
les catalogues globaux.
