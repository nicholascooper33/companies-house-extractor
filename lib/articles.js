/**
 * Articles of association helpers.
 *
 * Pure functions (no I/O) so they can be unit tested:
 *  - classifyFiling: is a filing-history item an articles document, an
 *    articles resolution, or an incorporation bundle?
 *  - selectLatestArticles: pick the most recently filed articles from a list
 *  - buildZip: package several PDFs into a store-only ZIP without dependencies
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

// ---------------------------------------------------------------------------
// Minimal store-only ZIP writer (PDFs are already compressed, so no deflate).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

/**
 * @param {Array<{name: string, data: Buffer, date?: Date}>} entries
 * @returns {Buffer} a valid ZIP archive using the "store" method
 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const { time, day } = dosDateTime(entry.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // flags: UTF-8 names
    local.writeUInt16LE(0, 8);         // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);        // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);      // extra length
    central.writeUInt16LE(0, 32);      // comment length
    central.writeUInt16LE(0, 34);      // disk number
    central.writeUInt16LE(0, 36);      // internal attributes
    central.writeUInt32LE(0, 38);      // external attributes
    central.writeUInt32LE(offset, 42); // local header offset

    localParts.push(local, name, data);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

module.exports = { classifyFiling, selectLatestArticles, articlesFilename, buildZip, crc32 };
