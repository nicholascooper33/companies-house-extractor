/**
 * Articles of association helpers.
 *
 * Pure functions (no I/O) so they can be unit tested:
 *  - classifyFiling: is a filing-history item an articles document, an
 *    articles resolution, or an incorporation bundle?
 *  - selectLatestArticles: pick the most recently filed articles from a list
 *  - articlesFilename: filesystem-safe download name for the PDF
 */

// Filing descriptions whose document IS the articles (or a model-articles statement).
// Keys come from companieshouse/api-enumerations filing_history_descriptions.yml.
const ARTICLES_DOCUMENT_DESCRIPTIONS = new Set([
  'memorandum-articles',                      // types MA, MEM/ARTS
  're-registration-memorandum-articles',
  'model-articles-adopted',
  'model-articles-adopted-amended-provisions'
]);

// Resolution descriptions that adopt or alter articles. `resolution-memorandum`
// is defined by Companies House as "Memorandum and/or Articles of Association".
const ARTICLES_RESOLUTION_PATTERN = /articles|^resolution-memorandum$/;

// When a resolution adopting articles is filed, the articles themselves are
// usually filed separately within a few days. Treat both as one event.
const RESOLUTION_GRACE_DAYS = 31;

const KIND_PRIORITY = { articles: 0, resolution: 1, incorporation: 2 };

const KIND_LABELS = {
  articles: 'Articles of association',
  resolution: 'Resolution adopting or altering articles',
  incorporation: 'Incorporation documents'
};

const KIND_NOTES = {
  articles: null,
  resolution: 'No separate articles document was filed with this resolution. The resolution filing may include the adopted or amended articles.',
  incorporation: 'No articles have been filed since incorporation. The incorporation bundle contains the articles adopted on formation, or a statement that model articles apply.'
};

function classifyFiling(filing) {
  const description = filing.description || '';
  if (ARTICLES_DOCUMENT_DESCRIPTIONS.has(description)) return 'articles';
  if (description === 'legacy' && /articles/i.test(filing.description_values?.description || '')) {
    return 'articles';
  }
  if (description.startsWith('incorporation-company')) return 'incorporation';
  if ((filing.resolutions || []).some(r => ARTICLES_RESOLUTION_PATTERN.test(r.description || ''))) {
    return 'resolution';
  }
  return null;
}

function toCandidate(filing) {
  const kind = classifyFiling(filing);
  if (!kind) return null;
  return {
    kind,
    label: KIND_LABELS[kind],
    note: KIND_NOTES[kind],
    date: filing.date || null,
    type: filing.type || null,
    description: filing.description || null,
    resolutions: (filing.resolutions || []).map(r => r.description).filter(Boolean),
    pages: filing.pages ?? null,
    transaction_id: filing.transaction_id || null,
    document_url: filing.links?.document_metadata || null
  };
}

function daysBetween(earlier, later) {
  return (new Date(later) - new Date(earlier)) / 86400000;
}

/**
 * @param {Array} filings filing-history items (any order)
 * @returns {{ latest: object|null, candidates: object[] }} candidates newest first
 */
function selectLatestArticles(filings) {
  const candidates = (filings || [])
    .map(toCandidate)
    .filter(Boolean)
    .sort((a, b) =>
      (b.date || '').localeCompare(a.date || '') || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]
    );

  if (candidates.length === 0) return { latest: null, candidates };

  let latest = candidates[0];
  if (latest.kind === 'resolution') {
    const accompanying = candidates.find(
      c => c.kind === 'articles' && daysBetween(c.date, latest.date) <= RESOLUTION_GRACE_DAYS
    );
    if (accompanying) latest = accompanying;
  }
  return { latest, candidates };
}

/** Build a filesystem-safe ASCII filename, e.g. "09446231 MONZO BANK LIMITED - Articles 2024-03-30.pdf". */
function articlesFilename(companyNumber, companyName, date) {
  const stem = `${companyNumber} ${companyName || ''} - Articles ${date || 'undated'}`
    .replace(/[^A-Za-z0-9 ._()&-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${stem}.pdf`;
}

module.exports = { classifyFiling, selectLatestArticles, articlesFilename };
