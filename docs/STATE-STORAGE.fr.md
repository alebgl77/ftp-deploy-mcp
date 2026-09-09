# Primitives internes de stockage

[English](./STATE-STORAGE.md)

Cette bibliothèque interne sans dépendance fournit uniquement le stockage.
Elle n'est raccordée ni aux outils MCP, ni à la configuration, ni au déploiement,
ni au rollback ou à un serveur de production. L'application doit fournir un
schéma de plan fermé et un validateur/réducteur d'événements pur. Le stockage ne
décide jamais qu'un effet distant appartient à une opération. L'UUID de requête
reste distinct de l'identifiant d'opération persistante. Ces primitives ne
livrent aucun workflow de déploiement.

Exécuter les tests isolés depuis la racine du dépôt source :

```text
npm run test:state
```

Les tests écrivent sous `.tmp/state-tests/`, dans des fixtures sœurs vérifiées. Des
processus enfants s'arrêtent volontairement brutalement. Le harnais retire les
verrous abandonnés uniquement après leur sortie pour inspecter les preuves ;
cette aide de récupération hors ligne n'est pas exportée par la bibliothèque.

## Périmètre de qualification

La suite isolée contient 123 tests, dont 17 régressions de stockage. La
qualification locale couvre Windows/NTFS avec Node 22.23.2. Elle ne prouve ni
une intégration réseau, ni une qualification CI des OS/versions Node, ni une
version publiée.

## API

Imports depuis `src/state/index.mjs` :

```js
validateStateLimits(input = {})
openStateStore({ stateDir, localRoots, limits, signal, fault, create = true })
StateError // .code et .stage ; aucun détail/cause natif ni stack persistée
```

`stateDir` est un chemin absolu canonique explicite, disjoint dans les deux sens
de chaque `localRoot` canonique. Pour un chemin absent, l'ancêtre existant permet
de résoudre son identité projetée ; des répertoires frères sont autorisés.
Identité et confinement sont revérifiés aux ouvertures. Sans répertoire
fourni : STATE_DISABLED, sans création. Avec `create:false`, un répertoire
absent ou vide non initialisé provoque STATE_INVALID/domain_uninitialized,
sans mkdir, verrou ou écriture. Un domaine non vide sans marqueur est corrompu.
L'ouverture d'un domaine valide existant prend toujours le verrou d'admission.

Méthodes du store :

```js
store.metadata
store.withEndpointLock(endpointSha256, async () => result)
store.publishPlan(planId, validatedPlanBytes) // -> { planId, digest }
store.readPlan(planId) // -> Buffer indépendant de JSON canonique + newline
store.claim({ planId, keyHash, targetHash, reservation, initialEvent,
              validateEvent, reduce }) // -> enveloppe du claim vérifiée
store.lookupClaim({ planId }) // ou exactement { operationId } ; enveloppe ou null
store.openJournal(operationId, { validateEvent, reduce }) // -> writer
store.inventory() // compteurs bornés, actualBytes et reservedBytes
store.close() // attend le travail possédé et ferme les lecteurs de backups
```

Les identifiants sont des UUID v4 canoniques minuscules : UUID simple pour le
domaine, `pln_<uuid>` et `op_<uuid>`. Les empreintes SHA256 sont minuscules.
Plans et claims lient version, domaine, identité et digest des champs canoniques.
Le claim lie aussi le digest exact du plan, les hashes de clé/cible et la
réservation. Une association identique retourne le même claim ; une autre clé
pour un plan consommé, ou un autre plan pour la même clé, provoque un conflit.
Cela ne relance aucun travail applicatif.

```js
reservation = {
  applyJournalBytes, applyJournalEvents,
  recoveryJournalBytes, recoveryJournalEvents,
  backupBytes, backupFiles, metadataBytes,
  backups: [{ fileIndex, expectedBytes, expectedSha256, mode }]
}
```

`mode` vaut null ou un mode ordinaire entre 0 et 0777. Les indices sont uniques
et inférieurs à maxPlanFiles. La somme exacte des octets et du nombre de backups
doit tenir dans la capacité réservée. Un fichier vide réserve toujours son index
et son artefact. Les budgets apply et recovery ne se prêtent pas leur capacité.

`validateEvent(event)` doit retourner synchroniquement true, exactement.
`reduce(state,event)` retourne synchroniquement un état JSON borné, avec undefined
comme état initial. Ces fonctions sont appelées à la création, à l'append et au
replay. Entrées et état sont copiés ; une mutation de l'appelant ne réécrit pas
l'état validé. Les callbacks asynchrones sont refusés et leurs rejets tardifs
consommés. Le rejet des clés prototype et de certaines clés explicites de
secrets/diagnostics constitue une défense supplémentaire, **pas une détection
générale des secrets**. Les schémas fermés de l'intégration décident seuls des
métadonnées permises. Un objet Error/config natif n'est pas un enregistrement.

Méthodes du writer :

```js
writer.metadata // copies tip, budgets consommés, état réduit ; flag poisoned
writer.requireBudget({ bytes, events, budget: 'apply' | 'recovery' })
writer.append(event, { budget: 'apply' | 'recovery' })
writer.createBackup({ fileIndex, expectedBytes, expectedSha256, mode,
                      read: async sink => { /* respecter la backpressure */ } })
writer.openVerifiedBackup(index, { expectedBytes, expectedSha256, mode })
```

Le lecteur de backup expose ses métadonnées, `revalidate()`, la lecture à
position explicite `read(buffer,offset,length,position)` et `close()`, sans chemin
ni handle natif. Les lectures sont plafonnées à la longueur vérifiée, une seule
lecture peut être active, et close attend sa fin réelle. Le store ferme aussi
ses lecteurs. L'appelant revalide à l'utilisation. Le mode original reste une
métadonnée ; le blob privé reste en 0600 au lieu d'hériter des droits distants.

`createBackup` crée exclusivement l'index exact réservé avec wx, contrôle les
octets réellement transmis, SHA256 et longueur exacte, synchronise et ferme
avant acquittement. Il attend même un lecteur ignorant l'annulation et une
fermeture retardée. Le dépassement ou l'absence de backpressure provoque un
refus. Un blob incomplet reste explicite et ne peut être écrasé. Les événements
applicatifs d'intention et de disponibilité restent à la charge de l'appelant.
Le stockage ne les ajoute pas et ne promeut aucun fichier distant seul.

La borne d'octets est vérifiée dans `_write` avant l'I/O, y compris pour
`end(chunk)` et une réservation vide. La protection de la file reste séparée.
Détruire un Writable ne prouve pas la fin de son écriture asynchrone : celle-ci
est suivie explicitement et attendue avant fermeture du handle, libération de
l'index ou du verrou endpoint, et règlement de store.close. Un échec de stat
après ouverture attend aussi la fermeture du handle exact ouvert.

## Bornes et comptabilité

| Limite | Défaut | Maximum |
|---|---:|---:|
| maxStateBytes | 1073741824 | 17179869184 |
| maxBackupBytes | 536870912 | 8589934592 |
| maxPlans | 100 | 1000 |
| maxOperations | 100 | 1000 |
| maxPlanFiles | 1000 | 10000 |
| maxPlanBytes | 4194304 | 33554432 |
| maxJournalBytes | 16777216 | 268435456 |
| maxJournalEvents | 50000 | 500000 |
| maxBackupFiles | 10000 | 100000 |

Les limites sont des entiers positifs sûrs ; les clés inconnues et un
maxBackupBytes supérieur à maxStateBytes sont refusés. L'enveloppe complète
compte dans le plafond du fichier. Les lignes domain/head/event, newline comprise,
font au plus 4096 octets ; plans/claims utilisent maxPlanBytes. Profondeur ≤8,
chaînes ≤1024 unités UTF-16, tableaux ≤maxPlanFiles, objets ≤64 clés. Octets et
forme lexicale sont bornés avant JSON.parse. L'encodage dépense aussi son budget
pendant le parcours, sans construire d'arbre intermédiaire non borné. Doublons
de clés, JSON non canonique, clés dangereuses et UTF-8 invalide sont refusés.

La réservation logique conservée vaut :

```text
67 * 4096 octets fixes
+ 2 * maxPlanBytes par plan
+ applyJournalBytes + recoveryJournalBytes + backupBytes + metadataBytes par claim
```

La partie fixe couvre le marqueur et 66 verrous bornés. metadataBytes doit couvrir
au moins deux fois le claim encodé plus 8192 octets pour head et publication.
Journal et backups sont réservés séparément, sans double comptage. Les plans
réservent leur empreinte maximale finale/temporaire même s'ils sont plus petits.
L'inventaire compte aussi blobs vides et verrous ; les réservations prudentes
restent facturées. Plafond d'artefacts : 71 fixes +3 par plan +6 par opération +2
par backup réservé. Une forme inconnue est refusée avant une descente arbitraire.

maxStateBytes mesure des octets/réservations logiques, **pas les blocs alloués,
inodes ou l'espace disque libre**. Tous les maxima ne tiennent pas forcément
ensemble. Aucune purge, éviction de claim, récupération de quota ou suppression
automatique d'orphelin n'existe.

## Ordre, corruption et limites de plateforme

Layout fixe : domain.json, plans/, claims/, operations/, locks/. Un claim porte
le nom du plan ; l'opération contient journal.jsonl, head.json et backups/index.blob.
Les temporaires ont des noms imprévisibles générés par la bibliothèque. Aucun nom
de fichier ne provient d'un chemin modèle, d'un événement ou d'une clé brute.

Ordre des verrous : mutex processus externe → stripe endpoint → admission globale
courte. Exactement 64 stripes : huit premiers chiffres hexadécimaux du hash modulo
64, stripe-00.lock à stripe-63.lock. Des endpoints distincts peuvent entrer en
collision. Verrous wx à jeton borné, refus immédiat STATE_BUSY ; aucun waiter,
timer de retry, vol TTL/PID ou gestionnaire global de signaux. L'inventaire compte
un verrou endpoint pendant l'écriture bornée de son jeton ; seul son propriétaire
valide celui-ci avant retrait. L'admission sérialise mutations de métadonnées,
replay et inventaire. Flux de backup et callback endpoint restent hors admission.
La disparition d'un stripe endpoint reconnu entre listing et stat tolère
uniquement ENOENT pour ce stripe. L'admission, les références persistantes, les
noms inconnus et toute autre erreur de système de fichiers restent stricts.

La publication immuable utilise un temporaire frère synchronisé/fermé, un hard
link exclusif dans le même répertoire, le retrait de ce seul temporaire possédé,
puis sync du répertoire. Sans no-clobber compatible : refus. Le remplacement du
head utilise rename sans supprimer d'abord la destination. Le claim est publié
**en dernier**, après sync/close du journal initial et du head. Sa publication
fait autorité ; aucun callback du claim n'exécute d'effet externe.

La chaîne journal lie séquence, hash précédent, classe de budget et événement
validé. Le head contient longueur exacte, séquence et hash. Le replay vérifie
tout et compare exactement le head. Append vérifie petit tip et identité de
fichier, écrit sans O_CREAT, synchronise/ferme puis publie le head. Aucun replay
complet par événement. Writer périmé : STATE_BUSY/stale_writer. Après échec de
persistance, writer empoisonné ; une réouverture explicite doit valider toutes
les preuves. Suffixes retirés/ajoutés, ligne partielle, références manquantes,
versions inconnues et temporaires orphelins ne sont ni adoptés, ni réparés/reset.

L'annulation peut refuser l'admission mais ne libère jamais un verrou pendant
write/sync/close/callback. Appeler `close()` hors des callbacks possédés ; il
attend leur règlement. Un retrait de verrou refusé le laisse en place. Toute
récupération hors ligne exige l'arrêt des écrivains coopérants et une inspection
avec conservation des preuves. Aucune commande de récupération n'est fournie.

Plateforme exécutée : Windows, Node 22.23.2. Sonde réelle : ouverture du répertoire
réussie, fsync → EPERM/syscall fsync, fermeture réussie. FSTAT/isDirectory doit
d'abord prouver le type du handle ouvert. Seul le triplet **win32 + EPERM +
syscall fsync sur ce handle de répertoire prouvé** produit
`directorySync:false`, `directorySyncLimitation:'windows_eperm_fsync'`.
Les fichiers ordinaires sont refusés ; un échec de FSTAT attend la fermeture.
Un EPERM sur fichier, ouverture, fermeture, link, rename ou autre opération n'est jamais
supprimé. Les autres erreurs de sync répertoire sont propagées. Les créations
POSIX utilisent 0700/0600 et les contrôles de confidentialité ; ces gates existent
mais n'ont pas tourné sur cet hôte Windows. Windows exige des ACL opérateur.

Les métadonnées indiquent le support du crash processus et
`powerLoss:'not_guaranteed'`. Aucune garantie universelle de coupure électrique,
site atomique, déploiement transactionnel, propriété distante, coordination entre
hôtes ou résistance à un compte OS hostile. La restauration cohérente d'un ancien
domaine entier échappe aux digests ; un opérateur malveillant peut les recalculer.
Les courses du même compte et les comportements hard link/rename propres au FS
restent des limites. L'intégration doit encore tester son réducteur fermé, l'ordre
des effets, la propriété, l'expiration et le rollback.
