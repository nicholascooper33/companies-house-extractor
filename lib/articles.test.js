const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFiling, selectLatestArticles, articlesFilename } = require('./articles');

const doc = (id) => ({ document_metadata: `https://document-api.company-information.service.gov.uk/document/${id}` });
const ma = (date, id = 'ma') => ({ date, type: 'MA', category: 'incorporation', description: 'memorandum-articles', links: doc(id), pages: 34 });
const memArts = (date) => ({ date, type: 'MEM/ARTS', category: 'incorporation', description: 'memorandum-articles', links: doc('legacy') });
const newinc = (date) => ({ date, type: 'NEWINC', category: 'incorporation', description: 'incorporation-company', links: doc('inc') });
const resolutions = (date, descs) => ({
  date, type: 'RESOLUTIONS', category: 'resolution', description: 'resolution', links: doc('res'),
  resolutions: descs.map(d => ({ type: 'RES01', description: d }))
});
const accounts = (date) => ({ date, type: 'AA', category: 'accounts', description: 'accounts-with-accounts-type-group', links: doc('aa') });
const certnm = (date) => ({ date, type: 'CERTNM', category: 'change-of-name', description: 'certificate-change-of-name-company', links: doc('nm') });

test('classifyFiling recognises articles documents, resolutions and incorporation', () => {
  assert.equal(classifyFiling(ma('2024-01-01')), 'articles');
  assert.equal(classifyFiling(memArts('2000-01-01')), 'articles');
  assert.equal(classifyFiling({ description: 'model-articles-adopted' }), 'articles');
  assert.equal(classifyFiling({ description: 'legacy', description_values: { description: 'MEMORANDUM AND ARTICLES OF ASSOCIATION' } }), 'articles');
  assert.equal(classifyFiling(newinc('2020-01-01')), 'incorporation');
  assert.equal(classifyFiling({ description: 'incorporation-company-with-type-date' }), 'incorporation');
  assert.equal(classifyFiling(resolutions('2021-01-01', ['resolution-adopt-articles'])), 'resolution');
  assert.equal(classifyFiling(resolutions('2021-01-01', ['resolution-alteration-articles'])), 'resolution');
  assert.equal(classifyFiling(resolutions('2021-01-01', ['resolution-memorandum'])), 'resolution');
});

test('classifyFiling ignores accounts (type AA), name changes and memorandum-only resolutions', () => {
  assert.equal(classifyFiling(accounts('2024-01-01')), null);
  assert.equal(classifyFiling(certnm('2024-01-01')), null);
  assert.equal(classifyFiling({ description: 'change-account-reference-date-company-current-extended' }), null);
  assert.equal(classifyFiling(resolutions('2021-01-01', ['special-resolution-alteration-memorandum'])), null);
  assert.equal(classifyFiling(resolutions('2021-01-01', ['resolution-securities', 'resolution-removal-pre-emption'])), null);
});

test('selectLatestArticles prefers the articles document over the resolution filed days later', () => {
  // Tesco 2021: MA on 9 July, RES01 adopt-articles on 12 July
  const { latest, candidates } = selectLatestArticles([
    accounts('2022-01-01'),
    resolutions('2021-07-12', ['resolution-securities', 'resolution-adopt-articles']),
    ma('2021-07-09', 'tesco2021'),
    memArts('2006-07-20'),
    newinc('1947-11-27')
  ]);
  assert.equal(latest.kind, 'articles');
  assert.equal(latest.date, '2021-07-09');
  assert.ok(latest.document_url.endsWith('/tesco2021'));
  assert.deepEqual(candidates.map(c => c.date), ['2021-07-12', '2021-07-09', '2006-07-20', '1947-11-27']);
});

test('selectLatestArticles returns the resolution when no articles document accompanies it', () => {
  // Tesco 2016: RES01 adopt-articles with no MA until 2021
  const { latest } = selectLatestArticles([
    resolutions('2016-07-13', ['resolution-adopt-articles']),
    memArts('2006-07-20')
  ]);
  assert.equal(latest.kind, 'resolution');
  assert.equal(latest.date, '2016-07-13');
  assert.match(latest.note, /resolution filing may include/);
});

test('selectLatestArticles prefers articles over resolution on the same date', () => {
  const { latest } = selectLatestArticles([
    resolutions('2024-03-30', ['resolution-adopt-articles']),
    ma('2024-03-30', 'monzo')
  ]);
  assert.equal(latest.kind, 'articles');
  assert.ok(latest.document_url.endsWith('/monzo'));
});

test('selectLatestArticles falls back to the incorporation bundle', () => {
  const { latest } = selectLatestArticles([certnm('2024-01-01'), newinc('2022-03-24')]);
  assert.equal(latest.kind, 'incorporation');
  assert.match(latest.note, /model articles/);
});

test('selectLatestArticles returns null when nothing qualifies', () => {
  assert.deepEqual(selectLatestArticles([accounts('2024-01-01')]), { latest: null, candidates: [] });
  assert.deepEqual(selectLatestArticles([]), { latest: null, candidates: [] });
});

test('articlesFilename is filesystem safe', () => {
  assert.equal(articlesFilename('09446231', 'MONZO BANK LIMITED', '2024-03-30'), '09446231 MONZO BANK LIMITED - Articles 2024-03-30.pdf');
  assert.equal(articlesFilename('01', 'A/B: "C" <D>', null), '01 AB C D - Articles undated.pdf');
});

