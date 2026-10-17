# The hosts' private network. Services that only other hosts call listen here,
# never on a public address: the website proxies Rybbit's backend over it.

resource "hcloud_network" "private" {
  name     = "merkur"
  ip_range = "10.10.0.0/16"
}

resource "hcloud_network_subnet" "hosts" {
  network_id   = hcloud_network.private.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.10.0.0/24"
}

resource "hcloud_server_network" "app_1" {
  server_id  = hcloud_server.app_1.id
  network_id = hcloud_network.private.id
  ip         = "10.10.0.2"
  depends_on = [hcloud_network_subnet.hosts]
}

resource "hcloud_server_network" "analytics_1" {
  server_id  = hcloud_server.analytics_1.id
  network_id = hcloud_network.private.id
  ip         = "10.10.0.3"
  depends_on = [hcloud_network_subnet.hosts]
}

resource "hcloud_server_network" "nbg_1" {
  server_id  = hcloud_server.nbg_1.id
  network_id = hcloud_network.private.id
  ip         = "10.10.0.4"
  depends_on = [hcloud_network_subnet.hosts]
}
