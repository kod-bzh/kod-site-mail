# Standalone Kod Asso application hosted on Vercel.
# The existing root-site and mail records stay managed by their own resources.
resource "scaleway_domain_record" "kod_asso" {
  count    = var.dns_enabled ? 1 : 0
  dns_zone = var.primary_platform_domain
  name     = "asso"
  type     = "CNAME"
  data     = "38b839a9a963c19e.vercel-dns-017.com."
  ttl      = 300
}
