# Astro adapter for Yandex Cloud

`@astro-yandex-cloud/adapter` turns Astro builds into deploy-ready Object Storage and
Cloud Functions artifacts. It does not provision cloud resources.

```js
import yandexCloud from '@astro-yandex-cloud/adapter';
import { defineConfig } from 'astro/config';

export default defineConfig({
  adapter: yandexCloud({ target: 'object-storage-functions' }),
});
```

See [`packages/adapter/README.md`](packages/adapter/README.md) for runtime behavior and
deployment limitations.
