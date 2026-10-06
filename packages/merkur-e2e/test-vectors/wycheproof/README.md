# ChaCha20-Poly1305 adversarial vectors

`chacha20_poly1305_test.json` is the unmodified C2SP Wycheproof vector set at
[`e0df04e0c033f2d25c5051dd06230336c7822358`](https://github.com/C2SP/wycheproof/blob/e0df04e0c033f2d25c5051dd06230336c7822358/testvectors_v1/chacha20_poly1305_test.json).
SHA-256: `fe61d25f90e1bde4461d00eafe61049e5f29bd999f36b766df9cda90906ad53d`. The vectors are Apache-2.0 licensed;
the upstream licence is retained in `LICENSE`.

`bun run test:wasm-cipher` exercises all 316 vectors with the fixed 256-bit key,
96-bit nonce and 128-bit tag supported by the browser cipher. The other nine
vectors have invalid nonce lengths excluded by the cipher's typed nonce API;
the test checks that each is invalid. Invalid opens must leave their output unchanged.
