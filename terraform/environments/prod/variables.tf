variable "scw_project_id" {
  type = string
}

variable "scw_region" {
  type    = string
  default = "fr-par"
}

variable "scw_zone" {
  type    = string
  default = "fr-par-1"
}

variable "admin_password" {
  type      = string
  sensitive = true
}

variable "admin_email" {
  type      = string
  sensitive = true
  description = "Email du compte bureau (fourni via .env, jamais en dur dans le code)"
}

variable "dns_enabled" {
  type        = bool
  default     = false
  description = "Active les records DNS Scaleway — nécessite la zone déléguée chez Scaleway"
}

variable "tem_enabled" {
  type        = bool
  default     = false
  description = "Active Scaleway TEM pour les alertes SMTP — nécessite un abonnement TEM actif sur le projet"
}

variable "primary_platform_domain" {
  type    = string
  default = "kod.bzh"
}

variable "app_bzh_enabled" {
  type    = bool
  default = false
}

variable "admin_ips" {
  type    = list(string)
  default = []
}

variable "ssh_public_key" {
  type        = string
  description = "Clé SSH publique injectée via cloud-init (root)"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "alert_smtp_host" {
  type        = string
  default     = ""
  description = "Serveur SMTP pour l'envoi des alertes (vide = alertes email désactivées)"
}

variable "alert_smtp_port" {
  type    = string
  default = "587"
}

variable "alert_smtp_user" {
  type    = string
  default = ""
}

variable "alert_smtp_password" {
  type      = string
  sensitive = true
  default   = ""
}

variable "alert_smtp_from" {
  type    = string
  default = ""
}

# --- Kubernetes (Kapsule) ---

variable "k8s_version" {
  type        = string
  default     = "1.33"
  description = "Version mineure Kubernetes (vérifier `scw k8s version list`) — patchs gérés par auto_upgrade ; 1.32 EoS Scaleway 2026-06-24"
}

variable "k8s_node_type" {
  type        = string
  default     = "DEV1-M"
  description = "Type des nœuds du pool (DEV1-M : 3 vCPU / 4 Go, suffisant pour démarrer)"
}

variable "k8s_pool_min" {
  type    = number
  default = 1
}

variable "k8s_pool_max" {
  type    = number
  default = 4
}

variable "k8s_lb_ip" {
  type        = string
  default     = "195.154.197.31"
  description = "IP du load balancer Traefik — bascule le DNS app vers Kapsule"
}

variable "registry_namespace" {
  type        = string
  default     = "framm-kod-digor"
  description = "Namespace du registre d'images (rg.<region>.scw.cloud/<namespace>)"
}

# --- Base de données managée ---

variable "rdb_node_type" {
  type        = string
  default     = "db-dev-s"
  description = "db-dev-s (1 vCPU/2 Go, ~11€/mois) suffit pour démarrer ; passer à db-gp-xs ensuite"
}

variable "rdb_ha" {
  type    = bool
  default = false
}

variable "rdb_allowed_ips" {
  type        = list(string)
  default     = []
  description = "IPv4 autorisées sur l'endpoint public RDB (CIDR /32). Vide = admin_ips/32"
}

# --- Tailles des VMs ---


variable "mail_instance_type" {
  type        = string
  default     = "DEV1-S"
  description = "VM Mail — DEV1-S (2 vCPU/2 Go) phase démarrage asso. Changer le type recrée la VM : les données mail survivent sur le volume bloc."
}
