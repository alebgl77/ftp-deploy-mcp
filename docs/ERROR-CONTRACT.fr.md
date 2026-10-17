# Contrat d’erreur MCP

[English](./ERROR-CONTRACT.md)

Les dix outils legacy et leurs champs de succès restent stables. Lorsque
`stateDir` est activé, quatre outils durables supplémentaires sont publiés. Neuf outils legacy
publient un `oneOf` JSON Schema draft-07 avec deux possibilités strictes :
l’objet de succès existant et `{error}`. `ftp_read` conserve un succès texte
sans schéma de sortie ; ses erreurs utilisent néanmoins l’enveloppe validée
en interne. Les clients doivent lire `isError` et les champs stables ci-dessous
plutôt qu’analyser le texte traduit.

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "Erreur : READ_ONLY : …" }],
  "structuredContent": {
    "error": {
      "schema_version": 1,
      "code": "READ_ONLY",
      "message": "…",
      "retryable": false,
      "request_id": "46d0223a-de77-4f28-bf77-f8b9706a4ecb",
      "next_action": "fix_config",
      "effects": "none"
    }
  }
}
```

`request_id` est un nouvel UUID créé par le serveur pour un appel. Il est
distinct de l’identifiant de corrélation JSON-RPC et n’identifie pas une
opération durable. Les erreurs durables ajoutent `plan_id` et `operation_id`
facultatifs, une phase et des compteurs partiels durables. Ces identifiants
réfèrent uniquement au workflow journalisé et jamais à la corrélation JSON-RPC.

## Décisions stables et effets observés

Les valeurs acceptées pour `code` sont :

`CONFIG_REQUIRED`, `CONFIG_INVALID`, `SERVER_REQUIRED`, `SERVER_UNKNOWN`,
`INVALID_ARGUMENT`, `READ_ONLY`, `TRANSPORT_POLICY`, `HOST_KEY_REJECTED`,
`REMOTE_ROOT_REJECTED`, `PATH_REJECTED`, `NOT_FOUND`, `ALREADY_EXISTS`,
`TRANSFER_LIMIT`, `TRANSFER_VERIFY`, `TARGET_CHANGED`, `CANCELLED`, `TIMEOUT`,
`DEPLOY_PARTIAL`, `TRANSPORT_ERROR`, `OUTPUT_LIMIT`, `INTERNAL_ERROR`,
`SCAN_LIMIT`, `CAPACITY_LIMIT`.

Les outils durables utilisent aussi `DURABLE_STATE_DISABLED`,
`DURABLE_STATE_BUSY`, `DURABLE_STATE_LIMIT`, `DURABLE_STATE_CORRUPT`,
`DURABLE_STATE_IO`, `DURABLE_STATE_UNSUPPORTED`, `PLAN_NOT_FOUND`,
`PLAN_EXPIRED`, `PLAN_STALE`, `PLAN_CONSUMED`, `IDEMPOTENCY_CONFLICT`,
`CONFIRMATION_DECLINED`, `CONFIRMATION_INVALID`,
`CLIENT_INTERACTION_UNSUPPORTED`, `STATUS_CHANGED`,
`RECONCILIATION_REQUIRED`, `ROLLBACK_CONFLICT` et `WORKFLOW_UNSUPPORTED`.
L’état v1 est refusé avant décodage des plans et exige une réinitialisation hors ligne.

`SCAN_LIMIT` refuse toute la sélection locale avant connexion, avec `effects:none`
et `next_action:fix_input`. `CAPACITY_LIMIT` refuse l’admission avant préparation,
avec `effects:none` et `next_action:retry`. Les deux conservent `retryable:false` ;
voir les [limites de ressources](./RESOURCE-BOUNDS.fr.md).

Les valeurs legacy de `next_action` sont `fix_input`, `fix_config`,
`select_server`, `inspect_target`, `retry`, `contact_operator` et `none`.
Les erreurs durables peuvent aussi indiquer `status`, `resume_apply`,
`resume_rollback`, `offline_recovery` ou `upgrade_client`.
Les erreurs des outils historiques renvoient prudemment `retryable:false`. Les
erreurs durables ne renvoient `retryable:true` que pour
`DURABLE_STATE_BUSY`, `DURABLE_STATE_IO`, `STATUS_CHANGED` et les échecs
`TIMEOUT` ou `TRANSPORT_ERROR` projetés ; toutes les autres renvoient `false`.
Ce drapeau guide le client sans jamais autoriser une reprise automatique : il
faut suivre `next_action`, surtout après un effet `possible` ou `confirmed`.

| `effects` | Signification |
| --- | --- |
| `none` | Aucune opération mutatrice n’a été lancée par cet appel. |
| `possible` | Une mutation a été lancée, sans effet encore confirmé. |
| `confirmed` | Au moins un effet a été acquitté ; d’autres effets peuvent rester incertains. |

Les effets comprennent les temporaires, leur nettoyage et les écritures
locales des téléchargements. Une politique distante de lecture seule
n’interdit pas ces écritures locales. `confirmed` ne signifie pas que toute
l’opération a réussi ; zéro fichier terminé ne prouve pas l’absence de
modification. Un échec de fermeture après promotion conserve les effets confirmés.

Les erreurs d’envoi, de téléchargement et de déploiement peuvent inclure les
champs stricts `partial` : `completed_files`, `completed_bytes`, `failed_files`,
`total_files` facultatif et `final`. Ce sont des entiers sûrs non négatifs,
issus des promotions observées et des tentatives de fichier en échec, sans
analyse du texte. Les octets comptent les fichiers terminés, pas tout le
trafic réseau ni les temporaires partiellement écrits. `final: false` indique
un instantané anticipé pendant que le traitement sous-jacent se termine.
Cet instantané n’est pas révisé ultérieurement dans la réponse.

## Protocole, annulation et limites de sortie

Les arguments rejetés par le schéma d’entrée déclaré d’un outil connu donnent
`INVALID_ARGUMENT` avant son traitement, sa connexion ou une écriture locale.
Un refus métier ultérieur peut survenir après connexion. Un outil inconnu renvoie
une erreur de protocole JSON-RPC `-32602` bornée sans reprendre son nom.
Les trames mal formées conservent le traitement des erreurs de protocole du SDK.

L’annulation MCP du client interrompt l’opération et le SDK supprime sa réponse :
le client ne doit pas attendre une enveloppe `CANCELLED`. Les échéances internes
sont distinctes et peuvent renvoyer `TIMEOUT`. L’annulation native du SDK v2
traite chaque identifiant de requête valide, dont le nombre `0` et la chaîne vide
`""`. Une garde du canal, possédée par le point d’entrée, réserve chaque
identifiant de requête JSON-RPC entrant, toutes méthodes confondues, avant sa
remise au SDK. Tout doublon actif ferme la connexion avant l’exécution d’un
second handler, même si sa méthode diffère. L’identifiant d’un appel d’outil
n’est libéré qu’après le règlement ou l’échec de l’envoi de sa réponse terminale
et le règlement réel de tous les tours de handler enregistrés, de sa préparation
et de sa libération, y compris tous les tours legacy d’entrée requise.
Si l’annulation supprime la réponse, il reste réservé jusqu’à la fermeture de la
connexion. Des identifiants concurrents distincts, dont `0`, `""`, `1` et `"0"`,
restent indépendants. Une réponse dont l’envoi a déjà commencé ne peut pas être
rappelée. L’annulation n’efface pas les effets.

Les résultats d’outils connus sont masqués, bornés puis validés à une seule
frontière. La limite de 25 000 octets porte sur le `JSON.stringify` UTF-8 du
résultat complet, texte et données structurées compris, après expansion du
masquage. Les avertissements de sécurité ont un rôle de rendu interne distinct.
Des chaînes distantes telles que `Page:` ou `SECURITY WARNING` ne peuvent pas
acquérir ce rôle. La pagination est reconstruite après réduction des exemples.
Un repli `OUTPUT_LIMIT` conserve l’UUID, les effets et les compteurs observés.

Les décisions typées précèdent la traduction. Les détails natifs restent des
données de leur source sous un libellé traduit ; une réponse FTP ambiguë,
dont le code 550, ne devient pas `NOT_FOUND` d’après son texte. Les secrets
sont masqués dans le texte libre. Seules les constantes publiques propres au
schéma et l’UUID créé pour ce résultat sont préservés à leurs chemins
structurés exacts. Les objets Error, causes, piles, identifiants secrets et
arguments bruts ne sont pas sérialisés. Les secrets de configuration sont
collectés en privé avant validation, y compris ceux des entrées rejetées et
les valeurs ENV résolues. Les diagnostics publics du chargeur utilisent le
même masque. Un JSON mal formé reçoit un diagnostic générique sans extrait
du parseur ; aucune extraction fiable de secrets depuis ce contenu n’est
revendiquée. Les blocs FileZilla rejetés sont identifiés par leur index
numérique, sans reprise des noms ou champs de protocole non fiables.

Voir les [langues](./LANGUAGES.fr.md), le [modèle de sécurité](./SECURITY-MODEL.fr.md)
et les [transferts vérifiés](./TRANSFERS.fr.md) pour les autres limites.
