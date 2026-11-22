/* Validoe Report Builder engine. No AI: parsing + approved phrase banks. */
(function (root) {
  'use strict';

  // ---------- helpers ----------
  const HIST_KEY = 'vrb_history_v1';
  let history = [];
  try { history = JSON.parse(root.localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { history = []; }
  let pendingHist = [];

  function rnd(n) { return Math.floor(Math.random() * n); }
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  // pick a variant, avoiding recently used sentences when possible
  function pick(list) {
    const fresh = list.filter(s => !history.includes(s));
    const pool = fresh.length ? fresh : list;
    const s = pool[rnd(pool.length)];
    pendingHist.push(s);
    return s;
  }
  function commitHistory() {
    history = history.concat(pendingHist).slice(-400);
    pendingHist = [];
    try { root.localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch (e) {}
  }
  function clearHistory() { history = []; try { root.localStorage.removeItem(HIST_KEY); } catch (e) {} }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function joinList(a) {
    if (a.length <= 1) return a.join('');
    if (a.length === 2) return a[0] + (/ and /.test(a[0]) ? ', and ' : ' and ') + a[1];
    return a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
  }
  function money(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function num(s) { return parseFloat(String(s).replace(/[$,\s]/g, '')); }
  function article(g) { return /^(8|11|18)(\.|$)/.test(String(g)) ? 'an' : 'a'; }
  function isPlural(label) { return /(whites|scratches|dents|stains|flaking|dots|spots|marks|creases|lines)$/.test(label); }
  function pluralize(label) {
    if (isPlural(label)) return label;
    if (/scratch$/.test(label)) return label + 'es';
    if (/(dot|spot|dent|crease|mark)$/.test(label)) return label + 's';
    return label;
  }
  function countable(label) { return /(scratch|dot|spot|dent|crease|mark)$/.test(label); }
  function words(s) { return (s.match(/\S+/g) || []).length; }
  const NUMW = ['zero', 'one', 'two', 'three', 'four'];

  // ---------- parsing ----------
  const COL_KEYS = ['raw', '7', '8', '9', '9.5', '10'];

  function parse(text) {
    const out = { prices: {}, extraPrices: {}, centering: { front: {}, back: {} }, flaws: [], log: [], nominal: false, notes: [], aiNote: '', userGrade: null, hints: {} };
    let lines = text.replace(/\r/g, '').split('\n');
    lines = repairSplitPriceRow(lines);

    // price table: header line containing PSA 10 / Grade 7, values on next line with $
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (/grade\s*7|rang\s*7/i.test(L) && /psa\s*10/i.test(L)) {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          if (/\$/.test(lines[j])) {
            const cells = lines[j].split('\t').map(c => c.trim()).filter((c, k, arr) => !(c === '' && k === arr.length - 1));
            let cs = cells;
            if (cs.length < 6) {
              // fallback: split on runs of 2+ spaces
              cs = lines[j].trim().split(/\t|\s{2,}/);
            }
            cs.slice(0, 6).forEach((c, k) => {
              const m = c.match(/\$\s?([\d,]+(?:\.\d+)?)/);
              if (m) out.prices[COL_KEYS[k]] = num(m[1]);
            });
            break;
          }
        }
      }
    }
    // centering: walk the text in order; each ratio pair goes to the most recent Left/Right or Top/Bottom header
    const lr = [], tb = [];
    Object.assign(out, parseCenteringText(text, lr, tb));
    if (lr[0]) out.centering.front.lr = lr[0];
    if (tb[0]) out.centering.front.tb = tb[0];
    if (lr[1]) out.centering.back.lr = lr[1];
    if (tb[1]) out.centering.back.tb = tb[1];

    // flaws + log
    let side = null, inLog = false;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i].trim();
      if (/front flaws/i.test(L)) { side = 'front'; inLog = false; continue; }
      if (/back flaws/i.test(L)) { side = 'back'; inLog = false; continue; }
      if (/^compliance engine log/i.test(L)) { inLog = true; side = null; continue; }
      const fm = L.match(/^\[(CORNERS|EDGES|SURFACE)\]\s*([^:]+):\s*(.+)$/i);
      if (fm && side) {
        out.flaws.push({ side, cat: fm[1].toLowerCase(), loc: fm[2].trim(), type: fm[3].trim(), label: autoLabel(fm[1].toLowerCase(), fm[3]) });
        continue;
      }
      if (inLog) {
        if (/system nominal/i.test(L)) { out.nominal = true; continue; }
        if (/^\[PSA/i.test(L)) { out.log.push(L); continue; }
        if (L === '') continue;
        inLog = false;
      }
    }
    if (!out.log.length && /system nominal/i.test(text)) out.nominal = true;

    // extra grade prices + raw range + notes + ai note
    for (const raw of lines) {
      const L = raw.trim();
      if (!L) continue;
      if (/grade\s*7|rang\s*7/i.test(L) && /psa\s*10/i.test(L)) continue;
      if (/^\$/.test(L)) continue;
      if (/^(left|top)\s*\//i.test(L) || /^sub\s|^(left|top)worst|worst side|^\d{1,2}\.\d\/\d|^measured live|^verification$|^volume:|^\+\s*$/i.test(L)) continue;
      if (/^(\/|left|right|top|bottom|sub\s*[\d.]+)$/i.test(L)) continue;
      if (/^\[|^-?\d+(\.\d)?$|^front flaws|^back flaws|^compliance|^clean$|^\d+$/i.test(L)) continue;
      // range rows like "PSA 1 – PSA 2 (Poor to Good)	$11 – $19"
      const rr = L.match(/^psa\s*(\d+)\s*[–-]\s*psa\s*(\d+).*?\$\s*([\d,.]+)\s*[–-]\s*\$\s*([\d,.]+)/i);
      if (rr) { const v = (num(rr[3]) + num(rr[4])) / 2; for (let k = +rr[1]; k <= +rr[2]; k++) out.extraPrices[String(k)] = v; continue; }
      // extra price lines: "PSA 8 250", "Grade 4	$4,799.65", "PSA 6 (EX-MT)	~$15 – $25", "psa 1 - 290", "TAG 10 ... ~$350 – $550+"
      const gm = L.match(/^(psa|grade|tag|cgc|bgs)\s*(\d{1,2}(?:\.5)?)\b/i);
      if (gm && !/^psa\s*\d{1,2}\s*$/i.test(L)) {
        const dollars = [...L.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map(m => num(m[1]));
        let val = null;
        if (dollars.length >= 2 && /\$\s?[\d,.]+\+?\s*[–-]\s*~?\$/.test(L)) val = (dollars[0] + dollars[1]) / 2;
        else if (dollars.length) val = dollars[0];
        else { const t = L.match(/^(?:psa|grade)\s*\d{1,2}(?:\.5)?\s*(?:[–:=-]\s*|is\s+|at\s+|around\s+|avg\s+)*\$?\s*([\d,]{2,}(?:\.\d+)?)\b/i); if (t) val = num(t[1]); }
        if (val != null) {
          const co = gm[1].toUpperCase();
          const key = (co === 'PSA' || co === 'GRADE') ? gm[2] : co + ' ' + gm[2];
          out.extraPrices[key] = val;
          // a short typed line like "psa 6 229" is also your grade call
          if ((co === 'PSA') && L.length < 40 && !/\t/.test(L) && !/^grade/i.test(L)) out.typedGrade = parseFloat(gm[2]);
          continue;
        }
      }
      const raw2 = L.match(/^(ungraded|raw)[^$]*\$\s*([\d,.]+)(?:\s*[–-]\s*\$\s*([\d,.]+))?/i);
      if (raw2) { out.prices.raw = raw2[3] ? (num(raw2[2]) + num(raw2[3])) / 2 : num(raw2[2]); continue; }
      if (L.length >= 120 && !/\t/.test(L)) { out.aiNote += (out.aiNote ? ' ' : '') + L; continue; }
      if (/^(card grade|grade \/|psa grade|tag grade)/i.test(L)) continue;
      out.notes.push(L);
    }
    // standalone ungraded value line under an "Ungraded" header
    if (out.prices.raw == null) {
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*ungraded\s*$/i.test(lines[i])) {
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const m = lines[j].match(/\$\s?([\d,]+(?:\.\d+)?)/); if (m) { out.prices.raw = num(m[1]); break; }
          }
        }
      }
    }

    // user grade from short note lines
    for (const L of out.notes) {
      const m = L.match(/^\W*\w?p?psa?s?\s*(1\s?0|[1-9](?:\.5)?)\b/i) || L.match(/\bpsa\s*(1\s?0|[1-9](?:\.5)?)\b/i);
      if (m && L.length < 60) out.userGrade = parseFloat(m[1].replace(/\s/g, ''));
    }
    if (out.userGrade == null && out.typedGrade != null) out.userGrade = out.typedGrade;
    const notesTxt = out.notes.join(' ').toLowerCase();
    out.hints = {
      whites: /call ?outs?.{0,30}white|white.{0,30}call ?outs?|all.{0,20}whites?|^(minor |multiple )?whites?$/m.test(out.notes.join('\n').toLowerCase()) || /\bwhites?\b/.test(notesTxt) && /call ?out/.test(notesTxt),
      scratch: /call ?outs?.{0,30}scratch|scratch.{0,30}call ?out/.test(notesTxt),
      whiteDot: /white ?dot/.test(notesTxt),
      holoUnique: /unique/.test(notesTxt),
      textured: /textur/.test(notesTxt),
      holoFactory: /holo.{0,30}factory|factory.{0,20}holo/.test(notesTxt),
      rosette: /rosette/.test(notesTxt),
      noBack: /no back|nothing ab(ou)?t the (card )?back|dont say anything abt the card back/.test(notesTxt),
      grail: /grail/.test(notesTxt),
      noHolo: /no holo/.test(notesTxt),
      authentic: /\bauth|authentic|real\b/.test(notesTxt),
      fake: /card is fake|is def(initely)? fake|box is fake|pack is fake/.test(notesTxt),
      bundle: /bundle/.test(notesTxt),
      yugioh: /yu-?gi-?oh|ygo/.test(notesTxt + ' ' + out.aiNote.toLowerCase())
    };
    out.logGrade = logGrade(out);
    return out;
  }

  // When other text gets pasted into the middle of the price row, the row's tail ends up glued to a later line
  // (often the compliance log line). Put the row back together and strip the tail from that line.
  function repairSplitPriceRow(lines) {
    const hi = lines.findIndex(L => /(grade|rang)\s*7/i.test(L) && /psa\s*10/i.test(L));
    if (hi < 0) return lines;
    let ri = -1;
    for (let j = hi + 1; j < Math.min(hi + 4, lines.length); j++) if (/\$/.test(lines[j])) { ri = j; break; }
    if (ri < 0) return lines;
    const row = lines[ri];
    const cells = (row.match(/\$\s?[\d,]+(?:\.\d+)?/g) || []).length;
    if (cells >= 5) return lines;
    const head = (row.match(/^\s*\$\s?[\d,]+(?:\.\d+)?\s*[+-]?/) || [''])[0];
    const rest = row.slice(head.length);
    for (let k = ri + 1; k < lines.length; k++) {
      const L = lines[k];
      const at = L.search(/\$\s?[\d,]+(?:\.\d+)?\s*\t/);
      if (at < 0) continue;
      const tail = L.slice(at);
      if ((tail.match(/\$\s?[\d,]+/g) || []).length < 4) continue;
      const out = lines.slice();
      out[ri] = head + tail;
      out[k] = L.slice(0, at);
      if (rest.trim()) out.splice(ri + 1, 0, rest);
      return out;
    }
    return lines;
  }

  function parseCenteringText(text, lr, tb) {
    lr = lr || []; tb = tb || [];
    const re = /(left\s*\/\s*right|l\s*\/\s*r\b)|(top\s*\/\s*bottom|t\s*\/\s*b\b)|(\d{1,2}(?:\.\d+)?)\s*%?\s*\/\s*(\d{1,2}(?:\.\d+)?)\s*%?/gi;
    let pending = null, m;
    while ((m = re.exec(text))) {
      if (m[1]) { pending = 'lr'; continue; }
      if (m[2]) { pending = 'tb'; continue; }
      const a = parseFloat(m[3]), b = parseFloat(m[4]);
      if (!pending || Math.abs(a + b - 100) > 1.5) continue;
      (pending === 'lr' ? lr : tb).push([m[3], m[4]]);
      pending = null;
    }
    // no headers at all: take ratio pairs in order (front LR, front TB, back LR, back TB)
    if (!lr.length && !tb.length) {
      const pairs = [...text.matchAll(/(\d{1,2}(?:\.\d+)?)\s*%?\s*\/\s*(\d{1,2}(?:\.\d+)?)/g)].filter(x => Math.abs(parseFloat(x[1]) + parseFloat(x[2]) - 100) <= 1.5).map(x => [x[1], x[2]]);
      if (pairs.length >= 2) { lr.push(pairs[0]); tb.push(pairs[1]); if (pairs[3]) { lr.push(pairs[2]); tb.push(pairs[3]); } }
    }
    return {};
  }
  function centeringFrom(text) {
    const lr = [], tb = []; parseCenteringText(text, lr, tb);
    return { front: { lr: lr[0], tb: tb[0] }, back: { lr: lr[1], tb: tb[1] } };
  }

  function autoLabel(cat, type) {
    const t = type.toLowerCase();
    if (/micro touch|slight wear/.test(t)) return 'slight wear';
    if (/notable softness|rounding/.test(t)) return 'notable softness';
    if (/severe creasing|split stock/.test(t)) return 'severe creasing with split stock';
    if (/minor chipping|specks/.test(t)) return 'minor whites';
    if (/significant rough cut|whitening/.test(t)) return 'significant whites';
    if (/heavy indent|tear|flaking/.test(t)) return 'heavy indents, tears, and flaking';
    if (/hairline scratch|micro printing/.test(t)) return 'hairline scratch';
    if (/scratches|deep print lines|wax/.test(t)) return 'scratches, deep print lines, and wax stains';
    if (/major dent|dimple/.test(t)) return 'major dent';
    return t;
  }

  function logGrade(p) {
    if (p.nominal && !p.log.length) return 10;
    let g = null;
    for (const L of p.log) {
      const m = L.match(/(?:capped at|cap(?:s)? grade at psa|restricts final grade to|limits grade to psa|grade at psa)\s*(\d+(?:\.\d)?)/i);
      if (m) { const v = parseFloat(m[1]); g = g == null ? v : Math.min(g, v); }
    }
    return g;
  }

  // ---------- centering ----------
  function worst(pair) { return pair ? Math.max(parseFloat(pair[0]), parseFloat(pair[1])) : 0; }
  // Validoe's compliance log is the source of truth for front centering. Only when there is no log do we fall back to the raw numbers.
  let CUR_STRICT = null;
  function strictFromLog(p) {
    if (!p.log.length && !p.nominal) return null;
    const out = { lr: null, tb: null };
    p.log.forEach(L => {
      const m = L.match(/front\s*(left\/right|top\/bottom)\s*>\s*(\d+\/\d+)/i);
      if (/strict/i.test(L) && m) { const k = /left/i.test(m[1]) ? 'lr' : 'tb'; if (!out[k] || parseInt(m[2]) > parseInt(out[k])) out[k] = m[2]; }
    });
    return out;
  }
  function exceedTh(pair, axis) {
    if (CUR_STRICT) return CUR_STRICT[axis] || null;
    const w = worst(pair); return w > 60 ? '60/40' : w > 55 ? '55/45' : null;
  }
  function centeringLine(c) {
    const lr = c.lr ? c.lr[0] + '/' + c.lr[1] : 'X/X', tb = c.tb ? c.tb[0] + '/' + c.tb[1] : 'X/X';
    return 'Centering measures ' + lr + ' left to right and ' + tb + ' top to bottom.';
  }
  function frontExceedSentence(c, limiting) {
    const a = exceedTh(c.lr, 'lr'), b = exceedTh(c.tb, 'tb');
    if (!a && !b) return '';
    const lim = limiting ? ' and is the limiting factor' : '';
    if (a && b) {
      if (a === b) return 'Front centering exceeds ' + a + ' both left to right and top to bottom' + (limiting ? ' and is the limiting factor' : '') + '.';
      return 'Front centering exceeds ' + a + ' left to right and ' + b + ' top to bottom' + (limiting ? ', and is the limiting factor' : '') + '.';
    }
    const axis = a ? 'Left to right' : 'Top to bottom', th = a || b;
    return limiting
      ? axis + ' centering exceeds ' + th + ' and is the limiting factor.'
      : pick([axis + ' centering exceeds ' + th + '.', axis + ' centering sits past ' + th + '.']);
  }
  function centeringFactor(c) {
    const a = exceedTh(c.lr, 'lr'), b = exceedTh(c.tb, 'tb');
    if (a && b) return 'off center front placement on both axes';
    if (a) return pick(['off center front left to right placement', 'front left to right centering']);
    if (b) return pick(['off center front top to bottom placement', 'front top to bottom centering']);
    return '';
  }

  // ---------- flaw sentences ----------
  function locName(cat, loc) {
    let l = loc.toLowerCase().replace(/\s*(quad|quadrant|edge|corner)$/i, '').trim();
    return l;
  }
  function groupFlaws(flaws, side) {
    const groups = [];
    for (const f of flaws.filter(f => f.side === side)) {
      const label = (f.label || '').trim(); if (!label || label === 'ignore') continue;
      let g = groups.find(x => x.cat === f.cat && x.label === label);
      if (!g) { g = { cat: f.cat, label, locs: [] }; groups.push(g); }
      g.locs.push(locName(f.cat, f.loc));
    }
    const order = { corners: 0, edges: 1, surface: 2 };
    return groups.sort((a, b) => order[a.cat] - order[b.cat]);
  }
  function groupSentence(g) {
    const n = g.locs.length, L = g.label;
    if (g.cat === 'corners') {
      const noun = n > 1 ? 'corners' : 'corner';
      if (n === 4) return pick([cap(L) + ' at all four corners.', 'All four corners show ' + L + '.', cap(L) + ' present at all four corners.']);
      const locs = joinList(g.locs);
      return pick([cap(L) + ' at the ' + locs + ' ' + noun + '.', cap(L) + ' present at the ' + locs + ' ' + noun + '.', 'The ' + locs + ' ' + noun + (n > 1 ? ' show ' : ' shows ') + L + '.']);
    }
    if (g.cat === 'edges') {
      const noun = n > 1 ? 'edges' : 'edge';
      const run = isPlural(L) ? ' run' : ' runs';
      if (n === 4) return pick([cap(L) + run + ' along all four edges.', cap(L) + ' along all four edges.', 'All four edges show ' + L + '.']);
      const locs = joinList(g.locs);
      return pick([cap(L) + ' along the ' + locs + ' ' + noun + '.', cap(L) + run + ' along the ' + locs + ' ' + noun + '.', 'The ' + locs + ' ' + noun + (n > 1 ? ' show ' : ' shows ') + L + '.']);
    }
    // surface
    const LL = n > 1 ? pluralize(L) : L;
    const noun = n > 1 ? 'quadrants' : 'quadrant';
    if (n === 4) return pick([cap(LL) + ' appear across all four quadrants of the surface.', cap(LL) + ' in all four quadrants of the surface.']);
    const locs = joinList(g.locs);
    const appear = isPlural(LL) ? ' appear' : ' sits';
    const pre = countable(LL) && !isPlural(LL) ? 'A ' + LL : cap(LL);
    return pick([cap(LL) + ' present in the ' + locs + ' ' + noun + ' of the surface.', pre + appear + ' in the ' + locs + ' ' + noun + ' of the surface.', 'The surface shows ' + (countable(LL) && !isPlural(LL) ? 'a ' : '') + LL + ' in the ' + locs + ' ' + noun + '.']);
  }
  function cornerLocs(g) { const n = g.locs.length; return n === 4 ? 'all four corners' : 'the ' + joinList(g.locs) + (n > 1 ? ' corners' : ' corner'); }
  function edgeLocs(g) { const n = g.locs.length; return n === 4 ? 'all four edges' : 'the ' + joinList(g.locs) + (n > 1 ? ' edges' : ' edge'); }
  function sideFlawSentences(groups) {
    let corners = groups.filter(g => g.cat === 'corners');
    let edges = groups.filter(g => g.cat === 'edges');
    const surface = groups.filter(g => g.cat === 'surface');
    const out = [];
    // same label on corners and edges: merge into one sentence
    const merged = [];
    corners.forEach(c => {
      const e = edges.find(x => x.label === c.label);
      if (e && Math.random() < 0.75) {
        merged.push(pick([cap(c.label) + ' at ' + cornerLocs(c) + ' and along ' + edgeLocs(e) + '.', cap(c.label) + ' at ' + cornerLocs(c) + ', with more along ' + edgeLocs(e) + '.']));
        corners = corners.filter(x => x !== c); edges = edges.filter(x => x !== e);
      }
    });
    if (corners.length === 2 && Math.random() < 0.6) {
      const [a, b] = corners;
      out.push(groupSentence(a).replace(/\.$/, '') + ', with ' + b.label + ' at ' + cornerLocs(b) + '.');
    } else corners.forEach(g => out.push(groupSentence(g)));
    out.push(...merged);
    if (edges.length === 2 && Math.random() < 0.6) {
      const [a, b] = edges;
      out.push(cap(a.label) + ' along ' + edgeLocs(a) + ', with ' + b.label + ' along ' + edgeLocs(b) + '.');
    } else edges.forEach(g => out.push(groupSentence(g)));
    surface.forEach(g => out.push(groupSentence(g)));
    return out;
  }
  const CLEAN = [
    'Surface, edges, and corners are clean with no flaws noted.',
    'No flaws noted across the surface, edges, or corners.',
    'Clean throughout with no flaws noted.',
    'The surface, edges, and corners are clean.',
    'Clean throughout, with no flaws on the surface, edges, or corners.'
  ];
  const CLEAN_BACK = ['Clean with no flaws noted.', 'Clean throughout, with no flaws noted.', 'No flaws noted.', 'Clean throughout with no flaws noted.'];
  const CLEAN_DMG = [
    'No damage noted across the surface, edges, or corners.',
    'Surface, edges, and corners show no damage.',
    'No visible damage across the surface, edges, or corners.',
    'Front shows no visible damage on the surface, edges, or corners.'
  ];
  const CLEAN_DMG_BACK = ['Clean with no damage noted.', 'Clean throughout with no damage noted.', 'No visible damage anywhere on this side.', 'Clean, with no visible damage.'];

  // ---------- compliance rules ----------
  function ruleClauses(p, grade) {
    const strict = [], other = [];
    for (const L of p.log) {
      const m = L.match(/^\[(PSA [^\]]+)\]\s*(.+)$/i); if (!m) continue;
      const tag = m[1].replace(/psa holistic rule/i, 'PSA Holistic Rule').replace(/psa strict/i, 'PSA Strict').replace(/psa standard/i, 'PSA Standard');
      let body = m[2].trim().replace(/\.$/, '');
      const sm = body.match(/front\s*(left\/right|top\/bottom)\s*>\s*(\d+\/\d+)/i);
      if (/strict/i.test(tag) && sm) { strict.push({ axis: sm[1].toLowerCase(), th: sm[2] }); continue; }
      body = body.replace(/\s*\(e\.g\.,?[^)]*\)/i, '')
        .replace(/restricts final grade/i, 'restricts the final grade')
        .replace(/\bcaps grade\b/i, 'caps the grade').replace(/\bcap grade\b/i, 'cap the grade')
        .replace(/limits grade/i, 'limits the grade').replace(/ across the card/i, '');
      body = body.charAt(0).toLowerCase() + body.slice(1);
      if (grade != null) body = body.replace(/(PSA |to |at )(\d+(?:\.\d)?)$/i, (all, pre) => pre + fmtGrade(grade));
      other.push({ tag, body });
    }
    const parts = [];
    if (strict.length) {
      const ths = [...new Set(strict.map(s => s.th))];
      // prefer the highest threshold per axis
      const byAxis = {};
      strict.forEach(s => { if (!byAxis[s.axis] || parseInt(s.th) > parseInt(byAxis[s.axis])) byAxis[s.axis] = s.th; });
      const axes = Object.keys(byAxis);
      if (axes.length === 2) {
        const a = byAxis['left/right'], b = byAxis['top/bottom'];
        parts.push(a === b ? 'Per PSA Strict, front left/right and top/bottom both exceed ' + a : 'Per PSA Strict, front left/right exceeds ' + a + ' and top/bottom exceeds ' + b);
      } else parts.push('Per PSA Strict, front ' + axes[0] + ' exceeds ' + byAxis[axes[0]]);
    }
    other.forEach(o => parts.push('Per ' + o.tag + ', ' + o.body));
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0] + '.';
    return parts[0] + ', and ' + parts.slice(1).map(s => s.charAt(0).toLowerCase() + s.slice(1)).join(', and ') + '.';
  }
  function fmtGrade(g) { return String(g).replace(/\.0$/, ''); }
  function gradeVerb(p) {
    const t = p.log.join(' ').toLowerCase();
    if (/restricts final grade/.test(t)) return 'restrict the grade to';
    if (/limits grade/.test(t)) return 'limit the grade to';
    if (/cap/.test(t)) return 'cap the grade at';
    return 'hold the grade at';
  }

  // ---------- pregrade ----------
  function pregrade(p, o) {
    CUR_STRICT = strictFromLog(p);
    const g = o.grade;
    const fGroups = groupFlaws(p.flaws, 'front'), bGroups = groupFlaws(p.flaws, 'back');
    const anyFlaws = fGroups.length + bGroups.length > 0;
    const centerLimited = /centering alignment/i.test(p.log.join(' ')) || (!anyFlaws && !!(exceedTh(p.centering.front.lr, 'lr') || exceedTh(p.centering.front.tb, 'tb')));
    const dmg = o.damageWording;

    const front = [];
    const fs = sideFlawSentences(fGroups);
    if (fs.length) front.push(...fs); else front.push(pick(dmg ? CLEAN_DMG : CLEAN));
    const frontOff = !!(exceedTh(p.centering.front.lr, 'lr') || exceedTh(p.centering.front.tb, 'tb'));
    const ex = g >= 10 ? '' : frontExceedSentence(p.centering.front, centerLimited);
    if (g >= 10 && frontOff) o._skipCenter = true;
    if (ex) front.push(ex);
    if (o.extraFront) front.push(o.extraFront);
    front.push(centeringLine(p.centering.front));

    const back = [];
    const bs = sideFlawSentences(bGroups);
    if (bs.length) back.push(...bs); else back.push(pick(dmg ? CLEAN_DMG_BACK : CLEAN_BACK));
    if (o.extraBack) back.push(o.extraBack);
    back.push(centeringLine(p.centering.back));

    // estimated grade
    const gs = fmtGrade(g) + (o.otherCo && o.otherGrade ? '' : '');
    const gradeLabel = 'PSA ' + fmtGrade(g) + (o.otherCo ? ' (' + o.otherCo + ' ' + fmtGrade(o.otherGrade || g) + ')' : '');
    const opener = pick(['This card grades out to a ' + gradeLabel + ' overall.', 'This card comes in at a ' + gradeLabel + ' overall.', 'This card lands at a ' + gradeLabel + ' overall.', 'This card earns a ' + gradeLabel + ' overall.']);
    let rules = ruleClauses(p, g);
    const warnings = [];
    if (o._skipCenter) warnings.push('Front centering is past 55/45 but the grade is PSA 10. Centering was left out of the limiting factors; double check the grade.');
    if (p.logGrade != null && g != null && p.logGrade !== g) warnings.push('Compliance log points to PSA ' + fmtGrade(p.logGrade) + ' but you set PSA ' + fmtGrade(g) + '. Rule wording was adjusted to your grade; double check it reads right.');
    if (!rules) {
      if (g >= 10) rules = pick(['Per PSA Standard, no tolerance caps apply, and centering on both sides holds within gem mint limits.', 'Per PSA Standard, no tolerance caps were triggered, and centering on both sides is within gem mint range.', 'Per PSA Standard, no tolerance caps apply, with centering on both sides sitting within gem mint range.']);
      else warnings.push('No compliance log found. Add the rule wording in the Estimated Grade box if needed.');
    }
    const estGrade = [opener, rules].filter(Boolean).join(' ');

    // recommendation
    const rec = recommendation(p, o, fGroups, bGroups, warnings);
    return { front: front.join(' '), back: back.join(' '), estGrade, rec, warnings, fGroups, bGroups };
  }

  function conditionFactors(p, fGroups, bGroups) {
    const f = [];
    const cnt = (n, noun) => n === 1 ? null : (n === 4 ? 'all four' : NUMW[n]) + ' ' + noun;
    const add = (groups, sw) => {
      const used = new Set();
      groups.forEach(g => {
        if (used.has(g)) return;
        const n = g.locs.length;
        if (g.cat === 'corners') {
          const cTxt = n === 1 ? 'at the ' + sw + g.locs[0] + ' corner' : 'at ' + cnt(n, sw + 'corners');
          const e = groups.find(x => x.cat === 'edges' && x.label === g.label && !used.has(x));
          if (e) {
            used.add(e);
            const m = e.locs.length;
            f.push(g.label + ' ' + cTxt + ' and along ' + (m === 1 ? 'the ' + e.locs[0] + ' edge' : (m === 4 ? 'all four' : NUMW[m]) + ' edges'));
          } else f.push(g.label + ' ' + cTxt);
        } else if (g.cat === 'edges') {
          f.push(g.label + ' along ' + (n === 1 ? 'the ' + sw + g.locs[0] + ' edge' : cnt(n, sw + 'edges')));
        } else {
          const L = n > 1 ? pluralize(g.label) : g.label;
          f.push((n === 1 && countable(L) && !isPlural(L) ? 'a ' : '') + L + ' on the ' + sw + 'surface');
        }
        used.add(g);
      });
    };
    add(fGroups, 'front ');
    add(bGroups, 'back ');
    const c = centeringFactor(p.centering.front);
    if (c) f.push(c);
    return f;
  }
  function shortFactors(p, fGroups, bGroups) {
    const f = [];
    const add = (groups, sw) => groups.forEach(g => {
      const L = g.label;
      let t;
      if (g.cat === 'corners') t = /white/.test(L) ? 'corner whites' : /soft/.test(L) ? 'corner softness' : /crease|creasing/.test(L) ? 'corner creasing' : 'corner wear';
      else if (g.cat === 'edges') t = /white/.test(L) ? 'edge whites' : /lift/.test(L) ? 'edge lifting' : /dent|indent|tear/.test(L) ? 'edge damage' : 'edge wear';
      else t = 'surface ' + pluralize(L.replace(/^(minor|hairline|micro|major|small) /, ''));
      t = sw + t;
      if (!f.includes(t)) f.push(t);
    });
    add(fGroups, 'front ');
    add(bGroups, 'back ');
    if (exceedTh(p.centering.front.lr, 'lr') || exceedTh(p.centering.front.tb, 'tb')) f.push('front centering');
    return f;
  }

  function recommendation(p, o, fGroups, bGroups, warnings) {
    if (o._skipCenter) p = Object.assign({}, p, { centering: { front: {}, back: p.centering.back } });
    const g = o.grade, gk = fmtGrade(g);
    const raw = o.rawOverride != null ? o.rawOverride : p.prices.raw;
    let tgt = o.targetOverride != null ? o.targetOverride : (p.extraPrices[gk] != null ? p.extraPrices[gk] : p.prices[gk]);
    if (raw == null) warnings.push('Raw value not found. Type it in Raw value override.');
    const parts = [];
    const otherTxt = o.otherCo && o.otherPrice != null ? ' and a ' + o.otherCo + ' ' + fmtGrade(o.otherGrade || g) + ' averaging ' + money(o.otherPrice) : '';
    const rawLabel = o.regrade ? 'Current ' + (o.currentSlab || 'PSA X') + ' value' : 'Raw value';
    const rv = raw != null ? money(raw) : '$X';
    let opener;
    const noData = tgt == null && !o.newSet;
    if (noData) {
      opener = pick([rawLabel + ' sits at ' + rv + '.', rawLabel + ' stands at ' + rv + '.', rawLabel + ' is ' + rv + '.']) + ' No data available for PSA ' + gk + '.';
    } else if (o.newSet && tgt == null) {
      opener = pick([rawLabel + ' sits at ' + rv + '.', rawLabel + ' is ' + rv + '.']) + ' No graded data is available yet for this newly released set.';
    } else {
      const tv = money(tgt);
      opener = pick([
        rawLabel + ' is ' + rv + ' and a PSA ' + gk + ' averages ' + tv + otherTxt + '.',
        rawLabel + ' sits at ' + rv + ' while a PSA ' + gk + ' averages ' + tv + otherTxt + '.',
        rawLabel + ' stands at ' + rv + ' with a PSA ' + gk + ' averaging ' + tv + otherTxt + '.',
        rawLabel + ' is ' + rv + ', compared with ' + tv + ' for a PSA ' + gk + otherTxt + '.'
      ]);
    }
    parts.push(opener);

    // condition sentence
    const factors = conditionFactors(p, fGroups, bGroups);
    const below = tgt != null && raw != null && tgt < raw;
    let cond;
    if (!factors.length) {
      cond = g >= 10
        ? pick(['Neither side shows damage, and centering is within gem mint range.', 'The card is clean on both sides, with centering inside gem mint tolerance.', 'Neither side shows any damage, and centering holds within gem mint tolerance.'])
        : 'Condition factors noted above hold the card at ' + article(g) + ' ' + gk + '.';
    } else {
      const head = factors[0].split(/ at | along | on /)[0];
      const plural = factors.length > 1 || / and /.test(factors[0]) || isPlural(head);
      const verb = !plural ? pick(['keeps the card at', 'holds the card at', 'limits the result to']) : pick(['keep the card at', 'hold the card at']);
      const onlyCenter = factors.length === 1 && /center|centering/.test(factors[0]);
      let s = cap(joinList(factors)) + ' ' + verb + ' ' + article(g) + ' ' + gk;
      if (onlyCenter) s = pick(['The card is clean on both sides, but ', 'Both sides are clean, but ', 'Neither side shows damage, but ']) + factors[0] + ' ' + verb + ' ' + article(g) + ' ' + gk;
      cond = s + (below ? ', which falls below raw value' : '') + '.';
    }
    parts.push(cond);
    if (words(parts.join(' ')) > 38 && factors.length > 1) {
      const sf = shortFactors(p, fGroups, bGroups);
      parts[parts.length - 1] = cap(joinList(sf)) + ' ' + pick(['keep the card at', 'hold the card at']) + ' ' + article(g) + ' ' + gk + (below ? ', which falls below raw value' : '') + '.';
    }

    // decision
    let recd;
    if (o.newSet && tgt == null) recd = true;
    else if (noData) recd = false;
    else if (raw == null) recd = null;
    else recd = (tgt - raw) >= 350;
    if (o.forceRec === 'yes') recd = true; else if (o.forceRec === 'no') recd = false;
    if (o.grail && !recd) parts.push(o.isPack ? 'Slabbing for preservation or personal collection is still worth considering.' : 'As a grail card, grading for personal collection is worth considering.');
    if (o.newSet && tgt == null) parts.push('Grading is highly recommended.');
    else {
      const word = o.regrade ? (o.crossTo ? 'Cross grading to PSA is ' : 'Regrading is ') : 'Grading is ';
      parts.push(word + (recd === false ? 'not recommended.' : recd ? 'recommended.' : 'recommended / not recommended.'));
    }
    if (recd === null) warnings.push('Could not compute the recommendation, raw value missing.');
    return { text: parts.join(' '), recommended: recd, raw, tgt };
  }

  // ---------- authentication: cards ----------
  const GAME_CHECKS = {
    pokemon: ['font', 'text', 'print quality', 'coloration', 'energy symbols', 'copyright', 'set details'],
    yugioh: ['font', 'text', 'print quality', 'coloration', 'set code', 'passcode', 'Eye of Anubis hologram', 'edition markings', 'copyright'],
    mtg: ['font', 'text', 'print quality', 'coloration', 'set symbol', 'collector number', 'card frame', 'copyright'],
    lorcana: ['font', 'text', 'print quality', 'coloration', 'ink symbol', 'rarity symbol', 'set symbol', 'copyright'],
    onepiece: ['font', 'text', 'print quality', 'coloration', 'set details', 'copyright'],
    dragonball: ['font', 'text', 'print quality', 'coloration', 'set details', 'copyright'],
    digimon: ['font', 'text', 'print quality', 'coloration', 'set details', 'copyright'],
    sports: ['print quality', 'coloration', 'font', 'text', 'team logo', 'manufacturer logo', 'league license marks', 'copyright']
  };
  const BACK_LINE = {
    pokemon: 'Card back presents with the correct deep blue gradient matching genuine prints from this era.',
    yugioh: 'Card back presents with the correct brown swirl pattern and logo detail matching genuine prints.',
    mtg: 'Card back presents with the correct design and logo detail matching genuine prints.',
    lorcana: 'Card back presents with the correct design and logo detail matching genuine prints.',
    onepiece: 'Card back presents with the correct design and logo detail matching genuine prints.',
    dragonball: 'Card back presents with the correct design and logo detail matching genuine prints.',
    digimon: 'Card back presents with the correct design and logo detail matching genuine prints.',
    sports: 'Card back print, card number, and manufacturer details match genuine examples.'
  };
  const FOIL = {
    unique: { note: ['The holofoil pattern is unique and consistent with genuine production from this era.', 'Holofoil shows a unique pattern consistent with genuine factory production from this era.', 'The holofoil pattern is unique to this card, in line with genuine production from this era.', 'Holofoil carries a unique pattern consistent with genuine production from this era.', 'The holofoil pattern is unique, as expected from genuine prints of this era.'], why: 'Unique holofoil pattern consistent with era production.', short: 'unique holofoil' },
    textured: { note: ['The textured holofoil matches verified authentic samples of this card.', 'Textured holofoil lines up with verified authentic samples of this card.', 'The textured holofoil is consistent with verified authentic samples of this card.'], why: 'Textured holofoil matches authentic samples.', short: 'textured holofoil', extra: 'surface texture' },
    factory: { note: ['The holofoil is consistent with genuine factory production from this era.', 'Holofoil reflects factory production from this era.', 'The holofoil is consistent with factory production from this era.'], why: 'Holofoil consistent with factory production.', short: 'factory holofoil' },
    reverse: { note: ['The reverse holofoil is consistent with factory production for this set.', 'Reverse holofoil reflects factory production for this set.'], why: 'Reverse holofoil consistent with factory production.', short: 'reverse holofoil' },
    glare: { note: ['Holographic foil and its glare are consistent with factory production and match authentic samples of this card.', 'The holographic foil and its glare match authentic samples and reflect factory production.'], why: 'Holographic foil and glare match authentic samples.', short: 'holographic foil and glare' }
  };
  // group templates: X = item list, pl = plural verb form. usedT avoids repeating a template inside one note
  const TEMPLATES = [
    ['are consistent with genuine production.', 'is consistent with genuine production.'],
    ['match verified authentic examples.', 'matches verified authentic examples.'],
    ['reflect factory output.', 'reflects factory output.'],
    ['line up with verified authentic copies.', 'lines up with verified authentic copies.'],
    ['hold true to genuine prints.', 'holds true to genuine prints.'],
    ['show no deviation from authentic prints.', 'shows no deviation from authentic prints.'],
    ['check out against authentic examples.', 'checks out against authentic examples.'],
    ['are in line with factory production.', 'is in line with factory production.']
  ];
  let usedT = new Set();
  function groupTemplate(X, pl) {
    let idx = TEMPLATES.map((t, i) => i).filter(i => !usedT.has(i));
    if (!idx.length) idx = TEMPLATES.map((t, i) => i);
    const opts = idx.map(i => X + ' ' + TEMPLATES[i][pl ? 0 : 1]);
    const chosen = pick(opts);
    usedT.add(idx[opts.indexOf(chosen)]);
    return chosen;
  }
  function pluralItems(items) { return items.length > 1 || /s$/.test(items[0]) && !/ss$/.test(items[0]); }
  function partition(items) {
    const s = shuffle(items);
    const k = s.length <= 3 ? 1 : (s.length <= 5 ? 2 : 2 + rnd(2));
    const groups = []; let i = 0;
    for (let g = 0; g < k; g++) { const size = g === k - 1 ? s.length - i : Math.max(1, Math.round((s.length - i) / (k - g))); groups.push(s.slice(i, i + size)); i += size; }
    return groups.filter(g => g.length);
  }
  function renderGroups(groups) {
    const sents = [];
    if (groups.length >= 2 && Math.random() < 0.5) {
      const [a, b] = groups;
      const A = cap(joinList(a)), B = joinList(b);
      sents.push(A + (pluralItems(a) ? ' match' : ' matches') + ' verified examples, while ' + B + (pluralItems(b) ? ' reflect' : ' reflects') + ' factory output.');
      usedT.add(1); usedT.add(2);
      groups.slice(2).forEach(g => sents.push(groupTemplate(cap(joinList(g)), pluralItems(g))));
    } else groups.forEach(g => sents.push(groupTemplate(cap(joinList(g)), pluralItems(g))));
    return sents;
  }

  function cardAuth(o) {
    usedT = new Set();
    const game = o.game || 'pokemon';
    let checks = GAME_CHECKS[game].slice();
    if (o.trainer) checks = checks.filter(c => c !== 'energy symbols');
    const foil = o.foil && FOIL[o.foil];
    if (foil && foil.extra) checks.push(foil.extra);
    if (o.rosetteFront) checks = checks.filter(c => c !== 'print quality');
    const groups = partition(checks);
    const mid = renderGroups(groups);
    const pieces = [];
    if (foil) { const fn = pick(foil.note); pieces.push(fn); if (/consistent with/.test(fn)) usedT.add(0); }
    pieces.push(...mid);
    if (o.rosetteFront) pieces.push(pick(['Print quality is consistent with genuine production, with the correct rosette pattern present on the front.', 'Print quality shows the correct rosette pattern on the front, consistent with genuine production.']));
    if (o.stamp) pieces.push(pick(['The ' + o.stamp + ' is factory applied.', 'The ' + o.stamp + ' matches factory application.']));
    if (o.extraAuth) pieces.push(o.extraAuth);
    // shuffle order of body pieces lightly (keep foil either first or second)
    let body = pieces;
    if (Math.random() < 0.5 && body.length > 2) body = [body[1], body[0]].concat(body.slice(2));
    let backS = '';
    if (!o.noBack) {
      backS = o.backLine || BACK_LINE[game];
      if (o.rosetteBack) backS = backS.replace(/\.$/, ', with the rosette pattern found on authentic backs clearly present.');
    }
    const note = body.concat(backS ? [backS] : [], ['No indicators of replication are present.']).join(' ');

    // reasons why (standalone, one line per finding)
    const why = [];
    if (foil) why.push(foil.why);
    const endsPl = shuffle(['consistent with genuine production.', 'match authentic examples.', 'accurate.', 'consistent with factory output.']);
    const endsSg = ['consistent with genuine production.', 'matches authentic examples.', 'accurate.', 'consistent with factory output.'];
    groups.forEach((g, i) => { const e = endsPl[i % endsPl.length]; why.push(cap(joinList(g)) + ' ' + (pluralItems(g) ? e : endsSg[['consistent with genuine production.', 'match authentic examples.', 'accurate.', 'consistent with factory output.'].indexOf(e)])); });
    if (o.rosetteFront) why.push('Print quality with correct rosette pattern on the front.');
    if (o.stamp) why.push(cap(o.stamp) + ' factory applied.');
    if (!o.noBack) why.push(game === 'pokemon' ? 'Back shows correct deep blue gradient' + (o.rosetteBack ? ' with rosette pattern present.' : '.') : 'Back matches genuine prints.');
    // combined list for bundles
    const combo = [];
    if (foil) combo.push(foil.short);
    groups.forEach(g => combo.push(...g));
    if (o.stamp) combo.push(o.stamp);
    if (!o.noBack) combo.push(game === 'pokemon' ? 'deep blue gradient back' + (o.rosetteBack ? ' with rosette' : '') : 'back');
    return { note, why: why.join('\n'), combo };
  }

  // ---------- flag line ----------
  function detectFlags(ai) {
    const t = ai || '';
    return {
      cardDetails: /\b\d{1,3}\/\d{2,3}\b|\b\d{2,3}\s?HP\b|\bHP\s?\d|No\.\s?\d|LV\.|attack|numbering|card number/i.test(t),
      illustrator: /illustrat|credit|illus\./i.test(t),
      year: /\b(19[89]\d|20[0-3]\d)\b/.test(t),
      copyright: /copyright/i.test(t),
      hedge: /resolution|glare|blur|not possible|cannot|limits?\b|limited|microscopic|definitive|confidence|subject to|insufficient|not sufficiently|not legible/i.test(t),
      gradeOpinion: /technical grade|EX-?MT|\bVG\b|\bNM\b|expected highest|PSA\s?\d\s?(–|-|to)\s?\d/i.test(t),
      saidFake: /replica|counterfeit|not authentic|non-authentic|reproduction|\bfake\b/i.test(t)
    };
  }
  function flagLine(o, itemWord) {
    const f = o.flags || {};
    if (!o.aiNote && !o.flagsManual) return 'No AI note provided. Authentication written from reviewer findings.';
    const refs = [];
    if (f.cardDetails) refs.push('card details');
    if (f.illustrator) refs.push('the illustrator credit');
    if (f.year) refs.push('the year');
    if (f.copyright) refs.push('the copyright line');
    const ident = o.identity ? ' It is **' + o.identity + '**.' : '';
    if (f.saidFake) {
      let s = 'AI incorrectly flagged this ' + itemWord + ' as fake' + (o.flagReason ? ' ' + o.flagReason : '');
      if (refs.length) s += ', and references ' + joinList(refs);
      return s + '.' + ident + ' Verified authentic.';
    }
    const acts = [];
    if (refs.length) acts.push((f.cardDetails ? 'lists ' : 'references ') + joinList(refs));
    if (f.hedge) acts.push('hedges on image quality');
    if (f.gradeOpinion) acts.push('adds a grading opinion not supported by review');
    if (o.flagReason) acts.push(o.flagReason);
    if (!acts.length) return 'AI note rewritten to Validoe standard.' + ident;
    const actTxt = acts.length >= 2 ? acts.slice(0, -1).join(', ') + ', and ' + acts[acts.length - 1] : acts[0];
    return 'AI note ' + actTxt + '.' + ident + ' Removed and rewritten.';
  }

  // ---------- packs / boxes / slabs ----------
  function packAuth(o) {
    const c1 = shuffle([
      pick(['Product matches the official release, and wrapper print and coloration are consistent with genuine factory packs.', 'Wrapper print and coloration are consistent with genuine factory packs, and the product matches the official release.']),
      pick(['Holo elements, spelling, logos, and copyright match authentic examples.', 'Spelling, logos, copyright, and holo elements line up with authentic examples.'])
    ]).concat([pick(['Top and bottom crimping matches the pattern found on genuine sealed packs.', 'Top and bottom crimping is consistent with factory sealing.'])]);
    const c2 = shuffle([
      pick(['The back vertical seal is even and consistent with factory sealing.', 'Back vertical seal remains intact and matches factory sealing.']),
      pick(['Barcode and wrapper fit match genuine sealed packs.', 'Wrapper fit and barcode are consistent with authentic sealed production.'])
    ]).concat(['No indicators of replication are present.']);
    const why = ['Product match, wrapper print, and coloration consistent with genuine packs.', 'Holo elements, spelling, logos, and copyright correct.', 'Top and bottom crimping consistent with factory sealing.', 'Back vertical seal consistent with factory sealing.', 'Barcode and wrapper fit match genuine packs.'];
    return { c1: c1.join(' '), c2: c2.join(' '), why: why.join('\n') };
  }
  function boxAuth(o) {
    const codes = o.qr ? 'Barcode, product codes, and QR code' : 'Barcodes and product codes';
    const c1 = [pick(['Product matches the official release, and print quality, coloration, and spelling are consistent with genuine factory packaging.', 'Print quality and coloration are consistent with genuine factory packaging, and the product matches the official release.'])].concat(shuffle([
      pick(['Logos and trademark markings align with authentic examples.', 'Spelling, logos, FSC, and trademark markings match authentic examples.']),
      pick([codes + ' are correct and properly placed.', codes + ' match factory application.'])
    ]));
    const c2 = [
      pick(['Shrink wrap is applied smoothly and evenly, with seams consistent with factory sealing.', 'Shrink wrap presents smooth and even, with seams consistent with factory sealing.', 'Shrink wrap is smooth and evenly applied, with corners and seams consistent with factory sealing.']),
      pick(['Flaps and perforation match genuine box construction.', 'Flaps and perforation reflect genuine box construction.', 'Flaps and perforation align with genuine construction throughout.']),
      'No indicators of replication are present.'
    ];
    const why = ['Product match, print quality, and coloration consistent with genuine packaging.', 'Spelling, logos, and trademark markings correct.', codes + ' correct.', 'Shrink wrap smooth and even with factory seams.', 'Flaps and perforation consistent with genuine construction.'];
    return { c1: c1.join(' '), c2: c2.join(' '), why: why.join('\n') };
  }
  function slabAuth(o) {
    const co = o.slabCo || 'PSA';
    const c1 = [pick(['Slab construction, label print, and holder security features match authentic ' + co + ' examples.', 'The ' + co + ' holder, label print, and security features are consistent with authentic slabs.']),
      pick(['The cert number is verified in the ' + co + ' database.', 'Cert number checks out in the ' + co + ' database.'])];
    if (o.oldSlab) c1.push('The older holder design without a photo, QR code, or holo sticker is expected for this era.');
    const c2 = 'The database information and photo match the submitted photos confirming the card inside is authentic and has not been swapped.';
    const why = ['Slab construction and label match authentic ' + co + ' holders.', 'Cert number verified in the ' + co + ' database.', 'Database photo and information match the card inside.'];
    return { c1: c1.join(' '), c2, why: why.join('\n') };
  }

  // ---------- top level ----------
  function generate(p, o) {
    pendingHist = [];
    const res = { sections: [], warnings: [] };
    const add = (title, text) => res.sections.push({ title, text });
    const itemWord = { card: 'card', pack: 'pack', box: 'box', etb: 'box', slab: 'slab' }[o.item] || 'card';
    const fo = Object.assign({}, o, { aiNote: p.aiNote });

    if (o.mode === 'auth') {
      add('Flag', flagLine(fo, itemWord));
      if (o.item === 'card') {
        const a = cardAuth(o);
        add('Corrected Authentication Note', a.note);
        add('Reasons Why', a.why);
      } else {
        const a = o.item === 'pack' ? packAuth(o) : o.item === 'slab' ? slabAuth(o) : boxAuth(o);
        add('Corrected Comment 1', a.c1);
        add('Corrected Comment 2', a.c2);
        add('Reasons Why', a.why);
      }
    } else {
      if (o.grade == null) { res.warnings.push('Set the grade first.'); return res; }
      const pg = pregrade(p, o);
      res.warnings.push(...pg.warnings);
      if (o.mode === 'bundle') {
        add('Flag', flagLine(fo, itemWord));
        const a = cardAuth(o);
        add('Front Comment', pg.front);
        add('Back Comment', pg.back);
        add('Estimated Grade', a.note + ' ' + pg.estGrade);
        add('Grading Recommendation', pg.rec.text);
        const factors = shortFactors(p, pg.fGroups, pg.bGroups);
        let tail;
        if (!factors.length && o.grade >= 10) tail = 'no damage and centering within gem mint limits support a PSA 10.';
        else if (!factors.length) tail = 'condition factors ' + gradeVerb(p) + ' PSA ' + fmtGrade(o.grade) + '.';
        else {
          let v = gradeVerb(p);
          if (factors.length === 1) v = v.replace(/^restrict /, 'restricts ').replace(/^limit /, 'limits ').replace(/^cap /, 'caps ').replace(/^hold /, 'holds ');
          tail = joinList(factors) + ' ' + v + ' PSA ' + fmtGrade(o.grade) + '.';
        }
        add('Reasons Why', cap(joinList(a.combo)) + ' all consistent with genuine production; ' + tail);
      } else {
        add('Front Comment', pg.front);
        add('Back Comment', pg.back);
        add('Estimated Grade', pg.estGrade);
        add('Grading Recommendation', pg.rec.text);
      }
      res.recommended = pg.rec.recommended;
    }
    // global no dash safety
    res.sections.forEach(s => { s.text = s.text.replace(/\s[—–-]\s/g, ', ').replace(/—/g, ', '); });
    commitHistory();
    return res;
  }

  const api = { parse, generate, centeringFrom, detectFlags, clearHistory, words, autoLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VRB = api;
})(typeof window !== 'undefined' ? window : globalThis);
