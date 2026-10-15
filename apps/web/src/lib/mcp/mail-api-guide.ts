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
      body: { ok: true, messageId: "id-jmap-ou-rfc" },
    },
    deliveryTracking: {
      method: "GET", url: `${base}/api/v1/mail/messages?messageId=<id>&from=<adresse>`,
      auth: "Même clé mail:send ; accès limité aux envois de cette clé. Admin : organizationSlug requis.",
      identity: "messageId est propre à chaque boîte. Préciser from ; 409 en cas d’ambiguïté. La liste sans messageId fournit id et rfcMessageId uniques.",
      meaning: "200 à l’envoi confirme la soumission, pas la réception ni le classement hors spam. ACCEPTED = acceptation technique avec réponse 2xx, réception non confirmée ; UNKNOWN = résultat non confirmé. Aucun renvoi automatique après résultat incertain.",
      retention: "Métadonnées de suivi et rapports : 90 jours. Aucun corps ni pièce jointe conservé dans ce journal. Les Bcc restent privés.",
    },
    protections: {
      limits: "Par défaut : 20 messages/minute et 200 destinataires/24 h par organisation (toutes clés et pods confondus). Ajustables par l’administrateur après contrôle de réputation.",
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
      "400 invalid_attachments": "Fichier illisible ou limite totale dépassée ; detail indique le fichier et la cause, aucun email envoyé",
      "422 recipient_suppressed": "Adresse bloquée : aucun destinataire contacté.",
      "429 rate_limited": "Budget progressif de l’organisation atteint ; aucun envoi effectué.",
      "503 smtp_not_configured": "Aucune boîte Stalwart pour cet expéditeur — appeler ensure_mailbox",
      "502 send_failed": "Stalwart a refusé l'envoi (detail dans la réponse)",
    },
    examples: {
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
    "Pour le guide complet (mapping Resend, curl, fetch, erreurs) : appeler explain_mail_send_api.",
    "Provisionnement : add_domain prépare noreply → get_api_key → send_mail immédiatement. En parallèle : get_dns_records → publication SPF/DKIM/DMARC → verify_domain. Les MX restent inchangés pour un usage envoi uniquement.",
    "Jeton admin : passer organizationSlug (ou header X-Framm-Organization).",
  ].join(" ");
}
