---
"@astro-yandex-cloud/adapter": patch
---

Preserve compressed and non-UTF-8 response bytes in generated
function handlers by using base64 when a body has
Content-Encoding or cannot be represented as UTF-8 without loss.
Keep ordinary UTF-8 text as a plain string and retain its byte
order mark. Real Yandex Cloud compatibility remains unverified.
