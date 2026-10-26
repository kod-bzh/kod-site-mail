function apiBaseUrl() {
  return (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "https://kod.bzh").replace(
    /\/$/,
    ""
  );
}

export function getMailSendApiGuide() {
  const base = apiBaseUrl();
  const endpoint = `${base}/api/v1/mail/send`;

  return {
    purpose:
      "Remplacer Resend, SendGrid, Mailgun, Postmark ou un SMTP applicatif par l'API Framm. L'envoi passe par Stalwart (notre serveur mail), pas par un prestataire transactionnel.",
    replace: {
      resend: "POST https://api.resend.com/emails",
      sendgrid: "POST https://api.sendgrid.com/v3/mail/send",
      mailgun: "POST https://api.mailgun.net/v3/{domain}/messages",
      nodemailer: "transport SMTP applicatif",
    },
    endpoint: {
      method: "POST",
      url: endpoint,
      headers: {
        Authorization: "Bearer framm_…",
        "Content-Type": "application/json",
      },
    },
    contentTypes: ["application/json", "multipart/form-data"],
    multipart: {
      description: "Même endpoint et même authentification. Envoyer les fichiers binaires directement, sans Base64, dans des parties attachments répétées (attachments[] également accepté).",
      fields: "from, subject, text et/ou html, replyTo : champs texte. to, cc, bcc : répéter le champ pour plusieurs adresses, ou fournir un tableau JSON dans ce champ.",
      files: "Chaque partie attachments porte le fichier, son filename et son Content-Type MIME. Ne pas fournir un chemin local ou une URL comme contenu.",
      limits: "50 000 000 octets cumulés de fichiers, maximum 100 fichiers en multipart. Les fichiers temporaires sont supprimés après traitement, y compris en cas d’erreur ou d’interruption.",
      headers: "Avec curl -F ou FormData, laisser le client générer Content-Type et le boundary : ne pas fixer manuellement Content-Type.",
    },
    auth: {
      header: "Authorization: Bearer <token>",
      token: "Clé organisation framm_… (scope mail:send) créée avec get_api_key, ou ADMIN_MAIL_TOKEN.",
      neverUse: "Ne pas utiliser une clé Resend (re_…). Framm n'accepte que framm_… ou le jeton admin.",
    },
    prerequisites: [
      "Domaine ajouté (add_domain) : noreply est préparé automatiquement. Lire sendingAllowed et notice.",
      "Envoi autorisé même avec DNS en attente. Publier SPF, DKIM et DMARC fournis, puis verify_domain pour réduire les refus et le spam ; ne pas changer les MX si la réception reste ailleurs.",
      "Boîte existante pour le From (ensure_mailbox, ex. noreply@domaine).",
      "Clé API stockée côté app (env FRAMM_API_KEY), jamais dans le front public.",
    ],
    body: {
      from: "string — adresse d'un domaine de l'organisation (ex. noreply@asso.fr ou Nom <noreply@asso.fr>)",
      to: "string ou string[] — 1 à 50 destinataires",
      subject: "string — obligatoire",
      text: "string — optionnel si html est fourni",
      html: "string — optionnel si text est fourni",
      replyTo: "string — optionnel",
      requestReadReceipt: "boolean facultatif, false par défaut ; multipart : chaîne exacte true ou false. Demande MDN RFC 8098 vers la boîte From contrôlée ; corps inchangé. L’absence de réponse reste inconnue ; un accusé ne prouve pas une lecture humaine.",
      cc: "string ou string[] — optionnel, 1 à 50 adresses, visibles dans Cc",
      bcc: "string ou string[] — optionnel, 1 à 50 adresses, uniquement dans l’enveloppe de livraison (aucun en-tête Bcc)",
      attachments: "{ filename, content, contentType? }[] — content en base64 canonique, filename non vide, contentType par défaut application/octet-stream ; total maximal 50 Mo (50 000 000 octets décodés). Tout fichier invalide annule l’envoi, avec son index et la cause dans detail.",
    },
    required: ["from", "to", "subject", "text ou html"],
    recipientPriority: "Déduplication insensible à la casse entre to, cc et bcc ; priorité to > cc > bcc. Les copies ne sont pas ajoutées à To.",
    mime: "Avec pièces jointes : multipart/mixed, corps texte/HTML en première partie (multipart/alternative si les deux sont fournis).",
    unsupportedComparedToResend: [
      "scheduled / batch",
      "templates Resend",
      "tags / headers arbitraires",
    ],
    resendMapping: {
      "resend.emails.send({ from, to, subject, html, text, reply_to, cc, bcc, attachments })":
        "POST /api/v1/mail/send { from, to, subject, html, text, replyTo, cc, bcc, attachments }",
      "Authorization: Bearer re_…": "Authorization: Bearer framm_…",
      "response.id": "response.messageId",
    },
    success: {
      status: 200,
      body: { ok: true, messageId: "id-de-soumission", trackingId: "id-de-suivi-unique", rfcMessageId: "message-id-rfc" },
    },
    deliveryTracking: {
      method: "GET", url: `${base}/api/v1/mail/messages?messageId=<id>&from=<adresse>`,
      auth: "Même clé mail:send ; accès limité aux envois de cette clé. Admin : organizationSlug requis.",
      identity: "Utiliser trackingId comme paramètre messageId pour un suivi sans ambiguïté. L’ancien messageId de soumission reste accepté avec from ; 409 en cas d’ambiguïté. rfcMessageId est également unique.",
      meaning: "200 à l’envoi confirme la soumission. ACCEPTED avec source=smtp = réponse SMTP finale 2xx du serveur distant, conservée par destinataire avec remoteMta, smtpReply, observedAt et evidenceId. Cela ne confirme ni boîte principale ni lecture. UNKNOWN = preuve indisponible, jamais un succès implicite. Aucun renvoi automatique après résultat incertain.",
      statuses: "RESERVED/SUBMITTED : préparation/soumission ; QUEUED : attente ou nouvel essai serveur ; ACCEPTED : accepté par le serveur distant ; DELIVERED : livraison technique signalée par le serveur, sans preuve de lecture ; FAILED : échec définitif ; BOUNCED : retour d’échec ultérieur ; PARTIAL : résultats différents selon les destinataires ; UNKNOWN : non confirmé.",
      evidence: "message.deliveryJson fournit le détail de chaque destinataire et message.events les preuves horodatées (jusqu’à 100). Un retour DSN structuré corrélé peut signaler BOUNCED après ACCEPTED ; acceptedAt conserve la date d’acceptation. Retours d’échec observés pendant 7 jours ; aucune garantie qu’un serveur externe fournisse un DSN.",
      retention: "Métadonnées de suivi et rapports : 90 jours. Aucun corps ni pièce jointe conservé dans ce journal. Les Bcc restent privés.",
    },
    webhooks: {
      url: `${base}/api/v1/mail/webhooks`,
      auth: "Même clé mail:send que celle utilisée pour envoyer. Les notifications sont limitées aux envois de cette clé. Admin : organizationSlug requis, envois admin uniquement.",
      create: 'POST {"url":"https://votre-application.fr/webhooks/kod"} → 201 {webhook:{id,url,createdAt}, signingSecret}. Créer avant l’envoi. HTTPS public, port 443 ; maximum 5 webhooks par clé.',
      manage: "GET : liste, sans secret, avec les 20 derniers essais de notification. DELETE ?id=<id> : supprime l’abonnement. Pour changer l’URL ou le secret, créer un nouvel abonnement puis supprimer l’ancien.",
      filterSemantics: "eventTypes facultatif : absent = quatre événements SMTP historiques ; liste explicite = uniquement les événements listés, y compris SMTP si souhaité.",
      events: ["email.accepted", "email.failed", "email.deferred", "email.bounced"],
      payload: "{id,type,occurredAt,data:{trackingId,submissionId,rfcMessageId,from,recipient,smtpReply,remoteMta}}. Un événement par destinataire. Aucun corps ni fichier joint dans la notification.",
      signature: "X-Kod-Event-Id, X-Kod-Timestamp (secondes Unix), X-Kod-Signature = v1=<hex HMAC-SHA256(signingSecret, timestamp + '.' + corps HTTP brut)>. Vérifier en temps constant avant JSON.parse et refuser un horodatage distant de plus de 5 minutes.",
      retries: "Répondre 2xx après enregistrement durable. Livraison au moins une fois : dédupliquer par id, gérer les événements arrivant dans le désordre. Jusqu’à 12 essais pendant 24 h, sans suivre de redirection. Aucun renvoi de l’email lors d’un nouvel essai de webhook. Après expiration, consulter GET /mail/messages.",
    },
    deliverability: {
      scope: "deliverability:read, à accorder explicitement ; allowedMailDomains limite les domaines de la clé. Les envois et leurs preuves restent liés à la clé émettrice.",
      openapi: `${base}/api/v1/mail/openapi`,
      routes: ["GET /api/v1/mail/deliverability", "GET /api/v1/mail/domains/{domain}/health", "GET /api/v1/mail/domains/{domain}/reputation", "GET /api/v1/mail/domains/{domain}/dmarc", "GET /api/v1/mail/alerts", "GET /api/v1/mail/connectors", "GET /api/v1/mail/events", "GET /api/v1/mail/suppressions"],
      absence: "Valeurs indisponibles null, avec raison, source, période, collecte, fraîcheur et référence. Google : Gmail personnel ; SNDS/JMRP : Outlook.com ; Yahoo : ARF, pas d’API Insights. Aucune attribution individuelle des statistiques ou plaintes anonymisées.",
      receipts: "GET /mail/messages ajoute readReceipt et telemetryEvents. requestMade est la demande de l’application ; submissionConfirmed confirme la soumission. receiptReceived=null tant qu’aucun MDN n’est observé. Un retour déclaré porte sa source et sa fiabilité, séparément de l’acceptation SMTP.",
      subscribe: 'POST /mail/webhooks {url,eventTypes:["email.accepted","email.failed","email.deferred","email.bounced","email.complaint","email.mdn","deliverability.incident.opened","deliverability.incident.resolved"]}, même clé avec deliverability:read. Une liste explicite filtre exactement ces événements. Sans eventTypes, les quatre événements SMTP historiques restent abonnés par défaut.',
      catchup: "GET /mail/events?since=<ISO>&until=<ISO>&limit=50, suivre nextCursor avec la même période. Tri par receivedAt, pas occurredAt. Reprendre avec chevauchement, dédupliquer par id et relire l’état courant après notification désordonnée. Maximum 90 jours.",
      safety: "Aucun bouton, pixel, lien ni corps ajouté. Aucune tâche de collecte ou de notification ne soumet un email. Les suppressions explicites restent visibles et bloquent avec une erreur, jamais silencieusement.",
    },
    protections: {
      queue: "Aucun quota bloquant de messages par minute ou de destinataires par jour à l’entrée de l’API. Après soumission unique, les messages attendent dans la file SMTP durable ; la cadence de livraison peut les différer sans nouveau POST. Les validations des destinataires, suppressions explicites et limites de pièces jointes restent actives.",
      suppressions: "Adresses inexistantes confirmées (5.1.1, 5.1.2, 5.1.3, 5.1.6) bloquées automatiquement. Refus anti-spam 5.7 et pannes temporaires exclus. Un destinataire bloqué annule l’envoi entier.",
      management: `POST ou DELETE ${base}/api/v1/mail/suppressions {address, reason?, organizationSlug?}, scope api_keys:write ou admin. reason : manual, hard_bounce, complaint, unsubscribe. Ajout/retrait journalisé. Ne retirer un blocage qu’après correction de sa cause.`,
      defaults: "Un domaine peut définir un nom d’expéditeur et une adresse de réponse surveillée ; les valeurs explicites du client restent prioritaires.",
      marketing: "Avant une campagne : consentement, désabonnement en un clic et traitement des plaintes requis ; les campagnes ne sont pas prises en charge automatiquement.",
    },
    errors: {
      "401 unauthorized": "Jeton manquant ou invalide",
      "403 forbidden": "Clé sans scope mail:send",
      "403 domain_not_in_org": "Le From n'appartient pas à l'organisation de la clé",
      "403 domain_not_verified": "Domaine non utilisable (le DNS en attente ne bloque pas l’envoi)",
      "400 invalid_body | invalid_from | invalid_to | missing_content": "Payload incomplet ou invalide",
      "400 invalid_attachments": "Fichier illisible ou invalide (JSON : également limite totale dépassée) ; detail indique le fichier et la cause, aucun email envoyé",
      "413 payload_too_large": "Multipart : fichiers cumulés au-delà de 50 Mo, plus de 100 fichiers ou formulaire trop volumineux. Aucun email envoyé.",
      "503 upload_unavailable": "Réception temporaire des fichiers indisponible ; aucun email envoyé.",
      "422 recipient_suppressed": "Adresse bloquée : aucun destinataire contacté.",
      "503 smtp_not_configured": "Aucune boîte Stalwart pour cet expéditeur — appeler ensure_mailbox",
      "502 send_failed": "Résultat potentiellement incertain ; consulter le suivi avant toute décision, jamais de renvoi automatique.",
    },
    examples: {
      curlMultipart: [
        `curl --fail-with-body -X POST '${endpoint}' \\`,
        '  -H "Authorization: Bearer $FRAMM_API_KEY" \\',
        "  --form-string 'from=noreply@asso.fr' \\",
        "  --form-string 'to=client@example.com' \\",
        "  --form-string 'subject=Documents' \\",
        "  --form-string 'text=Veuillez trouver les fichiers joints.' \\",
        "  -F 'attachments=@document.pdf;type=application/pdf' \\",
        "  -F 'attachments=@photo.jpg;type=image/jpeg'",
      ].join("\n"),
      curlPdf: "jq -n --rawfile pdf <(base64 < document.pdf) '{from:\"noreply@asso.fr\",to:\"client@example.com\",cc:\"copie@example.com\",subject:\"Document\",text:\"Voir le PDF joint.\",attachments:[{filename:\"document.pdf\",content:($pdf | gsub(\"\\\\s\";\"\")),contentType:\"application/pdf\"}]}' > /tmp/framm-mail.json\ncurl -X POST ENDPOINT -H \"Authorization: Bearer $FRAMM_API_KEY\" -H 'Content-Type: application/json' --data-binary @/tmp/framm-mail.json".replace("ENDPOINT", endpoint),
      curl: [
        "curl -X POST '" + endpoint + "' \\",
        "  -H 'Authorization: Bearer '\"$FRAMM_API_KEY\" \\",
        "  -H 'Content-Type: application/json' \\",
        "  -d '{\"from\":\"noreply@asso.fr\",\"to\":\"client@example.com\",\"subject\":\"Bienvenue\",\"text\":\"Bonjour\",\"html\":\"<p>Bonjour</p>\"}'",
      ].join("\n"),
      fetch: [
        "const res = await fetch('" + endpoint + "', {",
        "  method: 'POST',",
        "  headers: {",
        "    Authorization: `Bearer ${process.env.FRAMM_API_KEY}`,",
        "    'Content-Type': 'application/json',",
        "  },",
        "  body: JSON.stringify({",
        "    from: 'noreply@asso.fr',",
        "    to: 'client@example.com',",
        "    subject: 'Bienvenue',",
        "    text: 'Bonjour',",
        "    html: '<p>Bonjour</p>',",
        "    replyTo: 'contact@asso.fr',",
        "  }),",
        "});",
        "const data = await res.json(); // { ok: true, messageId }",
      ].join("\n"),
      resendDropIn: [
        "// Avant (Resend)",
        "await resend.emails.send({ from, to, subject, html });",
        "",
        "// Après (Framm) — même intention, autre URL et autre clé",
        "async function sendEmail({ from, to, subject, html, text, replyTo, cc, bcc, attachments }) {",
        "  const res = await fetch(process.env.FRAMM_MAIL_URL, {",
        "    method: 'POST',",
        "    headers: {",
        "      Authorization: `Bearer ${process.env.FRAMM_API_KEY}`,",
        "      'Content-Type': 'application/json',",
        "    },",
        "    body: JSON.stringify({ from, to, subject, html, text, replyTo, cc, bcc, attachments }),",
        "  });",
        "  if (!res.ok) throw new Error(await res.text());",
        "  return res.json();",
        "}",
      ].join("\n"),
    },
    env: {
      FRAMM_MAIL_URL: endpoint,
      FRAMM_API_KEY: "framm_… (sortie de get_api_key, à stocker en secret serveur)",
    },
    nextSteps: [
      "Si le domaine n'existe pas : add_domain prépare noreply. Lire sendingAllowed ; get_api_key permet ensuite d’envoyer. Publier get_dns_records puis verify_domain pour améliorer la délivrabilité.",
      "Dans le code métier, remplacer le SDK Resend par le fetch ci-dessus. Ne plus appeler smtp.resend.com.",
    ],
  };
}

export function getMailSendApiInstructions(): string {
  const guide = getMailSendApiGuide();
  return [
    "Framm remplace Resend/SendGrid/Mailgun pour l'envoi d'emails transactionnels.",
    `API : POST ${guide.endpoint.url}`,
    "MCP (Cursor, Claude) : OAuth 2.1 PKCE + enregistrement dynamique, URL https://…/api/mcp — pas de clé à coller.",
    "API applicative : Authorization: Bearer framm_… (scope mail:send) ou ADMIN_MAIL_TOKEN.",
    'JSON : { "from", "to", "subject", "text"?, "html"?, "replyTo"?, "cc"?, "bcc"?, "attachments"? }. Au moins text ou html.',
    "Succès : { ok: true, messageId }. From = adresse d'un domaine ajouté + boîte Stalwart ; DNS non bloquant.",
    "cc et bcc : string ou string[], priorité to > cc > bcc, Bcc invisible. attachments : [{ filename, content (base64), contentType? }], maximum 50 Mo décodés ; erreur explicite par fichier. Pas de templates Resend.",
    "Alternative HTTP sans Base64 : multipart/form-data sur le même endpoint ; champs texte from, to, subject, text/html, replyTo, cc, bcc et parties fichiers attachments répétées. Pour plusieurs adresses, répéter to/cc/bcc ou utiliser un tableau JSON. Maximum 50 Mo cumulés et 100 fichiers. Laisser curl/FormData générer le boundary. Si l’outil MCP ne propose pas ce transport, utiliser l’API HTTP.",
    "Après envoi : conserver trackingId et lire GET /api/v1/mail/messages?messageId=<trackingId>. ACCEPTED avec preuve SMTP = accepté par le serveur distant, pas preuve de boîte principale ou lecture. UNKNOWN n’est jamais un succès. Notifications signées : POST /api/v1/mail/webhooks avec la même clé et une URL HTTPS publique ; lire le guide pour vérifier HMAC, horodatage et doublons.",
    "Surveillance : scope dédié deliverability:read, routes deliverability/connectors/alerts et domains/{domain}/health,reputation,dmarc. requestReadReceipt facultatif false par défaut, booléen JSON ou chaîne true/false en multipart ; MDN sans changement de corps. Absence de réponse inconnue. Lire le contrat /api/v1/mail/openapi et le guide pour les événements plainte/MDN/incident et leur rattrapage.",
    "Pour le guide complet (mapping Resend, curl, fetch, erreurs) : appeler explain_mail_send_api.",
    "Provisionnement : add_domain prépare noreply → get_api_key → send_mail immédiatement. En parallèle : get_dns_records → publication SPF/DKIM/DMARC → verify_domain. Les MX restent inchangés pour un usage envoi uniquement.",
    "Jeton admin : passer organizationSlug (ou header X-Framm-Organization).",
  ].join(" ");
}
