# Concentrate target policy in target drivers

Each supported target is a concrete adapter at the internal target-driver seam. The driver owns output layout, route compatibility, Astro adapter description, and artifact completion, while the Astro integration owns only hook lifecycle translation. This keeps a new target's policy local instead of distributing target conditionals across hooks and artifact helpers, without inventing ports for future targets whose variation is not yet known.
