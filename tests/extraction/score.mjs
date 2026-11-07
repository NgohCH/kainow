// Pure scoring functions. No network access, so they run anywhere.

export const normalise = (text) =>
  text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

// A proposal is supported only if its quote appears verbatim in the input.
export function scoreSupported(proposals, inputText) {
  const haystack = normalise(inputText);
  const unsupported = proposals.filter(
    (p) => !p.source_quote || !haystack.includes(normalise(p.source_quote)),
  );
  const supported = proposals.length - unsupported.length;
  return {
    total: proposals.length,
    supported,
    rate: proposals.length ? supported / proposals.length : 0,
    unsupported: unsupported.map((p) => p.source_quote ?? "(missing)"),
  };
}

// An expected item is captured if some proposal's quote contains its key phrase.
// Automated proxy only: human adjudication (R19) still decides the final reference.
export function scoreCaptured(expected, proposals) {
  const quotes = proposals.map((p) => normalise(p.source_quote ?? ""));
  const missed = expected.filter(
    (e) => !quotes.some((q) => q.includes(normalise(e.key))),
  );
  const captured = expected.length - missed.length;
  return {
    total: expected.length,
    captured,
    rate: expected.length ? captured / expected.length : 0,
    missed: missed.map((e) => e.id),
  };
}

export function passes(supported, captured, thresholds) {
  return (
    supported.rate >= thresholds.supportedProposals &&
    captured.rate >= thresholds.expectedItemsCaptured
  );
}
