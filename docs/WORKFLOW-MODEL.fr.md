# Modèle pur de workflow durable, v1

[English](./WORKFLOW-MODEL.md)

Cette bibliothèque interne couvre la première phase pure de la conception de déploiement durable. Elle n'active aucune configuration d'état, n'expose aucun outil MCP, ne se connecte à aucun serveur et ne crée aucun répertoire d'état. Les modules de workflow importent uniquement les modules de codec et de records de la bibliothèque de stockage existante. Aucun workflow de déploiement exécutable n'est livré par cette phase.

## Interfaces internes prises en charge

| Module | Interface | Résultat |
| --- | --- | --- |
| `src/workflow/model.mjs` | `encodePlan(plan, limits)` | Buffer canonique indépendant, avec le saut de ligne de la bibliothèque, après encodage borné et validation fermée. |
| `src/workflow/model.mjs` | `decodePlan(bytes, limits)` | Plan validé, détaché et profondément immuable ; les limites de taille et lexicales précèdent le parsing. |
| `src/workflow/model.mjs` | `policyFingerprint({server,target,requirePlan,stateLimits})` | SHA256 d'une projection explicite, versionnée et sans champs secrets. |
| `src/workflow/model.mjs` | `idempotencyKeyHash({domainId,key})` | SHA256 de l'objet canonique `{v:1,domainId,key}`. |
| `src/workflow/events.mjs` | `createWorkflowPolicy(plan, limits)` | Callbacks purs et synchrones `{validateEvent,reduce}` pour la bibliothèque de stockage. |
| `src/workflow/budget.mjs` | `reservationFor(plan, limits)` | Réservation immuable dans la forme exacte attendue par le stockage. |

Les autres exports sont des helpers privés partagés entre ces modules ou utilisés pour inspecter les preuves de réservation dans les tests. Ils ne constituent pas des contrats d'intégration supplémentaires.

`limits` est l'objet fermé `{stateLimits,maxTransferBytes,maxDeployBytes,maxDeployFiles}`. Les trois plafonds serveur sont des entiers sûrs strictement positifs obligatoires, avec des maxima actuels de 1 Tio, 1 Tio et 100000. `stateLimits` utilise la politique fermée effective de la bibliothèque de stockage. Le nombre de fichiers doit respecter les deux plafonds ; les sources et la première restauration complète des fichiers existants modifiés doivent respecter leurs plafonds de transfert de premier passage respectifs. Ces limites ne sont pas reconstruites à partir d'un hash de politique.

## Représentation du plan et de la politique

Les clés du plan sont exactement `{v,createdAt,expiresAt,serverAlias,target,policyHash,files}`. Celles de la cible sont exactement `{protocol,host,port,user,root,localRoot,canonicalRoot}`. Chaque fichier contient exactement `{index,localPath,remotePath,bytes,sha256,before,parent,desiredMode}`. Les indices sont consécutifs à partir de zéro et les fichiers sont triés par `remotePath` selon une comparaison binaire UTF-16 indépendante de la locale. Les chemins locaux et distants sont uniques, relatifs aux racines liées et normalisés avec des barres obliques. Un fichier distant planifié ne peut pas aussi être le parent d'un autre fichier planifié.

La racine distante configurée est une syntaxe POSIX absolue normalisée. La racine locale est une syntaxe native absolue canonique ; la couche pure ne peut pas observer l'identité du système de fichiers. Le parent canonique SFTP enregistré doit être contenu dans `canonicalRoot` et peut différer du parent lexical. Le parent FTP/FTPS doit être égal au parent lexical normalisé. Les chemins relatifs refusent les préfixes de lecteur ; les deux-points hors préfixe sont conservés dans les noms POSIX. L'interprétation réelle des chemins natifs, le confinement, l'identité des parents, l'observation des fichiers ordinaires et la revalidation des sources relèvent de l'intégration ultérieure.

Les cibles absentes FTP/FTPS sont refusées dans cette version. L'absence SFTP exige ensuite une preuve native de fichier inexistant sous un parent canonique existant. Les fichiers SFTP existants conservent leur mode ordinaire enregistré, les nouveaux fichiers SFTP utilisent explicitement le mode décimal 420 (0644), et le mode FTP/FTPS est null. Cette phase ne crée aucun répertoire.

Le fingerprint attend une entrée serveur normalisée. Il projette uniquement les identités/racines cibles, six plafonds d'exécution/parcours, six booléens de politique, les empreintes SHA256 canoniques triées et dédupliquées, `requirePlan` et les `stateLimits` effectives. Les mots de passe, passphrases, chemins de clés privées et autres champs serveur ne sont jamais parcourus ni hachés. Un accesseur secret n'est pas lu. La normalisation hôte/protocole correspond à `remoteLockKey` ; la casse de l'utilisateur reste significative. Une racine explicite mal formée est refusée, jamais remplacée silencieusement par un défaut.

L'encodage du fingerprint utilise des limites transitoires séparées : profondeur 8, 64 clés par objet, 1024 unités UTF-16 par chaîne, 1024 empreintes/entrées de tableau et 262144 octets complets. Tout dépassement échoue avec une étape sûre `PLAN_UNSUPPORTED`, sans troncature. Ainsi, `maxPlanFiles:1` n'empêche pas plusieurs empreintes. La clé d'idempotence brute contient 16 à 128 caractères ASCII imprimables et n'est ni renvoyée ni conservée par la fonction de hash.

`INIT.planDigest` lie le SHA256 du **payload** canonique renvoyé par `encodePlan`. Il diffère volontairement de `claim.planHash`, lié par le stockage à son conteneur scellé avec domaine et ID de plan. Ils ne doivent pas être comparés directement.

## Réducteur et preuves conservées

La racine réduite contient les champs fixes `{v,phase,planDigest,applyCharged,recoveryCharged,files}`. Chaque ligne contient `{state,backup,apply,recovery}`. Les deux espaces de tentatives ont les clés fixes `a1/a2/a3`, initialement null. Les slots utilisés contiennent `{phase,token,mode,staged,cleanup,proof}`. Le booléen `staged` conserve la preuve historique de staging durable, même pour un mode FTP null ou un slot abandonné. Aucun tableau de tentatives non borné n'est utilisé.

La validation du schéma est séparée de celle des transitions. Les événements sont fermés, versionnés et ne contiennent que les champs approuvés. Le replay est déterministe et ne modifie pas les entrées. Toutes les sauvegardes des fichiers existants modifiés doivent être prêtes avant tout staging apply. Les tentatives utilisent des slots consécutifs, tous leurs prédécesseurs doivent être terminaux, et chaque token reste unique dans l'opération entière même après nettoyage. Les charges de transfert apply/recovery sont indépendantes et définitives, y compris pour les tentatives abandonnées. La récupération commence à l'indice le plus élevé encore APPLIED.

`APPLIED` suit un enregistrement durable PROMOTING et représente un résultat acquitté fourni par l'intégration ultérieure. L'observation d'un contenu attendu après incertitude produit uniquement l'état permanent `SATISFIED_UNOWNED`, jamais une propriété autorisant le rollback. Le réducteur pur vérifie le contrat d'événement ; il ne peut pas lui-même attester un acquittement distant, une absence native ou la vérification d'une sauvegarde.

Le nettoyage exige une preuve historique de staging durable et ses propres intention/résultat. Les temporaires INTENT seulement et les slots de suppression ne peuvent pas être nettoyés. Le nettoyage empêche toute promotion/restauration ultérieure de ce staging. Une promotion acquittée n'a aucun avertissement de temporaire restant. `RESTORED` conserve `proof:'ack'|'observed'` ; une restauration observée conserve son avertissement de temporaire jusqu'à un résultat CLEANED indépendant. Une destination satisfaite mais non possédée rend toujours la terminaison assortie d'avertissements, même si son temporaire est nettoyé.

Tous les événements apply s'arrêtent à APPLY_COMPLETE ou ROLLBACK_START. Tous les événements recovery sauf START exigent ROLLING_BACK ; la terminaison arrête aussi le nettoyage. Les anciens temporaires apply ne peuvent pas être nettoyés après le début du rollback. Une phase non terminale n'affirme pas qu'un processus tourne actuellement. Un préflight conservateur dimensionne les six slots avant admission d'une politique/réservation, et chaque état réduit est à nouveau borné par `maxPlanBytes`. Les maxima des champs de dimensionnement ne sont pas nécessairement atteignables simultanément.

## Réservation finie

Avec `U` inchangés, `C` existants modifiés, `A` absents modifiés et `D=C+A`, les plafonds d'événements sont `2+U+2C+18D` pour apply et `2+18C+6A` pour recovery. Chaque catégorie est mesurée avec le vrai cadre canonique scellé `{v,seq,prev,budget,event,hash}` et son saut de ligne, aux largeurs maximales de séquence/indice. Les résultats mutuellement exclusifs utilisent le plus grand encodage complet, y compris la preuve RESTORED la plus longue. Les modes FTP null sont mesurés comme null.

Seuls les fichiers existants modifiés réservent des sauvegardes, y compris celles de zéro octet. Les métadonnées du claim sont résolues de manière monotone avec la vraie grammaire scellée jusqu'à `metadataBytes = 2 * encodedClaimBytes + 8192`. La borne finie d'itérations échoue fermée. L'admission minimale compte la réserve fixe du domaine de stockage, les deux slots réservés du plan, les deux classes de journal, les sauvegardes et les métadonnées. Le stockage réel doit aussi compter la capacité globale déjà occupée.

Le helper de cadre dérive son budget du scope de l'événement, sans paramètre de budget séparé. L'intégration ultérieure doit utiliser un wrapper privé d'append avec la même dérivation, ouvrir les journaux via les contrôles approuvés de tête/suffixe exacts et appeler `requireBudget` pour l'intention réelle et le résultat obligatoire avant chaque effet. Cette phase pure n'implémente pas ces étapes d'orchestration avec effets.

## Vérification et limites

Exécuter `npm run test:workflow` depuis la racine du dépôt source. Les 100 tests de `test/workflow/` sont également exécutés par `npm test`, utilisé par la CI. Les tests utilisent des records canoniques en mémoire et ne créent aucun état sur le système de fichiers. Ils couvrent toutes les catégories de transitions, les tentatives finies, la propriété, l'ordre des phases/nettoyages, les charges séparées, les schémas mal formés, l'exclusion des champs secrets, les maxima de politique/nombre de fichiers, les frontières de largeur numérique, les vraies métadonnées de claim et la saturation exacte/+1 des quotas.

Aucune garantie réseau, intégration SDK, verrouillage de processus, reprise après crash, transport chiffré, CI multiplateforme ou nettoyage distant n'est revendiquée ici. Ces étapes ultérieures et leur revue indépendante restent obligatoires avant l'activation du workflow dans le runtime. Les hashes ne détectent pas l'ABA, et l'égalité de contenu n'établit pas la propriété.
