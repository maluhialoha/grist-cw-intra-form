// Structural tests for the custom-select component (search + chips + a11y),
// lazy-load perf for large ref tables, and ref-dropdown filtering.
// Same approach as smoke.test.js: assert presence of identifying tokens
// rather than running the Vue app.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8');

describe('custom-select — a11y baked into the template', () => {
  const html = read('index.html');

  it('uses a <div role="combobox"> trigger (not <button>)', () => {
    expect(html).toMatch(/role="combobox"/);
  });

  it('renders an aria-labelled <ul role="listbox">', () => {
    expect(html).toMatch(/role="listbox"/);
  });

  it('declares aria-multiselectable on the listbox for multi-selects', () => {
    expect(html).toContain('aria-multiselectable');
  });

  it('uses .sr-only spans for hint text', () => {
    expect(html).toMatch(/class="sr-only"/);
  });
});

describe('lazy-load perf for large ref tables', () => {
  const src = read('app.js');

  it('defines ensureRefDataLoaded for first-open lazy fetch', () => {
    expect(src).toMatch(/function ensureRefDataLoaded/);
  });

  it('caps displayed options via MAX_DISPLAYED_OPTIONS', () => {
    expect(src).toMatch(/MAX_DISPLAYED_OPTIONS\s*=\s*\d+/);
  });
});

describe('ref-dropdown filter', () => {
  const src = read('app.js');
  const html = read('index.html');

  it('declares refDropdownFilterPopup state', () => {
    expect(src).toContain('refDropdownFilterPopup');
  });

  it('renders the 🔗 (chain) icon in the config modal', () => {
    expect(html).toContain('&#128279;');
  });
});
