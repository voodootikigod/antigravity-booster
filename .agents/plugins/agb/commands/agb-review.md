---
name: agb-review
description: Read-only lens fleet over a diff, loop-until-dry
---

# /agb-review [repo] [ref]

Deploys a read-only fleet of models to audit changes until no new critical/high findings remain.

```sh
agb review "$@"
```
