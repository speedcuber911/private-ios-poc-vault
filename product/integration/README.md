# Cross-product integration tests

These tests require the complete Relay source checkout. Keep tests that import
multiple products here: `product/cloud` is also published as a standalone
repository and its own test suite must not require sibling product directories.

Install the cloud dependencies with `npm ci --prefix product/cloud`, then run
from the repository root:

```sh
npm test --prefix product/integration
```

The hosted pairing test exercises the actual cloud queue, signed node polling,
encrypted rendezvous, OpenSSL certificate issuance, readiness acknowledgement,
two fresh device tokens, preservation of an existing token, and independent
device revocation. It uses temporary local state and no production credentials.
Run it in addition to the standalone cloud and daemon suites before release.
