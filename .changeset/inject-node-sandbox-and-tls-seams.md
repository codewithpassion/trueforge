---
"@truefoundry/trueforge": patch
---

Internal: sandbox support, session import (`SessionImport` port), the mTLS client-certificate middleware, and the schedule executor transport are now injected by the Node entry points instead of imported by the HTTP app, and the assume-user header helpers moved to `truefoundry/assumeUserHeaders`. No behavior change.
