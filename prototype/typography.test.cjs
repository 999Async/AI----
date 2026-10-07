const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;
const appStyles = [
  'styles.css',
  'page-header.css',
  'upload.css',
  'homework.css',
  'learning.css',
  'knowledge-tree.css',
  'recommendation.css',
];

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('student pages use one semantic type scale instead of local pixel sizes', () => {
  const base = read('styles.css');
  for (const token of [
    '--type-display:30px',
    '--type-page-title:28px',
    '--type-section-title:22px',
    '--type-card-title:18px',
    '--type-body:15px',
    '--type-body-compact:14px',
    '--type-label:13px',
    '--type-meta:12px',
    '--type-caption:11px',
  ]) {
    assert.match(base, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const file of appStyles) {
    assert.doesNotMatch(read(file), /font-size\s*:\s*\d/, `${file} contains an unclassified font size`);
  }
});

test('repeated cross-page roles point at the shared tokens', () => {
  const upload = read('upload.css');
  assert.match(read('page-header.css'), /\.page-title\{font-size:var\(--type-page-title\)/);
  assert.match(upload, /\.upload-guide h2\{font-size:var\(--type-card-title\)/);
  assert.match(upload, /\.upload-history-head h2\{font-size:var\(--type-card-title\)/);
  assert.match(read('homework.css'), /\.hw-current-heading h2\{font-size:var\(--type-card-title\)/);
  assert.match(read('learning.css'), /\.lr-overview h2,.lr-section-heading h2\{font-size:var\(--type-section-title\)/);
  assert.match(read('knowledge-tree.css'), /\.kt-detail h2\{font-size:var\(--type-card-title\)/);
  assert.match(read('recommendation.css'), /\.recommendation-header h1\{font-size:var\(--type-page-title\)/);
});
