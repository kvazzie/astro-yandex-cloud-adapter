/** Selects the nearest concrete ancestor shared by preview and Function fallback. */
export function nearestNotFoundScope<T extends { scope: string }>(
  pathname: string,
  scopes: readonly T[],
): T | undefined {
  return scopes
    .filter(
      ({ scope }) =>
        scope === "/" || pathname === scope || pathname.startsWith(`${scope}/`),
    )
    .sort((a, b) => b.scope.length - a.scope.length)[0];
}
