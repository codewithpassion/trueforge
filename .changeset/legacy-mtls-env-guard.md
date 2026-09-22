---
'@truefoundry/trueforge': patch
---

Refuse to start while `TRUEFORGE_MTLS_ENABLED` or `TRUEFORGE_MTLS_CERTS_DIR` is set. They were renamed to `MTLS_ENABLED` / `MTLS_CERTS_DIR`; the old names used to be ignored, so a deployment still setting them ran without mTLS.
