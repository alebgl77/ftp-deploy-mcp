# Limites du parcours local et de l’admission des appels

[English](./RESOURCE-BOUNDS.md)

## Sélection d’un déploiement

Chaque serveur configuré possède deux politiques facultatives, qui doivent être
des entiers positifs représentables sans perte. Les arguments des outils ne
peuvent modifier aucune de ces politiques.

| Champ | Défaut | Maximum |
| --- | ---: | ---: |
| `maxScanEntries` | 100000 entrées visitées | 1000000 |
| `maxScanDepth` | 64 niveaux de dossiers sous la racine | 256 |

La racine compte pour une entrée visitée, à la profondeur zéro. Chaque entrée
découverte compte une fois : dossiers, fichiers exclus et liens symboliques
compris. La descente ne compte pas le dossier une seconde fois. Atteindre
exactement une limite est accepté ; l’entrée suivante refuse toute la sélection
avec `SCAN_LIMIT`. La profondeur est inclusive : les fichiers d’un dossier au
niveau configuré restent éligibles, mais un sous-dossier non élagué est refusé
avant son ouverture. Un sous-arbre élagué ne nécessite aucune descente et ses
descendants non découverts ne sont pas comptés.

`maxDeployFiles` borne séparément les fichiers sélectionnés dès leur accumulation.
Les contrôles existants d’octets par fichier et par déploiement restent actifs.
Un échec de sélection précède toute connexion ou mutation distante, en simulation
comme en déploiement réel. `SCAN_LIMIT` renvoie `effects:none`, `retryable:false`
et `next_action:fix_input`.

Le parcours lit les dossiers séquentiellement avec `opendir` asynchrone, un tampon
de 32 entrées par handle et au plus `maxScanDepth + 1` handles ouverts. Il vérifie
l’annulation et le délai autour des lectures, puis rend la main à la boucle
événementielle toutes les 256 entrées découvertes. Toutes les fermetures sont
attendues, même après échec ou annulation. Un appel au système de fichiers ou une
fermeture lente peut encore dépasser le délai réel ; une réponse anticipée de
dépassement de délai ne signifie pas que le nettoyage est terminé.

Seules les exclusions intégrées prouvées des sous-arbres `node_modules`, `.git`
et `.ftp-mcp` permettent l’élagage. Les exclusions personnalisées et les motifs
d’inclusion ne l’autorisent jamais ; leurs règles existantes restent appliquées
à chaque fichier. Cela corrige un ancien test par sentinelle qui produisait des
faux positifs : `exclude:["**/__ftp_deploy_probe__"]` ne masque plus
`docs/wanted.txt`. Certains fichiers omis à tort peuvent désormais apparaître
dans la sélection. Examinez une simulation après avoir changé les exclusions.

Les liens symboliques rencontrés sont ignorés. Les contrôles lexicaux et
canoniques de `localRoot` et la nouvelle validation des sources à l’envoi restent
actifs. Ils ne suppriment pas les courses malveillantes sur les chemins causées
par un autre programme exécuté sous le même compte système.

## Admission des appels d’outil

Un isolate Node admet au plus 64 appels d’outil pour tous les registres partageant
le module d’admission. Il n’existe ni file d’admission supplémentaire ni reprise
automatique. Un outil inconnu conserve l’erreur de protocole `-32602` ; des
arguments invalides conservent `INVALID_ARGUMENT`. Une requête déjà annulée ne
lance aucune préparation ni aucun handler. L’admission suit la validation du
schéma et précède la préparation.

Le 65e appel renvoie `CAPACITY_LIMIT`, `effects:none`, `retryable:false` et
`next_action:retry`. Réessayez explicitement après la fin effective d’un appel
actif. Chaque appel conserve sa place pendant la préparation, l’exécution et le
nettoyage, y compris lorsqu’une entrée-sortie non coopérative se termine après
une annulation ou un dépassement de délai. Les verrous FIFO existants par cible
sont inchangés ; leurs appels en attente occupent aussi une place d’admission.
Les identifiants de corrélation, dont `0` numérique, `""`, `1` numérique et `"0"`
texte, restent distincts dans la garde du canal possédée par le point d’entrée.
Cette garde réserve chaque identifiant de requête entrant, toutes méthodes
confondues, avant sa remise au SDK et ferme la connexion sur tout doublon actif.

Ces limites ne coordonnent pas les processus, isolates ou hôtes distincts. Elles
ne bornent ni les tampons d’entrée du transport ni l’analyse des requêtes refusées.
Les limites du parcours local ne bornent pas le tampon distant sous-jacent de
`list()` ; la sortie MCP paginée conserve l’implémentation de liste existante.

## Bornes de l'état durable et du statut

`stateLimits` borne strictement les octets d'état, octets/fichiers de sauvegarde,
plans, opérations, fichiers/octets de plan et octets/événements de journal. La
publication d'un plan prouve toute sa réservation avant écriture. Apply et
rollback consultent le budget avant chaque intention durable et événement
terminal ; les flux s'exécutent hors du court verrou d'admission mais sous le
verrou persistant de l'alias exact.

`ftp_deploy_status` est sans écriture ni verrou : il rejoue un préfixe de journal
dont l'intégrité est vérifiée, puis confirme que plan, association, journal et
tête n'ont pas changé. Une concurrence renvoie `STATUS_CHANGED` ou
`DURABLE_STATE_BUSY`, jamais une page mélangée. Une page accepte au plus 100
lignes et s'arrête avant que le résultat structuré complet dépasse 18 Kio ;
`next_offset` vaut toujours `offset + count` lorsqu'une ligne reste.

Sauvegardes et journaux sont sensibles. Gardez `stateDir` privé et hors de toute
arborescence `localRoot`. Ne copiez pas un état v1 : il est refusé avant décodage
des plans et exige une réinitialisation hors ligne.

## Cycle de vie interne des outils préparés

Le registre expose une interface d’intégration interne ; les outils qui ne
l’activent pas utilisent toujours leur résolveur `timeoutFor` ordinaire.
L’interface elle-même n’active aucune reprise ni identifiant de requête
persistant et ne modifie ni les descripteurs ni les résultats des outils qui ne
l’utilisent pas.

Une inscription peut fournir les callbacks privés appariés `prepare(args,
operation)` et `disposePrepared(prepared, operation)`, tous deux obligatoirement
des fonctions. Le handler reçoit la valeur préparée en troisième argument. Une
préparation réussie transfère la propriété de sa ressource même si elle renvoie
`undefined` ; le registre attend exactement une libération après le handler ou
tout échec ultérieur. Une préparation qui rejette doit fermer chaque ressource
acquise avant son rejet : le registre ne peut pas libérer un contexte jamais
renvoyé. Le premier échec est conservé si la libération échoue aussi ; un échec
de libération après un handler réussi devient une erreur d’outil bornée ordinaire.

Préparation, traitement et libération s’exécutent dans le worker admis observé
par le transport. Une annulation ou un dépassement de délai peut produire une
réponse anticipée, mais le slot d’admission reste occupé jusqu’à la terminaison
réelle, préparation tardive et libération comprises. L’identifiant de requête du
canal reste réservé jusqu’au règlement ou à l’échec de l’envoi de la réponse
terminale et jusqu’à la terminaison réelle de tous les tours de handler enregistrés,
y compris tous les tours legacy d’entrée requise. Si l’annulation du client
supprime la réponse, l’identifiant reste réservé jusqu’à la fermeture de la
connexion. La libération s’exécute même après l’annulation et ne doit pas passer
par `operation.step`, dont le contrôle d’annulation empêcherait le nettoyage. Un
travail non coopératif peut donc retenir la capacité indéfiniment ; le délai
n’interrompt pas du JavaScript ou des entrées-sorties arbitraires.

L’option privée `preparedTimeoutMs` du registre vaut 120000 par défaut et accepte
un entier sûr positif jusqu’à 3600000. Les outils préparés ne consultent jamais
`timeoutFor`. Le futur assemblage fournit le plus grand délai serveur validé.
Après sélection du serveur, la préparation appelle
`operation.shortenTimeout(server.operationTimeoutMs)`, puis `operation.check()`
avant tout effet. Le raccourcissement part du début initial de l’opération, ne
prolonge jamais l’échéance courante et annule immédiatement une échéance déjà
dépassée. Une opération terminée ne peut pas créer un autre timer.

`operation.runPreparation(run)` est à usage unique, sans imbrication. Son plafond
fixe de 10000 ms commence avant l’appel du callback et reste borné par l’échéance
principale. Les contrôles avant et après le callback imposent aussi ce plafond
si la boucle événementielle n’a pas exécuté le timer. Son expiration annule
irréversiblement toute l’opération avec `TIMEOUT`. Une préparation réussie retire
seulement le plafond de l’étape et conserve l’échéance principale. Le callback
réel reste attendu après une réponse anticipée ; les timers sont supprimés à
l’annulation et à la terminaison réelle.
