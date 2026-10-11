/** Loads the built public export while keeping pre-build typechecking source-based. */
const module = (await import(
  new URL("../../../packages/adapter/dist/index.js", import.meta.url).href
)) as { default: typeof yandexCloud };

export default module.default;
import type yandexCloud from "../../../packages/adapter/src/index.js";
