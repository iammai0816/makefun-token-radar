// Token Radar dashboard: renders window.RADAR (written by main.ts as data.js).
// Board of pre-token protocols, detail view per row, filters + sorting, and a
// separate live-token table. No network, no framework, no external assets.
(function () {
  var D = window.RADAR;
  if (!D) { document.body.innerHTML = '<p style="padding:30px">Radar data (data.js) did not load.</p>'; return; }
  var rows = D.rows, live = D.live;

  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function pct(v) {
    if (v == null) return '<span>—</span>';
    var c = v >= 0 ? 'up' : 'down';
    return '<span class="' + c + '">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function age(a) {
    if (a == null) return '—';
    if (a < 30) return a + 'd';
    if (a < 365) return Math.round(a / 30) + 'mo';
    return (a / 365).toFixed(1) + 'y';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Header stats + model line.
  var top = rows[0];
  document.getElementById('stats').innerHTML =
    '<div class="stat"><b>' + rows.length + '</b><span>pre-token rows</span></div>' +
    '<div class="stat"><b>' + rows.filter(function (r) { return r.watchlist; }).length + '</b><span>watchlist covered</span></div>' +
    '<div class="stat"><b>' + money(top.implied_value_usd) + '</b><span>top implied value</span></div>' +
    '<div class="stat"><b>' + live.length + '</b><span>live tokens apart</span></div>';
  document.getElementById('model-text').innerHTML =
    '<code>implied = TVL × 0.30 × category × growth × maturity × breadth</code> — growth from the 7-day TVL change (clamped −50%…+100%), ' +
    'maturity from how long the protocol has run with no token (unknown age counts as 180 days), breadth from the number of chains, ' +
    'and a small category weight. Same formula for every row; no protocol is named in the model.';
  document.getElementById('asof').textContent = D.meta.as_of;

  // Filter options.
  function fill(sel, values) {
    var el = document.getElementById(sel);
    values.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o); });
  }
  fill('cat', Array.from(new Set(rows.map(function (r) { return r.category; }).filter(Boolean))).sort());
  fill('chain', Array.from(new Set(rows.flatMap(function (r) { return r.chains; }))).sort());

  var q = document.getElementById('q'), cat = document.getElementById('cat'),
      chain = document.getElementById('chain'), status = document.getElementById('status'),
      sort = document.getElementById('sort'), tbody = document.getElementById('rows'),
      empty = document.getElementById('empty'), count = document.getElementById('count'),
      boardSec = document.querySelector('.board-wrap'), liveSec = document.getElementById('live-sec');

  var sortKey = 'value';
  var selected = null;

  function filtered() {
    var term = q.value.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (cat.value && r.category !== cat.value) return false;
      if (chain.value && r.chains.indexOf(chain.value) < 0) return false;
      if (term && (r.name + ' ' + r.slug).toLowerCase().indexOf(term) < 0) return false;
      return true;
    });
    var by = {
      value: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); },
      name: function (a, b) { return a.name.localeCompare(b.name); },
      rank: function (a, b) { return a.rank - b.rank; }
    }[sortKey] || function (a, b) { return a.rank - b.rank; };
    return list.slice().sort(by);
  }

  function render() {
    var isLive = status.value === 'live';
    boardSec.style.display = isLive ? 'none' : '';
    liveSec.style.display = isLive ? '' : 'none';
    if (isLive) { count.textContent = live.length + ' live-token protocols'; return; }
    var list = filtered();
    count.textContent = list.length + ' of ' + rows.length + ' protocols';
    empty.hidden = list.length > 0;
    tbody.innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td>' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b>' + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') +
        '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + age(r.age_days) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td></tr>';
    }).join('');
  }

  function showDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    selected = slug;
    var m = r.model;
    document.getElementById('detail').innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="val">' + money(r.implied_value_usd) + ' implied value · rank #' + r.rank + '</p>' +
      '<dl>' +
      '<dt>Token status</dt><dd><b>Pre-token</b> — the snapshot records no token (no market cap, no CoinGecko id, no symbol)' + (r.watchlist ? ' · on the watchlist' : '') + '</dd>' +
      '<dt>Category</dt><dd>' + esc(r.category || '—') + '</dd>' +
      '<dt>Chains</dt><dd>' + esc(r.chains.join(', ')) + '</dd>' +
      '<dt>TVL</dt><dd>' + money(r.tvl_usd) + '</dd>' +
      '<dt>7-day change</dt><dd>' + (r.change_7d == null ? 'not reported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + '</dd>' +
      '<dt>Listed</dt><dd>' + (r.listed_at || 'not reported') + (r.age_days != null ? ' (' + age(r.age_days) + ' ago)' : '') + '</dd>' +
      '</dl>' +
      '<h3>How the value is built</h3>' +
      '<dl><dt>Base</dt><dd>TVL × 0.30</dd>' +
      '<dt>Category</dt><dd>× ' + m.category_multiplier + '</dd>' +
      '<dt>Growth</dt><dd>× ' + m.growth_multiplier + ' (' + m.growth_pct + '% over 7d)</dd>' +
      '<dt>Maturity</dt><dd>× ' + m.maturity_multiplier + ' (' + (m.age_days == null ? 'age unknown, 180 days assumed' : m.age_days + ' days') + ')</dd>' +
      '<dt>Breadth</dt><dd>× ' + m.breadth_multiplier + ' (' + r.chains.length + ' chains)</dd></dl>' +
      '<h3>Farm plan — what to do, what it costs, how long it takes</h3>' +
      '<ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="fine">A farm plan positions for a possible future token, if one is ever issued. It never claims a token exists or will exist.</p>';
    tbody.querySelectorAll('tr').forEach(function (tr) { tr.classList.toggle('sel', tr.dataset.slug === slug); });
  }

  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr) showDetail(tr.dataset.slug);
  });
  document.querySelectorAll('#board th').forEach(function (th) {
    th.addEventListener('click', function () {
      var map = { rank: 'rank', name: 'name', category: 'rank', chains: 'rank', tvl: 'tvl', growth: 'growth', age: 'age', value: 'value' };
      sortKey = map[th.dataset.k] || 'value';
      sort.value = sortKey in { value: 1, tvl: 1, growth: 1, age: 1, name: 1 } ? sortKey : 'value';
      render();
    });
  });
  [q, cat, chain, status, sort].forEach(function (el) {
    el.addEventListener('input', function () { sortKey = sort.value; render(); });
    el.addEventListener('change', function () { sortKey = sort.value; render(); });
  });

  // Live-token table (kept apart from the ranking).
  document.getElementById('live-rows').innerHTML = live.map(function (p) {
    return '<tr><td><b>' + esc(p.name) + '</b><br><span class="slug">' + esc(p.slug) + '</span></td>' +
      '<td>' + esc(p.category || '—') + '</td><td>' + esc(p.chains.slice(0, 3).join(', ')) + '</td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + pct(p.change_7d) + '</td>' +
      '<td class="num"><b>' + money(p.mcap_usd) + '</b></td></tr>';
  }).join('');

  render();
  showDetail(rows[0].slug);
})();
