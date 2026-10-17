# The hosts' private network. One host runs every role today, so nothing uses
# it yet; when a role moves to a host of its own, what another host calls (the
# website's Rybbit backend) listens on this network, never on a public address.

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

resource "hcloud_server_network" "nbg_1" {
  server_id  = hcloud_server.nbg_1.id
  network_id = hcloud_network.private.id
  ip         = "10.10.0.4"
  depends_on = [hcloud_network_subnet.hosts]
}
