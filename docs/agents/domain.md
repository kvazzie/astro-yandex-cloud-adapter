# Domain Docs

Before exploring, read `GLOSSARY.md` at the repo root and the
relevant ADRs in `docs/adr/`.

Before creating or renaming source modules or code identifiers,
read `NAMING-MAP.md` for the algorithm that derives names from
glossary terms.

Before naming or classifying errors, read the error model and the
`Errors` subsections of their owning domain sections in
`GLOSSARY.md`. Establish whose input is being checked and which
guarantees the operation owns. A
[_Rejection_](../../GLOSSARY.md#rejection) of external input must
not disguise a broken internal guarantee. A
[_Domain Error_](../../GLOSSARY.md#domain-error) can describe a
negative outcome explicitly admitted by the operation's contract
while valid state and invariants are preserved. If supported
input and available resources should produce a valid result,
failing to do so is a defect. Do not classify every catalogue
entry as a _Domain Error_ or force it into a two-category split.
Do not promote a private data structure's limitations to domain
rules. Establish the promised behaviour independently of the
current guard; record unresolved evidence in the implementation
audit before introducing a type. Use "exception" only for the
technical `throw`/`catch` mechanism. Read `docs/domain-errors.md`
for detailed explanations and `docs/domain-error-audit.md` for
unresolved ownership and implementation gaps before changing
error handling.

Use the glossary vocabulary from `GLOSSARY.md` in issue titles,
proposals, hypotheses, and tests. If a needed concept is missing,
note it for domain modeling.

Write Value Object in full in prose and use `ValueObject` in
identifiers.

In Markdown prose and headings, italicise each glossary term,
including plural forms. Link its first occurrence in each
document to its definition heading in `GLOSSARY.md`, using a
relative path and anchor, for example
`[_Target_](../GLOSSARY.md#target)`. Later occurrences use
`_Target_`. Definition headings in `GLOSSARY.md` are link targets
themselves. Preserve code identifiers, paths, and quoted
diagnostic literals.

If output contradicts an existing ADR, flag the conflict
explicitly instead of silently overriding it.

## File structure

This is a single-context repository:

- `GLOSSARY.md` defines domain terms and errors within their
  owning domain sections.
- `NAMING-MAP.md` derives code identifiers and source paths from
  canonical terms.
- `docs/domain-errors.md` expands error definitions with causes,
  examples, and corrective actions.
- `docs/domain-error-audit.md` records implementation evidence
  and diagnostic gaps.
- `docs/adr/` contains repository-wide architectural decisions.
