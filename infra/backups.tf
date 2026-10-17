# Off-site backups: the app host's nightly dumps of the Merkur database and
# Rybbit (deploy/backup), encrypted on the host to a key only the owner holds,
# in Cloudflare R2's EU jurisdiction, apart from the Hetzner hosts they protect.
# Every object is locked for 30 days, so not even the host's own key can delete
# or overwrite a backup early, and expires after 35.

resource "cloudflare_r2_bucket" "backups" {
  account_id   = var.cloudflare_account_id
  name         = "merkur-backups"
  jurisdiction = "eu"
}

resource "cloudflare_r2_bucket_lock" "backups" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.backups.name
  jurisdiction = "eu"
  rules = [{
    id        = "hold-30-days"
    enabled   = true
    prefix    = ""
    condition = { type = "Age", max_age_seconds = 30 * 86400 }
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "backups" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.backups.name
  jurisdiction = "eu"
  rules = [{
    id         = "expire-after-35-days"
    enabled    = true
    conditions = { prefix = "" }
    delete_objects_transition = {
      condition = { type = "Age", max_age = 35 * 86400 }
    }
  }]
}

data "cloudflare_account_api_token_permission_groups_list" "r2_item_write" {
  account_id = var.cloudflare_account_id
  name       = "Workers R2 Storage Bucket Item Write"
}

# The app host's upload key: it writes objects into this bucket and reaches
# nothing else. R2's S3 key pair is the token's id and the SHA-256 of its value.
resource "cloudflare_account_token" "backup_upload" {
  account_id = var.cloudflare_account_id
  name       = "merkur-backup-upload"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = one(data.cloudflare_account_api_token_permission_groups_list.r2_item_write.result).id }]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_eu_${cloudflare_r2_bucket.backups.name}" = "*"
    })
  }]
}

output "backup_access_key_id" {
  value = cloudflare_account_token.backup_upload.id
}

output "backup_secret_access_key" {
  value     = sha256(cloudflare_account_token.backup_upload.value)
  sensitive = true
}

import {
  to = cloudflare_r2_bucket.backups
  id = "${var.cloudflare_account_id}/merkur-backups/eu"
}
