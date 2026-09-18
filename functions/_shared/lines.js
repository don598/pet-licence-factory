// ── Goofy Licenses — Product Line Registry (SERVER) ─────────────────────────
// Server mirror of public/lines.js (the client registry, which carries the
// display copy, colors and links). Keep ids/names/status in sync when adding
// a line.
//
// An order's line is stored in pet_orders.brand. 'goofy' is the legacy
// spelling of 'goat' (used before the house brand had more than one line);
// lineOfBrand() folds it in so both read the same everywhere.

export const LINES = {
  plc:      { id: 'plc',      name: "Pet Driver's License", status: 'live' },
  goat:     { id: 'goat',     name: 'G.O.A.T. License',     status: 'live' },
  forklift: { id: 'forklift', name: 'Forklift Certified',   status: 'soon' },
  clown:    { id: 'clown',    name: 'Clown License',        status: 'soon' },
};

// Lines that take waitlist signups (plus the free-text suggestion box).
export const WAITLIST_LINES = Object.values(LINES)
  .filter((l) => l.status === 'soon')
  .map((l) => l.id)
  .concat('suggest');

// Sender name for customer emails, per line.
export const LINE_FROM_NAME = {
  goat: 'The Council of G.O.A.T. Affairs',
};

export function lineOfBrand(brand) {
  const b = String(brand || '').trim().toLowerCase();
  if (b === 'goofy' || b === 'goat') return 'goat';
  return LINES[b] ? b : 'plc';
}

// Line of an order row: its stored brand first; rows from before the brand
// column (or with the default 'plc') fall back to the GOOFY- id prefix, which
// only the G.O.A.T. checkout has ever issued.
export function lineOfOrder(row) {
  const fromBrand = lineOfBrand(row && row.brand);
  if (fromBrand !== 'plc') return fromBrand;
  return /^GOOFY-/i.test(String((row && row.order_id) || '')) ? 'goat' : 'plc';
}
