---
'@truefoundry/trueforge': patch
'@truefoundry/trueforge-assistant-ui-runtime': patch
---

Hand-back and cancel-takeover answer `outcome_unknown` when the resume may or may not have been saved. The request stays listed, so the person can refresh to see whether the agent resumed; only a resume refused as invalid answers `resume_failed`.
