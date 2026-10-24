# Contrat MD2 → KOD

Ce document ne modifie pas MD2. Le contrat machine est [OpenAPI](../../apps/web/src/lib/mail/openapi.json), également servi avec authentification par `GET https://kod.bzh/api/v1/mail/openapi`. Les exemples sont des démonstrations : les tests réels restent limités à igor@mages.pro.

## Instructions à transmettre à l’IA qui intègre MD2

Tu interviens uniquement dans MD2 pour consommer les mécanismes KOD existants. Avant toute implémentation, lire le contrat OpenAPI réellement servi et vérifier les droits de la clé serveur. Préserver les modèles de factures/relances, leurs véritables PDF, leurs destinataires métier et leur corps intégral. N’ajouter ni pixel, bouton, lien, texte de confirmation, copie cachée ou en-tête libre. Ne rejouer aucun envoi historique. Les essais réels éventuels sont uniquement pour igor@mages.pro, avec des PDF de démonstration sans données client.

Utiliser `https://kod.bzh` et une clé serveur possédant `mail:send` pour soumettre et suivre ses propres messages, plus `deliverability:read` pour la surveillance. Limiter `allowedMailDomains` à mail.d2-group.fr et, lorsque sa surveillance en lecture est autorisée, d2-group.fr. Ne pas employer le jeton administrateur de KOD dans MD2 et ne jamais exposer de secret au navigateur. Une clé de lecture différente ne récupère pas les événements individuels liés à une autre clé émettrice : utiliser la même clé avec les deux droits ou prévoir un rattachement explicite validé dans KOD.

Envoi : `POST /api/v1/mail/send`, expéditeur `compta@mail.d2-group.fr`. JSON : les PDF sont dans attachments[{filename,content,contentType}], content étant du Base64 canonique ; ce Base64 se trouve déjà dans le corps POST. Multipart : parties attachments binaires répétées, sans Base64 ; laisser le client HTTP générer son boundary. La limite KOD est 50 000 000 octets de fichiers cumulés, maximum 100 fichiers en multipart ; les serveurs destinataires peuvent avoir des limites inférieures. POST ne supprime aucune limite réseau, serveur ou destinataire. En cas de fichier invalide, aucun destinataire n’est contacté.

`requestReadReceipt` est facultatif et désactivé par défaut : booléen JSON, ou chaîne exacte true/false en multipart. Si demandé explicitement, KOD ajoute seulement Disposition-Notification-To vers la boîte From contrôlée. Ne fournir aucun en-tête arbitraire ni adresse MDN externe. Une demande n’oblige pas Outlook ou le destinataire à répondre. Afficher « Accusé de lecture reçu » seulement en présence d’un événement MDN, en conservant sa disposition, sa date de réception, sa provenance et sa fiabilité. Ne jamais en déduire lecture humaine, compréhension ou absence de spam. L’absence de réponse reste inconnue.

Avant la soumission, enregistrer durablement l’intention métier dans MD2 avec un identifiant interne. Après réponse, conserver trackingId, messageId (identifiant de soumission) et rfcMessageId. Un HTTP 200 signifie seulement soumission. En cas de panne ou de réponse incertaine après POST, ne jamais rappeler automatiquement POST : rechercher d’abord l’envoi dans KOD et soumettre une décision humaine si le résultat reste ambigu. Le contrat actuel n’offre pas de clé d’idempotence métier garantissant une nouvelle soumission ; ne pas en inventer.

Suivi : `GET /api/v1/mail/messages?messageId=<trackingId>`. Le suivi est par destinataire : RESERVED/SUBMITTED, QUEUED ou report temporaire, ACCEPTED avec preuve SMTP distante, FAILED, BOUNCED tardif, PARTIAL ou UNKNOWN. Conserver les événements plutôt qu’écraser l’historique. ACCEPTED ne prouve ni boîte principale ni lecture ; acceptedAt reste une preuve historique même si un rejet tardif arrive. Les DSN et certains MDN sont déclaratifs et portent leur fiabilité. Ne jamais prendre un message avec source=dsn comme justification suffisante pour bloquer automatiquement une adresse. Les champs readReceipt et telemetryEvents séparent la demande et les réponses MDN du transport SMTP.

Surveillance : appeler `/mail/deliverability`, `/mail/domains/mail.d2-group.fr/health`, `/reputation`, `/dmarc`, `/mail/connectors` et `/mail/alerts?status=open`. Les routes de surveillance demandent deliverability:read. Lire source, scope, période, observedAt, fetchedAt, dernière réussite, fraîcheur, disponibilité, motifs d’absence, volumes/dénominateurs et actions. Valeur null = inconnue, jamais zéro plainte, bonne réputation, aucun rejet ou email livré. Ne calculer aucun pourcentage si son dénominateur manque ou si le volume minimal n’est pas atteint. Les métriques Google portent sur Gmail personnel ; SNDS/JMRP sur Outlook.com, pas sur toutes les entreprises Microsoft 365. Les statistiques des IP partagées ne permettent aucune attribution à un client ou destinataire.

Créer un webhook avant les prochains envois avec la même clé : `POST /mail/webhooks` contient url et, pour les nouveaux événements, eventTypes. Le secret est retourné une seule fois et doit être stocké chiffré côté serveur MD2. Conserver les anciens événements email.accepted, email.failed, email.deferred et email.bounced ; ajouter email.complaint, email.mdn, deliverability.incident.opened et deliverability.incident.resolved. Les nouveaux événements sont facultatifs pour les anciens abonnements.

À réception : vérifier X-Kod-Timestamp à ±300 s, puis X-Kod-Signature en temps constant sur les octets HTTP bruts : `v1=` + hex(HMAC-SHA256(secret, timestamp + '.' + rawBody)). Vérifier aussi que X-Kod-Event-Id correspond à body.id après authentification. Ne jamais reconstruire le JSON pour calculer le HMAC. Enregistrer l’événement et son id unique durablement dans une transaction avant de répondre 2xx. Une notification déjà connue reçoit 2xx. Une panne de stockage reçoit 503. N’effectuer aucun envoi d’email depuis ce gestionnaire.

L’ordre n’est pas garanti et les reprises peuvent dupliquer une notification. Garder les événements append-only, appliquer leur date et leur source, conserver l’acceptation SMTP historique et le rejet tardif séparément, puis relire l’état courant par API si nécessaire. Une plainte anonymisée reste sans destinataire ; ne pas l’attribuer à l’unique client que MD2 pense avoir envoyé ce jour-là. Un incident de boîte non corrélable ne devient pas une plainte attribuée au domaine d’envoi.

Reprise : `GET /mail/events?since=<ISO>&until=<ISO>&limit=50`, suivre nextCursor avec la même période jusqu’au bout. Le tri est receivedAt (ordre d’ingestion), différent de occurredAt. Conserver un chevauchement temporel à la prochaine collecte et dédupliquer par id. Pour les preuves SMTP historiques, relire `/mail/messages` par trackingId. Les notifications expirent après 24 h de reprises ; les métadonnées sont conservées 90 jours. Aucun rattrapage ne doit resoumettre un email.

Suppressions : traiter explicitement HTTP 422 recipient_suppressed et les raisons renvoyées, informer l’opérateur, empêcher un flux de factures de s’arrêter silencieusement. Lire `/mail/suppressions` pour les destinataires To/Cc visibles de la clé. Le retrait d’une suppression exige une décision autorisée après correction, via api_keys:write dans KOD ; aucune levée automatique par MD2.

Ne modifier ni les DNS, ni les MX Microsoft 365, ni les inscriptions fournisseurs depuis MD2. Les connecteurs manquants/expirés doivent être présentés comme une action KOD à effectuer. Ne créer aucune bonne réputation fictive pour compléter un tableau vide.

## Exemple PHP multipart

```php
$http = curl_init('https://kod.bzh/api/v1/mail/send');
$fields = [
    'from' => 'compta@mail.d2-group.fr',
    'to' => 'igor@mages.pro', // démonstration uniquement
    'subject' => 'TEST KOD — document de démonstration',
    'text' => 'Document de démonstration joint.',
    'requestReadReceipt' => 'false', // true uniquement si explicitement demandé
    'attachments' => new CURLFile($demoPdfPath, 'application/pdf', 'demonstration.pdf'),
];
curl_setopt_array($http, [
    CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 120,
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('KOD_API_KEY')],
    CURLOPT_POSTFIELDS => $fields,
]);
$raw = curl_exec($http);
$status = curl_getinfo($http, CURLINFO_RESPONSE_CODE);
if ($raw === false) {
    // Résultat potentiellement incertain : conserver l’intention et enquêter, ne pas rejouer.
    throw new RuntimeException('Soumission KOD non confirmée ; vérification nécessaire.');
}
$result = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
// Persister les identifiants et le résultat métier avant tout traitement ultérieur.
// HTTP 422/429 = refus explicite ; HTTP 502/timeout = vérifier avant toute décision.
```

Pour plusieurs fichiers avec des parties attachments répétées, utiliser un client multipart capable de répéter le même nom (ex. Guzzle). Ne pas nommer attachments[0], attachments[1] sur le fil : seuls attachments et attachments[] sont reconnus.

## Exemples de réponses et notifications

Une réputation non mesurée conserve l’inconnu :
```json
{"provider":"google_postmaster","state":"authorization_required","coverage":"Gmail personnel uniquement","lastSuccessfulCollectionAt":null,"freshness":"unknown","reason":"configuration_or_authorization_missing","metrics":null}
```
Cet exemple est illustratif ; reason et state réels doivent être lus dans la réponse.

Abonnement aux nouveaux événements :
```json
{"url":"https://md2.example/webhooks/kod","eventTypes":["email.complaint","email.mdn","deliverability.incident.opened","deliverability.incident.resolved"]}
```

Exemple simulé de MDN reçu :
```json
{"id":"identifiant-durable","type":"email.mdn","occurredAt":"2026-10-24T10:00:00Z","receivedAt":"2026-10-24T10:00:01Z","source":"rfc8098","scope":"message","reliability":"unverified_report","data":{"domain":"mail.d2-group.fr","trackingId":"suivi","recipient":"igor@mages.pro","details":{"requestMade":true,"receiptReceived":true,"disposition":"displayed","label":"Accusé de lecture reçu","humanReadingProven":false}}}
```

Exemple simulé de plainte anonymisée corrélée seulement au message :
```json
{"id":"autre-identifiant-durable","type":"email.complaint","occurredAt":"2026-10-24T10:01:00Z","receivedAt":"2026-10-24T10:01:01Z","source":"microsoft_jmrp","scope":"message","reliability":"authenticated_provider_report","data":{"domain":"mail.d2-group.fr","trackingId":"suivi","recipient":null,"details":{"feedbackType":"abuse","recipientIdentified":false,"action":"Examiner la plainte ; aucun blocage automatique du flux de factures."}}}
```

Ces notifications sont des exemples de contrat, pas des plaintes ou MDN réellement collectés.

Exemple simulé d’ouverture d’incident :
```json
{"id":"incident-event-id","type":"deliverability.incident.opened","occurredAt":"2026-10-24T10:02:00Z","receivedAt":"2026-10-24T10:02:01Z","source":"kod_monitor","scope":"domain","reliability":"observed","data":{"domain":"mail.d2-group.fr","trackingId":null,"recipient":null,"details":{"incidentId":"incident-id","code":"collector:google_postmaster","status":"open","summary":"Collecte indisponible","action":"Renouveler l’autorisation et contrôler la dernière réussite.","evidence":{"lastSuccessAt":null}}}}
```
