---
"@astro-yandex-cloud/adapter": patch
---

Preserve Node's namespace binding behavior when discovering
runtime dependencies. Match npm's workspace override rules, check
the installed package identity against the lock metadata, and
verify link targets before archiving. The generated integrity
hash covers the archived installed files.
