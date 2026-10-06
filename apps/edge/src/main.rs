//! The `merkur-edge` process. The edge itself is the library, which the network
//! simulator links too.

#[tokio::main]
async fn main() {
    merkur_edge::run().await;
}
