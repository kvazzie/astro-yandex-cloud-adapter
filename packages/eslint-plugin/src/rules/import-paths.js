import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** @type {import("eslint").Rule.RuleModule} */
const importPathsRule = {
  meta: {
    type: "suggestion",
    fixable: "code",
    schema: [],
    messages: {
      path: 'Use "{{expected}}": import directories without /index and TypeScript files with .ts.',
    },
  },
  create(context) {
    /** @param {string} source */
    function canonicalPath(source) {
      if (!/^(?:\.{1,2})(?:\/|$)/.test(source)) return source;

      const suffixStart = source.search(/[?#]/);
      const path = suffixStart < 0 ? source : source.slice(0, suffixStart);
      const suffix = suffixStart < 0 ? "" : source.slice(suffixStart);
      const stem = path.replace(/\.(?:js|ts)$/, "");
      const absolute = resolve(dirname(context.filename), stem);
      let file = `${absolute}.ts`;
      let expected = `${stem}.ts`;

      if (/\/$|^\.{1,2}$/.test(path) || !existsSync(file)) {
        file = join(resolve(dirname(context.filename), path), "index.ts");
        expected = `${path.replace(/\/$/, "")}/index.ts`;
        if (!existsSync(file)) return source;
      }

      if (basename(file) === "index.ts") {
        expected = expected.slice(0, -"/index.ts".length);
        // A trailing slash keeps the directory import unambiguous when a
        // same-named TypeScript file exists alongside the directory.
        if (existsSync(`${dirname(file)}.ts`)) expected += "/";
      }

      return expected + suffix;
    }

    return {
      /** @param {import("eslint").Rule.Node} node */
      "ImportDeclaration > Literal.source, ExportNamedDeclaration > Literal.source, ExportAllDeclaration > Literal.source, ImportExpression > Literal.source, ImportExpression > TemplateLiteral.source, TSImportType > TSLiteralType.argument > Literal.literal, TSImportType > Literal.source, TSExternalModuleReference > Literal.expression, CallExpression[callee.name='require'] > Literal.arguments, CallExpression[callee.name='require'] > TemplateLiteral.arguments"(
        node,
      ) {
        const source =
          node.type === "Literal"
            ? node.value
            : node.type === "TemplateLiteral" && node.expressions.length === 0
              ? node.quasis[0]?.value.cooked
              : undefined;
        if (typeof source !== "string") return;
        const expected = canonicalPath(source);
        if (expected === source) return;

        context.report({
          node,
          messageId: "path",
          data: { expected },
          fix(fixer) {
            return fixer.replaceText(node, JSON.stringify(expected));
          },
        });
      },
    };
  },
};

export default importPathsRule;
