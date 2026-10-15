# Framm

Dépôt regroupant l'ensemble de l'infrastructure de l'association Kod Digor, gérée sous forme de code afin d'en garantir la traçabilité, la reproductibilité et la transparence.

Plateforme multi-associations : site web, messagerie Stalwart, gestion de domaines et boîtes mail.

## Architecture

Architecture cible (migration Kapsule en cours, voir plus bas) :

- **Kubernetes Kapsule** : app web Next.js + worker, déployés en GitOps par **ArgoCD** ; autoscaling des pods (HPA 2→6) et des nœuds (pool DEV1-M 2→4, autohealing) ; Traefik + cert-manager (Let's Encrypt) ; monitoring kube-prometheus-stack
- **PostgreSQL managée** (DB-DEV-S) : sauvegardes automatiques quotidiennes, rétention 30 j, copie hors région, accès réseau privé uniquement
- **1 VM Mail** (DEV1-M) : Stalwart — un serveur mail reste volontairement hors cluster (réputation IP stable)
- **Registre d'images** Scaleway (`rg.fr-par.scw.cloud/framm-kod-digor`)
- **S3** : uploads, backups, archives froides, tfstate
- **Domaines plateforme** : `kod.bzh`, `app.bzh` (activable plus tard)

Pendant la transition, la VM App existante continue de servir la prod : la bascule DNS est pilotée par `TF_VAR_k8s_lb_ip` (voir runbook).

## Prérequis

- Terraform >= 1.5
- Compte Scaleway avec clés API
- Domaine `kod.bzh` acheté chez Scaleway (zone DNS auto-créée)
- Une clé SSH publique (`~/.ssh/id_ed25519.pub` ou `~/.ssh/id_rsa.pub`)

## Déploiement en une commande

```bash
cp .env.example .env
# Renseigner les variables ci-dessous
bin/framm bootstrap
```

Le bootstrap enchaîne automatiquement :

1. Terraform (VMs, S3, DNS, secrets, `env.production`)
2. Attente DNS Scaleway si la zone n'est pas encore active
3. Recréation des VMs si SSH indisponible (injection clé cloud-init)
4. Déploiement Docker sur les 2 VMs (app, mail, observability)
5. HTTPS via Let's Encrypt (ACME, gratuit)
6. Health check

### Variables `.env` obligatoires

| Variable | Description |
|----------|-------------|
| `SCW_ACCESS_KEY` | Clé API Scaleway |
| `SCW_SECRET_KEY` | Secret API Scaleway |
| `SCW_PROJECT_ID` | ID projet Scaleway |
| `ADMIN_PASSWORD` | Mot de passe admin bureau |
| `BUREAU_ADMIN_EMAIL` | Email du compte bureau |

### Variables `.env` optionnelles

| Variable | Description |
|----------|-------------|
| `SSH_PUBLIC_KEY` | Clé SSH (auto-détectée depuis `~/.ssh/` si absente) |
| `DNS_ENABLED` | `true` pour forcer le DNS (auto-détecté sinon) |
| `APP_BZH_ENABLED` | `true` pour activer `app.bzh` |

### HTTPS

Certificats émis automatiquement via **Let's Encrypt** (gratuit, protocole ACME). Aucun compte à créer : certbot s'inscrit tout seul avec l'email `BUREAU_ADMIN_EMAIL`. Renouvellement automatique sur les VMs.

## Migration vers Kapsule — runbook

1. **Provisionner** : `bin/framm bootstrap` (crée cluster, pool, base managée, registre, réseau privé ; écrit `deploy/.generated/kubeconfig`).
2. **Secret CI** : ajouter `SCW_SECRET_KEY` dans GitHub → Actions secrets, puis pousser sur `main` : le job `build-push` publie les images `web`/`worker` et met à jour `k8s/apps/web/kustomization.yaml`.
3. **Bootstrap cluster** : `bin/framm k8s-bootstrap` (ArgoCD, secrets applicatifs, ClusterIssuer, monitoring, app-of-apps). ArgoCD synchronise ensuite Traefik, cert-manager et l'app depuis ce dépôt.
4. **Copier la base** : `bin/framm k8s-migrate-db` (dump VM → base managée).
5. **Vérifier** l'app via l'IP du load balancer Traefik, puis **basculer le DNS** :
   `TF_VAR_k8s_lb_ip=<ip> bin/framm bootstrap`
6. **Décommissionner** la VM App (après quelques jours sereins) : retirer `module.app_vm` et le job CI `deploy-prod` — les backups PostgreSQL passent côté base managée (automatiques).

À tout moment, retour arrière = retirer `TF_VAR_k8s_lb_ip` (le DNS repointe la VM).

## GitOps (déploiement applicatif)

Chaque **push sur `main`** (ou `master`) déclenche automatiquement le déploiement prod via **GitHub Actions** (`.github/workflows/deploy.yml`) :

1. `test-web` — lint + build Next.js
2. `deploy-prod` — rsync + Docker sur les VMs (même logique que `bin/framm deploy`)

Avant chaque build, le script monte automatiquement le **volume bloc Scaleway** (20 Go) sur `/var/lib/docker`, nettoie le cache Docker et vérifie l'espace disque disponible.

### Secrets GitHub requis

**Settings → Secrets and variables → Actions** :

| Secret | Description |
|--------|-------------|
| `SSH_PRIVATE_KEY` | Clé privée SSH (paire de la clé injectée dans les VMs) |
| `APP_PUBLIC_IP` | IP VM App (`terraform output -raw app_public_ip`) |
| `MAIL_PUBLIC_IP` | IP VM Mail (`terraform output -raw mail_public_ip`) |

L'infra (Terraform, DNS, HTTPS initial) reste sur `bin/framm bootstrap` en local. Les mises à jour applicatives passent par Git.

## Commandes CLI

| Commande | Description |
|----------|-------------|
| `bin/framm bootstrap` | Déploiement complet (infra + apps + HTTPS) |
| `bin/framm deploy` | Met à jour l'application manuellement (hors CI) |
| `bin/framm status` | Vérifie la santé des services |
| `bin/framm setup-tls` | Renouvelle / configure les certificats HTTPS |
| `bin/framm enable-dns` | Active les records DNS |
| `bin/framm wait-dns` | Attend l'activation registrar puis applique le DNS |
| `bin/framm enable-app-bzh` | Active le domaine app.bzh |

## Observabilité

- Grafana : `https://grafana.kod.bzh`
- Prometheus supervise les deux VMs (node-exporter sur App **et** Mail), l'application web et la fraîcheur des backups.
- Alertes envoyées à l'email défini dans `BUREAU_ADMIN_EMAIL` (ou `ALERT_EMAIL`).

**Envoi des alertes** : provisionné automatiquement via **Scaleway TEM** (Transactional Email) quand le DNS est géré par Scaleway — domaine validé (SPF/DKIM/DMARC), clé IAM dédiée, le tout injecté dans la config Alertmanager au déploiement. TEM est externe aux VMs : si la VM mail tombe, l'alerte part quand même. Pour utiliser un autre SMTP, renseignez `ALERT_SMTP_*` dans `.env` (prioritaire sur TEM).

## Sauvegardes & restauration

Installées automatiquement à chaque déploiement (`/etc/cron.d/framm-backup`) :

| Donnée | Quand | Destination |
|--------|-------|-------------|
| PostgreSQL (`pg_dump`) | tous les jours à 03h00 | `s3://<bucket-backups>/postgres/` |
| Stalwart (mails + config) | tous les jours à 03h30 | `s3://<bucket-backups>/stalwart/` |

Le bucket de backups a le **versioning activé** et une rétention de 30 jours. Chaque exécution exporte une métrique Prometheus ; une alerte critique se déclenche si aucun backup n'a réussi depuis 28h.

**Restauration** :

```bash
# Sur la VM App — restaure le backup le plus récent (ou passez une clé S3 précise)
/opt/framm/deploy/scripts/restore-postgres.sh
# Stalwart : télécharger l'archive s3://<bucket>/stalwart/<date>.tar.gz,
# l'extraire dans /opt/framm/ puis docker compose restart stalwart
```

**Testez la restauration régulièrement** : un backup jamais restauré n'est pas un backup.

### Persistance des données

- VM App : `/var/lib/docker` (dont le volume PostgreSQL) est sur un volume bloc Scaleway dédié — les données survivent à une recréation de la VM.
- VM Mail : `/opt/framm` (données Stalwart) est sur un volume bloc dédié de 50 Go, monté dans le conteneur via `docker-compose.mail.yml`.

### État Terraform

Le tfstate est migré automatiquement vers un bucket S3 versionné (`framm-tfstate-<project>`) au premier `bin/framm bootstrap` : `deploy/scripts/setup-tf-backend.sh` crée le bucket, génère `backend.tf` (non commité) et migre l'état local existant.

## Mises à jour automatisées

Les images Docker sont **épinglées** (Stalwart `v0.16.8`, PostgreSQL 16, Prometheus/Grafana/Loki) et tenues à jour par **Renovate** :

- **Patchs** : PR auto-mergée si la CI est verte, puis déployée automatiquement par le workflow `Deploy` — aucune intervention.
- **Mineures/majeures** (dont Stalwart, qui touche aux données mail) : PR à valider d'un clic ; le merge déclenche le déploiement.

Prérequis (une fois) : installer la [GitHub App Renovate](https://github.com/apps/renovate) sur le dépôt et activer *Allow auto-merge* dans Settings → General. Les paquets systèmes des VMs (sécurité) sont gérés par `unattended-upgrades`.

## Licence

Ce projet est distribué sous licence [CeCILL v2.1](http://www.cecill.info/licences/Licence_CeCILL_V2.1-fr.html).

Copyright © Association Kod Digor. Voir le fichier [LICENSE](LICENSE).

## API d’envoi d’emails

`POST https://kod.bzh/api/v1/mail/send`, avec `Authorization: Bearer $FRAMM_API_KEY` et `Content-Type: application/json`.

JSON : `from`, `to`, `subject`, au moins `text` ou `html` ; `replyTo`, `cc`, `bcc` et `attachments` sont optionnels. `to`, `cc` et `bcc` acceptent une adresse ou un tableau de 1 à 50 adresses chacun. Les doublons sont supprimés sans tenir compte de la casse, priorité `to > cc > bcc`. Les copies visibles restent dans `Cc` ; le BCC est transmis uniquement dans l’enveloppe de livraison et ne figure pas dans les en-têtes ou le corps.

Chaque pièce jointe est `{ filename, content, contentType? }` : nom non vide, contenu base64 canonique, type MIME par défaut `application/octet-stream`. Limite totale : **50 Mo (50 000 000 octets décodés)**. Un fichier invalide ou un dépassement annule tout l’envoi ; la réponse 400 contient `error` et `detail` avec l’index du fichier et la cause. Une erreur de téléversement renvoie 502 avec le fichier concerné. Aucune pièce jointe n’est ignorée silencieusement. Avec pièces jointes, le message est `multipart/mixed`, avec le corps en première partie ; texte et HTML ensemble sont regroupés en `multipart/alternative`.

Exemple Bash (avec `jq`) :

```bash
jq -n --rawfile pdf <(base64 < document.pdf) '{
  from: "noreply@votre-domaine.fr",
  to: "destinataire@example.com",
  cc: ["copie@example.com"],
  subject: "Document",
  text: "Voir le PDF joint.",
  attachments: [{
    filename: "document.pdf",
    content: ($pdf | gsub("\\s"; "")),
    contentType: "application/pdf"
  }]
}' > /tmp/framm-mail.json
curl -X POST 'https://kod.bzh/api/v1/mail/send' \
  -H "Authorization: Bearer $FRAMM_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/framm-mail.json
```

Succès inchangé : `{ "ok": true, "messageId": "..." }`. Le MCP `send_mail` accepte les mêmes champs ; `explain_mail_send_api` fournit le contrat et les exemples. Le domaine doit appartenir à l’organisation et une boîte Stalwart doit être disponible.


### Suivi de livraison et protection de la réputation

Le succès `{ ok: true, messageId }` confirme la soumission au serveur. Il ne garantit ni la réception, ni le classement hors spam. `ACCEPTED` indique une acceptation technique avec réponse 2xx ; `delivered: unknown` ne certifie pas la réception finale.

- `GET /api/v1/mail/messages` : 50 derniers envois de la clé utilisée (`mail:send`). Ajouter `messageId` et `from` pour vérifier une soumission ; les identifiants JMAP sont propres à chaque boîte. `id` et `rfcMessageId` sont uniques. L’admin précise `organizationSlug`. Une ambiguïté retourne 409.
- `GET` rafraîchit les résultats dus ; le worker les contrôle chaque minute, avec un intervalle de dix minutes par message pendant sept jours. Les confirmations finales cessent d’être interrogées. Les erreurs restent visibles ; aucune relance automatique d’un message incertain.
- MCP : `get_mail_delivery_status` expose les mêmes observations ; `verify_domain` contrôle DNS, signature activée et reverse DNS. Les clés DKIM en attente de rotation sont également fournies pour publication.
- Interface : **Suivi des envois**, résultats par destinataire, erreurs, adresses bloquées et rapports DMARC reçus. Les Bcc ne sont jamais montrés aux destinataires, mais restent accessibles au propriétaire de la clé et aux administrateurs de son organisation.
- Par défaut : **20 messages/minute, 200 destinataires sur 24 heures glissantes par organisation**. Les réservations sont sérialisées en base entre processus et clés. Variables administrateur : `MAIL_SEND_MINUTE_LIMIT`, `MAIL_SEND_DAILY_RECIPIENT_LIMIT` (entiers positifs). Monter progressivement après mesure, sans trafic artificiel.
- Les rejets définitifs d’adresse `5.1.1`, `5.1.2`, `5.1.3`, `5.1.6` entraînent un blocage. Les refus de politique/spam et les pannes temporaires n’en entraînent pas. Un blocage annule le message entier, y compris pour un Bcc.
- Gestion explicite et auditée : `POST` ou `DELETE /api/v1/mail/suppressions`, JSON `{address, reason?, organizationSlug?}`, scope `api_keys:write` ou admin. `reason` : `manual`, `hard_bounce`, `complaint`, `unsubscribe`. Erreurs d’envoi : **422 recipient_suppressed**, **429 rate_limited** ; aucun message envoyé dans ces cas.
- Journal : métadonnées uniquement, pas de corps ou pièces jointes ; conservation 90 jours. Les blocages restent jusqu’à correction et retrait par un opérateur autorisé.
- Rapports DMARC : créer `postmaster@domaine` et l’alias `dmarc@domaine`, publier une adresse `rua` surveillée. Le worker lit les rapports XML, gzip et ZIP (2 Mo maximum compressés et décompressés). Les déclarations reçues ne sont pas une mesure certifiée de réputation ; elles ne modifient jamais automatiquement la politique DNS.
- Réglages d’un domaine : `senderName` et `replyToAddress` servent de valeurs par défaut ; un client peut toujours fournir son nom et son `replyTo`. Le script opérateur `apps/web/scripts/configure-mail-operations.mjs <domaine> <email-proprietaire>` configure les alias de supervision et la signature RSA en conservant ses délais de rotation. Créer la boîte postmaster au préalable avec `ensure_mailbox`.

DMARC commence en observation (`p=none`) avec `rua`. Après inventaire de tous les expéditeurs et analyse des rapports, renforcer progressivement vers `quarantine`, puis `reject`. Ces politiques protègent contre l’usurpation ; elles ne garantissent pas le classement en boîte principale. Pour une campagne marketing : consentement, traitement des plaintes et désabonnement en un clic sont nécessaires ; l’API transactionnelle ne les invente pas.

Test d’intégration sans envoi : base PostgreSQL jetable uniquement sur `127.0.0.1:15439/framm_test`, appliquer les migrations puis `DATABASE_URL=… npx tsx scripts/check-mail-policy.ts` depuis `apps/web`.
