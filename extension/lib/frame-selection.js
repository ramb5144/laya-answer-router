export function scoreFrameCandidate(candidate) {
  let score = 0;
  const questionLength = String(candidate.question || '').trim().length;
  const contextLength = String(candidate.nearbyText || candidate.pageText || '').trim().length;

  if (candidate.selection) score += 240;
  if (candidate.canAutoFill) score += 220;
  else if (candidate.canInsert) score += 100;
  if (candidate.targetFocused) score += 160;
  if (candidate.documentHasFocus) score += 35;
  if (candidate.targetVisible) score += 25;
  if (candidate.targetEmpty) score += 20;
  if (candidate.answerControl?.kind === 'single_choice') score += 35;
  if (candidate.isCorrect) score += 120;
  if (candidate.canNavigateNext) score += 45;
  if (questionLength >= 20) score += 100;
  else if (questionLength > 0) score += 35;
  if (contextLength >= 80) score += 25;
  if (candidate.targetAmbiguous) score -= 140;
  if (!candidate.documentVisible) score -= 200;
  if (/\b(?:login|sign[ -]?in|advert|doubleclick)\b/i.test(String(candidate.pageUrl || ''))) score -= 80;

  return score;
}

export function selectFrameCandidate(candidates) {
  return candidates
    .map((candidate) => ({ candidate, score: scoreFrameCandidate(candidate) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftTop = left.candidate.frameId === 0 ? 1 : 0;
      const rightTop = right.candidate.frameId === 0 ? 1 : 0;
      if (rightTop !== leftTop) return rightTop - leftTop;
      return left.candidate.frameId - right.candidate.frameId;
    })[0]?.candidate || null;
}

/**
 * Builds one bounded, readable context payload from every useful frame in the
 * bound tab. The selected answer frame is always first, while exact duplicate
 * frame text and common login/advertising frames are omitted.
 */
export function mergeFramePageContext(candidates, selected, maxLength = 48_000) {
  if (!selected || !Number.isFinite(maxLength) || maxLength <= 0) return '';
  const ordered = [selected, ...candidates.filter((candidate) => candidate !== selected)];
  const seen = new Set();
  const sections = [];

  for (const candidate of ordered) {
    const text = String(candidate?.pageText || '').trim();
    const identity = normalizeContext(text);
    if (!identity || seen.has(identity)) continue;
    if (/\b(?:login|sign[ -]?in|advert|doubleclick)\b/i.test(String(candidate?.pageUrl || ''))) continue;
    seen.add(identity);
    const title = String(candidate?.pageTitle || '').trim() || 'Untitled frame';
    const url = String(candidate?.pageUrl || '').trim();
    sections.push(`FRAME: ${title}${url ? `\nURL: ${url}` : ''}\n${text}`);
  }

  return sections.join('\n\n--- FRAME ---\n\n').slice(0, Math.floor(maxLength));
}

function normalizeContext(value) {
  return String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}
