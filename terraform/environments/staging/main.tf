module "prod" {
  source = "../prod"

  scw_project_id          = var.scw_project_id
  admin_password          = var.admin_password
  admin_email             = var.admin_email
  admin_ips               = var.admin_ips
  ssh_public_key          = var.ssh_public_key
  environment             = "staging"
  primary_platform_domain = "staging.kod.bzh"
  app_bzh_enabled         = false
  dns_enabled             = var.dns_enabled
}

variable "ssh_public_key" {
  type        = string
  description = "Clé SSH publique injectée via cloud-init (root)"
}

variable "scw_project_id" {
  type = string
}

variable "admin_password" {
  type      = string
  sensitive = true
}

variable "admin_email" {
  type      = string
  sensitive = true
}

variable "dns_enabled" {
  type    = bool
  default = false
}

variable "admin_ips" {
  type    = list(string)
  default = []
}

output "app_public_ip" {
  value = module.prod.app_public_ip
}
