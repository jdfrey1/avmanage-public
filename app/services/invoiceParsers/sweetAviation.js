// Parser for Sweet Aviation, LLC (Fort Wayne, IN) work orders: "Item/Discrepancy: N STATUS date"
// blocks with Description / Work Performed / Charges / parts rows. Also serves as the template
// for adding other shops' formats.
const money = (s) => parseFloat(String(s).replace(/[$,]/g, ''));
const clean = (s) => (s || '').replace(/\s*\n\s*/g, ' ').trim();

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function parseLongDate(s) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(s || '');
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// Returns null when the text isn't a Sweet Aviation work order.
function parse(rawText) {
  const woMatch = /Work Order\s+(GWB\d+)/.exec(rawText);
  if (!woMatch || !/Sweet Aviation/.test(rawText)) return null;

  // Drop the repeated page header/footer lines.
  const text = rawText.split('\n').filter(l => {
    const s = l.trim();
    return s && !/^(Sweet Aviation, LLC|902 W\. Ludwig Rd\.|Fort Wayne, IN 46825|\(260\) 267-5505)$/.test(s) && !/^Printed:/.test(s);
  }).join('\n');

  const g = (re) => { const m = re.exec(text); return m ? m[1] : null; };
  const times = /Total Time:\s*([\d.]+)\s*Hobbs:\s*([\d.]+)\s*Tach:\s*([\d.]+)/.exec(text);
  const summary = /Service Summary:\s*Totals:\s*\n([\s\S]*?)\nLabor:/.exec(text);
  const printed = /Printed:\s*([A-Za-z]+ \d{1,2}, \d{4})/.exec(rawText);
  const header = {
    vendor: 'Sweet Aviation, LLC',
    invoice_number: woMatch[1],
    invoice_date: parseLongDate(printed?.[1]),
    customer: clean(g(/Customer:\s*(.*)/)),
    summary: clean(summary?.[1]),
    total_time: times ? parseFloat(times[1]) : null,
    hobbs: times ? parseFloat(times[2]) : null,
    flight_timer: times ? parseFloat(times[3]) : null,
    labor: money(g(/Labor:\s*(\$[\d,.]+)/) ?? 0),
    parts: money(g(/Parts:\s*(\$[\d,.]+)/) ?? 0),
    shipping: money(g(/Shipping & Misc:\s*(\$[\d,.]+)/) ?? 0),
    tax: money(g(/Tax:\s*(\$[\d,.]+)/) ?? 0),
    total: money(g(/Charges:\s*(\$[\d,.]+)/) ?? NaN),
  };
  if (isNaN(header.total)) return null;

  const body = text.slice(text.indexOf('Item/Discrepancy:'));
  const items = [];
  for (const blk of body.split(/^(?=Item\/Discrepancy: \d+ )/m)) {
    const m = /^Item\/Discrepancy:\s*(\d+)\s+(APPROVED|REJECTED|PENDING)\s*(.*)/.exec(blk);
    if (!m) continue;
    const desc = /Description:\s*\n([\s\S]*?)\n(?:Work Performed:|Charges this item:)/.exec(blk);
    const work = /Work Performed:\s*\n([\s\S]*?)\nCharges this item:/.exec(blk);
    const ch = /Charges this item:\s*([\d.]+)\s*Hours\s*@\s*\$([\d,.]+)\s*\$([\d,.]+)/.exec(blk);
    const tot = /Total For This Item:\s*\$([\d,.]+)/.exec(blk);
    // A part row can wrap onto the next line(s) when its description is long — re-join those first.
    const ROW = /^Installed\s+(\S+)\s+(.*?)\s+([\d.]+)\s+\$([\d,.]+)\s+\$([\d,.]+)\s*$/;
    const parts = [];
    let pending = null;
    for (const line of blk.split('\n')) {
      const l = line.trim();
      if (pending === null && /^Installed\s/.test(l)) pending = l;
      else if (pending !== null) pending += ' ' + l;
      if (pending !== null) {
        const pm = ROW.exec(pending);
        if (pm) { parts.push({ part: pm[1], description: pm[2].trim(), qty: parseFloat(pm[3]), unit: money(pm[4]), ext: money(pm[5]) }); pending = null; }
        else if (/^Total For This Item:/.test(l) || /^Item\/Discrepancy:/.test(l)) pending = null;
      }
    }
    items.push({
      n: parseInt(m[1]), status: m[2].toLowerCase(), date: parseLongDate(m[3]),
      description: clean(desc?.[1]), work: clean(work?.[1]),
      hours: ch ? parseFloat(ch[1]) : 0, rate: ch ? money(ch[2]) : 0, labor: ch ? money(ch[3]) : 0,
      parts, total: tot ? money(tot[1]) : 0,
    });
  }
  // Sanity check: the line items must add up to the printed total, or we don't trust the parse.
  const sum = items.reduce((s, i) => s + i.total, 0) + header.shipping + header.tax;
  const itemsOk = items.length > 0 && Math.abs(sum - header.total) < 0.02 &&
    items.every(i => Math.abs(i.labor + i.parts.reduce((s, p) => s + p.ext, 0) - i.total) < 0.02);
  return { header, items: itemsOk ? items : [], itemsOk };
}

module.exports = { parse };
