module "uploads" {
  source = "../../modules/object_storage"

  bucket_name         = local.bucket_uploads
  scaleway_project_id = var.scw_project_id
  scaleway_region     = var.scw_region
  iam_application_name = "framm-uploads"
}

module "backups" {
  source = "../../modules/object_storage"

  bucket_name         = local.bucket_backups
  scaleway_project_id = var.scw_project_id
  scaleway_region     = var.scw_region
  iam_application_name = "framm-backups"

  # 30 backups quotidiens conservés (le versioning du bucket protège en plus
  # contre l'écrasement ou la suppression accidentelle).
  lifecycle_rules = [{
    id              = "expire-old-backups"
    prefix          = ""
    enabled         = true
    transitions     = []
    expiration_days = 30
  }]
}

module "cold_archive" {
  source = "../../modules/object_storage"

  bucket_name         = local.bucket_cold
  scaleway_project_id = var.scw_project_id
  scaleway_region     = var.scw_region
  iam_application_name = "framm-cold"

  lifecycle_rules = [{
    id      = "to-glacier"
    prefix  = ""
    enabled = true
    transitions = [{
      days          = 90
      storage_class = "GLACIER"
    }]
    expiration_days = 365
  }]
}

# BlobStore Stalwart (Phase 1) : bucket + clés IAM dédiées.
# Phase 2 (fenêtre de maintenance) : activer store.blob dans config Stalwart,
# export/import des blobs locaux → S3, puis retirer le stockage disque local.
module "mail_blobs" {
  source = "../../modules/object_storage"

  bucket_name          = local.bucket_mail_blobs
  scaleway_project_id  = var.scw_project_id
  scaleway_region      = var.scw_region
  iam_application_name = "framm-mail-blobs"
}

# VM mail : Scaleway injecte des règles SG non éditables bloquant le SMTP sortant
# (TCP 25/465/587). Sans déblocage support Scaleway, les MailingList Stalwart ne peuvent
# pas relayer vers des MX externes (ex. igor@mages.pro → Google).
module "mail_vm" {
  source = "../../modules/compute_instance"

  name           = "framm-mail-${var.environment}"
  instance_type  = var.environment == "prod" ? var.mail_instance_type : "DEV1-M"
  volume_size_gb = 50
  zone           = var.scw_zone
  inbound_ports  = [22, 25, 80, 443, 465, 587, 993]
  admin_ips      = var.admin_ips

  cloud_init = templatefile("${path.module}/../../../deploy/cloud-init/mail.yaml", {
    domain         = var.primary_platform_domain
    ssh_public_key = var.ssh_public_key
  })
}

module "dns_kod_digor" {
  count  = var.dns_enabled ? 1 : 0
  source = "../../modules/dns_records"

  zone_name = var.primary_platform_domain
  records = [
    { name = "", type = "A", data = local.app_ingress_ip },
    { name = "www", type = "A", data = local.app_ingress_ip },
    { name = "mail", type = "A", data = module.mail_vm.public_ip },
    { name = "webmail", type = "A", data = module.mail_vm.public_ip },
    { name = "autoconfig", type = "CNAME", data = "mail.${var.primary_platform_domain}." },
    { name = "autodiscover", type = "CNAME", data = "mail.${var.primary_platform_domain}." },
    { name = "_imaps._tcp", type = "SRV", data = "0 1 993 mail.${var.primary_platform_domain}." },
    { name = "_submission._tcp", type = "SRV", data = "0 1 587 mail.${var.primary_platform_domain}." },
    # kod.bzh receives through Google Workspace; retain its independently managed MX.
  ]
}

module "dns_app_bzh" {
  count  = var.app_bzh_enabled && var.dns_enabled ? 1 : 0
  source = "../../modules/dns_records"

  zone_name = "app.bzh"
  records = [
    { name = "", type = "A", data = local.app_ingress_ip },
    { name = "www", type = "A", data = local.app_ingress_ip },
    { name = "mail", type = "A", data = module.mail_vm.public_ip },
    { name = "webmail", type = "A", data = module.mail_vm.public_ip },
    { name = "autoconfig", type = "CNAME", data = "mail.app.bzh." },
    { name = "autodiscover", type = "CNAME", data = "mail.app.bzh." },
    { name = "_imaps._tcp", type = "SRV", data = "0 1 993 mail.app.bzh." },
    { name = "_submission._tcp", type = "SRV", data = "0 1 587 mail.app.bzh." },
    { name = "", type = "MX", data = "10 mail.app.bzh." },
  ]
}

resource "local_file" "env_production" {
  filename = "${path.module}/../../../deploy/.generated/env.production"
  content = templatefile("${path.module}/templates/env.production.tpl", {
    auth_secret          = random_password.auth_secret.result
    auth_url             = local.auth_url
    platform_domains     = join(",", local.platform_domains)
    webmail_url          = local.webmail_url
    stalwart_url         = local.mail_url
    stalwart_api_key     = random_password.stalwart_api_key.result
    stalwart_platform_pgp_public_key = replace(replace(replace(trimspace(file("${path.module}/../../../deploy/config/stalwart-platform-public.pem")), "\n", "\\n"), "\"", "\\\""), "$", "\\$")
    bulwark_session_secret = random_password.bulwark_session_secret.result
    db_password          = random_password.db_password.result
    db_host              = "127.0.0.1"
    k8s_database_url     = local.k8s_database_url
    rdb_host             = local.rdb_host
    rdb_port             = local.rdb_port
    rdb_password         = random_password.rdb_password.result
    rdb_public_host      = local.rdb_public_host
    rdb_public_port      = local.rdb_public_port
    dev_database_url     = local.dev_database_url
    grafana_password     = random_password.grafana_password.result
    grafana_root_url     = local.grafana_url
    alert_email          = var.admin_email
    alert_smtp_host      = local.alert_smtp_host
    alert_smtp_port      = local.alert_smtp_port
    alert_smtp_user      = local.alert_smtp_user
    alert_smtp_password  = local.alert_smtp_password
    alert_smtp_from      = local.alert_smtp_from
    outbound_smtp_relay_host   = local.outbound_smtp_relay_host
    outbound_smtp_relay_port   = local.outbound_smtp_relay_port
    outbound_smtp_relay_user   = local.outbound_smtp_relay_user
    outbound_smtp_relay_secret = local.outbound_smtp_relay_secret
    bureau_admin_email   = var.admin_email
    bureau_admin_password = var.admin_password
    primary_domain       = var.primary_platform_domain
    s3_endpoint          = module.uploads.s3_endpoint
    s3_region            = module.uploads.s3_region
    s3_bucket_uploads      = module.uploads.bucket_name
    s3_bucket_backups      = module.backups.bucket_name
    s3_bucket_mail_blobs   = module.mail_blobs.bucket_name
    s3_access_key          = module.uploads.access_key
    s3_secret_key          = module.uploads.secret_key
    s3_mail_blobs_access_key = module.mail_blobs.access_key
    s3_mail_blobs_secret_key = module.mail_blobs.secret_key
    app_public_ip        = local.app_ingress_ip
    mail_public_ip       = module.mail_vm.public_ip
  })

  depends_on = [
    module.uploads,
    module.mail_blobs,
    module.mail_vm,
    scaleway_iam_api_key.alerts,
    scaleway_tem_domain.alerts,
  ]
}
