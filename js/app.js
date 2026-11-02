/**
 * VigilXplr — Main application
 * Interactive NTSB / FAA / FRA mishap intelligence dashboard.
 */
(function () {
  'use strict';

  const state = {
    events: [],
    filtered: [],
    selectedId: null,
    map: null,
    markers: null,
    mode: 'all',
    severity: 'all',
    status: 'all',
    dateFrom: null,
    dateTo: null,
    query: '',
    sortKey: 'date',
    sortDir: -1,
    lastKnownIds: new Set()
  };

  const els = {};

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  function initDom() {
    els.status = $('#dataStatus');
    els.lastUpdate = $('#lastUpdate');
    els.btnRefresh = $('#btnRefresh');
    els.btnAlerts = $('#btnAlerts');
    els.btnTheme = $('#btnTheme');
    els.modeFilters = $('#modeFilters');
    els.severityFilters = $('#severityFilters');
    els.statusFilter = $('#statusFilter');
    els.dateFrom = $('#dateFrom');
    els.dateTo = $('#dateTo');
    els.searchInput = $('#searchInput');
    els.mapSearchInput = $('#mapSearchInput');
    els.mapSearchClear = $('#mapSearchClear');
    els.btnApply = $('#btnApplyFilters');
    els.btnReset = $('#btnResetFilters');
    els.statTotal = $('#statTotal');
    els.statFatal = $('#statFatal');
    els.statOpen = $('#statOpen');
    els.statAviation = $('#statAviation');
    els.eventsBody = $('#eventsBody');
    els.resultCount = $('#resultCount');
    els.btnExport = $('#btnExport');
    els.detailEmpty = $('#detailEmpty');
    els.detailContent = $('#detailContent');
    els.detailTitle = $('#detailTitle');
    els.detailMode = $('#detailMode');
    els.detailMeta = $('#detailMeta');
    els.detailSummary = $('#detailSummary');
    els.detailInjuries = $('#detailInjuries');
    els.detailStatus = $('#detailStatus');
    els.detailCause = $('#detailCause');
    els.detailLinks = $('#detailLinks');
    els.detailVehicle = $('#detailVehicle');
    els.toastContainer = $('#toastContainer');
  }

  function setStatus(live, label) {
    els.status.classList.remove('live', 'error');
    if (live) els.status.classList.add('live');
    else if (label && label.toLowerCase().includes('error')) els.status.classList.add('error');
    els.status.querySelector('.label').textContent = label || (live ? 'Live' : 'Offline');
  }

  function formatDate(d) {
    if (!d) return '—';
    try {
      const dt = new Date(d + (d.length === 10 ? 'T12:00:00Z' : ''));
      return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return d; }
  }

  function severityClass(s) {
    if (!s) return 'none';
    const l = s.toLowerCase();
    if (l.includes('fatal')) return 'fatal';
    if (l.includes('serious')) return 'serious';
    if (l.includes('minor')) return 'minor';
    return 'none';
  }

  function modeClass(m) {
    if (!m) return 'other';
    const l = m.toLowerCase();
    if (l.includes('aviation')) return 'aviation';
    if (l.includes('rail')) return 'railroad';
    if (l.includes('highway')) return 'highway';
    return 'other';
  }

  function loadData() {
    // Prefer live data/events.json (updated by GitHub Action); fall back to seed
    return fetch('data/events.json?t=' + Date.now())
      .then(r => {
        if (!r.ok) throw new Error('no live file');
        return r.json();
      })
      .then(json => {
        if (json && Array.isArray(json.events) && json.events.length) {
          setStatus(true, 'Live data');
          els.lastUpdate.textContent = 'Updated ' + (json.meta?.generated
            ? new Date(json.meta.generated).toLocaleString()
            : 'recently');
          return json.events;
        }
        throw new Error('empty');
      })
      .catch(() => {
        setStatus(true, 'Seed data');
        els.lastUpdate.textContent = 'Sample dataset';
        return (window.VIGIL_SEED && window.VIGIL_SEED.events) || [];
      });
  }

  function detectNewEvents(events) {
    const currentIds = new Set(events.map(e => e.id || e.ntsbNum));
    if (state.lastKnownIds.size === 0) {
      state.lastKnownIds = currentIds;
      return;
    }
    const newOnes = events.filter(e => !state.lastKnownIds.has(e.id || e.ntsbNum));
    newOnes.forEach(e => {
      toast(`New ${e.mode || 'event'}: ${e.ntsbNum}`, e.summary || e.highestInjury, severityClass(e.highestInjury));
      if (window.VigilAlerts) window.VigilAlerts.playNewEvent(e.highestInjury);
    });
    state.lastKnownIds = currentIds;
  }

  function toast(title, body, sev) {
    const t = document.createElement('div');
    t.className = 'toast ' + (sev || '');
    t.innerHTML = `<strong>${escapeHtml(title)}</strong>${body ? escapeHtml(body).slice(0, 120) : ''}`;
    els.toastContainer.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function applyFilters() {
    let list = state.events.slice();

    if (state.mode !== 'all') {
      list = list.filter(e => (e.mode || '').toLowerCase().includes(state.mode.toLowerCase()));
    }
    if (state.severity !== 'all') {
      list = list.filter(e => severityClass(e.highestInjury) === severityClass(state.severity));
    }
    if (state.status !== 'all') {
      list = list.filter(e => {
        const s = (e.status || e.reportStatus || '').toLowerCase();
        const f = state.status.toLowerCase();
        if (f === 'final') return s.includes('final') || s.includes('closed');
        if (f === 'open') return s.includes('open') || s.includes('preliminary') || s.includes('factual');
        return s.includes(f);
      });
    }
    if (state.dateFrom) {
      list = list.filter(e => (e.eventDate || '') >= state.dateFrom);
    }
    if (state.dateTo) {
      list = list.filter(e => (e.eventDate || '') <= state.dateTo);
    }
    if (state.query) {
      const q = state.query.toLowerCase().trim();
      const terms = q.split(/\s+/).filter(Boolean);
      list = list.filter(e => {
        const hay = [
          e.ntsbNum, e.id, e.city, e.state, e.country, e.make, e.model, e.reg,
          e.operator, e.summary, e.probableCause, e.mode, e.status,
          e.reportStatus, e.highestInjury, e.phase, e.weather, e.eventType,
          e.region, e.aircraftDamage, String(e.mkey || '')
        ].join(' ').toLowerCase();
        // All terms must match (AND) for multi-word; supports full-text narrative search
        return terms.every(t => hay.includes(t));
      });
    }

    // sort
    list.sort((a, b) => {
      let av, bv;
      switch (state.sortKey) {
        case 'date': av = a.eventDate || ''; bv = b.eventDate || ''; break;
        case 'ntsbNum': av = a.ntsbNum || ''; bv = b.ntsbNum || ''; break;
        case 'mode': av = a.mode || ''; bv = b.mode || ''; break;
        case 'location': av = (a.city || '') + (a.state || ''); bv = (b.city || '') + (b.state || ''); break;
        case 'severity': av = a.highestInjury || ''; bv = b.highestInjury || ''; break;
        case 'status': av = a.status || ''; bv = b.status || ''; break;
        default: av = a.eventDate || ''; bv = b.eventDate || '';
      }
      if (av < bv) return -1 * state.sortDir;
      if (av > bv) return 1 * state.sortDir;
      return 0;
    });

    state.filtered = list;
    renderStats();
    renderTable();
    renderMap();
  }

  function renderStats() {
    const list = state.filtered;
    els.statTotal.textContent = list.length;
    els.statFatal.textContent = list.filter(e => severityClass(e.highestInjury) === 'fatal').length;
    els.statOpen.textContent = list.filter(e => {
      const s = (e.status || '').toLowerCase();
      return s.includes('open') || s.includes('preliminary') || s.includes('factual');
    }).length;
    els.statAviation.textContent = list.filter(e => (e.mode || '').toLowerCase().includes('aviation')).length;
    els.resultCount.textContent = list.length + ' event' + (list.length !== 1 ? 's' : '');
  }

  function renderTable() {
    const tbody = els.eventsBody;
    tbody.innerHTML = '';
    state.filtered.forEach(e => {
      const tr = document.createElement('tr');
      if ((e.id || e.ntsbNum) === state.selectedId) tr.classList.add('selected');
      tr.dataset.id = e.id || e.ntsbNum;
      const loc = [e.city, e.state, e.country].filter(Boolean).join(', ');
      tr.innerHTML = `
        <td>${formatDate(e.eventDate)}</td>
        <td><code>${escapeHtml(e.ntsbNum || '—')}</code></td>
        <td><span class="badge ${modeClass(e.mode)}">${escapeHtml(e.mode || '—')}</span></td>
        <td title="${escapeHtml(loc)}">${escapeHtml(loc || '—')}</td>
        <td><span class="sev ${severityClass(e.highestInjury)}">${escapeHtml(e.highestInjury || '—')}</span></td>
        <td>${escapeHtml(e.status || e.reportStatus || '—')}</td>
        <td title="${escapeHtml(e.summary || '')}">${escapeHtml((e.summary || '—').slice(0, 80))}</td>
      `;
      tr.addEventListener('click', () => selectEvent(e.id || e.ntsbNum));
      tbody.appendChild(tr);
    });
  }

  function colorForMode(m) {
    const c = modeClass(m);
    if (c === 'aviation') return '#3b82f6';
    if (c === 'railroad') return '#a855f7';
    if (c === 'highway') return '#f59e0b';
    return '#64748b';
  }

  function validCoord(lat, lon) {
    return typeof lat === 'number' && typeof lon === 'number'
      && isFinite(lat) && isFinite(lon)
      && lat >= -85 && lat <= 85
      && lon >= -180 && lon <= 180
      && !(lat === 0 && lon === 0);
  }

  function renderMap() {
    if (!state.map) return;
    // Fix collapsed map after layout changes
    setTimeout(() => { try { state.map.invalidateSize(true); } catch (_) {} }, 50);

    if (state.markers) {
      state.markers.clearLayers();
    } else {
      state.markers = (typeof L.markerClusterGroup === 'function')
        ? L.markerClusterGroup({ maxClusterRadius: 45, spiderfyOnMaxZoom: true, showCoverageOnHover: false, disableClusteringAtZoom: 10 })
        : L.layerGroup();
      state.map.addLayer(state.markers);
    }

    const bounds = [];
    state.filtered.forEach(e => {
      const lat = Number(e.lat);
      const lon = Number(e.lon);
      if (!validCoord(lat, lon)) return;
      const color = colorForMode(e.mode);
      const icon = L.divIcon({
        className: '',
        html: `<div class="marker-pin" style="background:${color}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
      const m = L.marker([lat, lon], { icon });
      const loc = [e.city, e.state].filter(Boolean).join(', ');
      m.bindPopup(`
        <strong>${escapeHtml(e.ntsbNum)}</strong><br/>
        ${escapeHtml(e.mode)} · ${formatDate(e.eventDate)}<br/>
        ${escapeHtml(loc)}<br/>
        <span class="sev ${severityClass(e.highestInjury)}">${escapeHtml(e.highestInjury || '')}</span>
        <br/><a href="#" data-select="${e.id || e.ntsbNum}">View details →</a>
      `);
      m.on('click', () => selectEvent(e.id || e.ntsbNum));
      m.on('popupopen', (ev) => {
        const a = ev.popup.getElement().querySelector('[data-select]');
        if (a) a.addEventListener('click', (ev2) => {
          ev2.preventDefault();
          selectEvent(a.dataset.select);
        });
      });
      state.markers.addLayer(m);
      bounds.push([lat, lon]);
    });

    // Only auto-fit when the filtered set is a reasonable geographic region
    // (avoids world-scale zoom-out that collapses the map view)
    if (bounds.length > 0 && !state.selectedId) {
      try {
        const latLngBounds = L.latLngBounds(bounds);
        const ne = latLngBounds.getNorthEast();
        const sw = latLngBounds.getSouthWest();
        const spanLat = Math.abs(ne.lat - sw.lat);
        const spanLon = Math.abs(ne.lng - sw.lng);
        if (spanLat < 80 && spanLon < 160 && bounds.length < 3000) {
          state.map.fitBounds(latLngBounds, { padding: [40, 40], maxZoom: 7 });
        } else {
          // Default US overview for large / global sets
          state.map.setView([39.5, -98.3], 4);
        }
      } catch (_) {
        state.map.setView([39.5, -98.3], 4);
      }
    }
  }

  function selectEvent(id) {
    state.selectedId = id;
    const e = state.events.find(x => (x.id || x.ntsbNum) === id);
    if (!e) return;

    els.detailEmpty.classList.add('hidden');
    els.detailContent.classList.remove('hidden');

    els.detailTitle.textContent = e.ntsbNum || id;
    els.detailMode.textContent = e.mode || '—';
    els.detailMode.className = 'badge ' + modeClass(e.mode);

    const meta = [];
    meta.push(`<span>${formatDate(e.eventDate)}${e.eventTime ? ' · ' + e.eventTime : ''}</span>`);
    const loc = [e.city, e.state, e.country].filter(Boolean).join(', ');
    if (loc) meta.push(`<span>${escapeHtml(loc)}</span>`);
    if (e.eventType) meta.push(`<span>${escapeHtml(e.eventType)}</span>`);
    if (e.region) meta.push(`<span>${escapeHtml(e.region)}</span>`);
    if (e.phase) meta.push(`<span>${escapeHtml(e.phase)}</span>`);
    els.detailMeta.innerHTML = meta.join('');

    const setText = (el, text, emptyMsg) => {
      if (!el) return;
      const t = (text || '').trim();
      if (!t || t === 'Under investigation.' || t === '—') {
        el.textContent = emptyMsg || 'Not available for this case.';
        el.classList.add('muted-empty');
      } else {
        el.textContent = t;
        el.classList.remove('muted-empty');
      }
    };
    const kv = (rows) => rows.filter(r => r[1] != null && r[1] !== '' && r[1] !== '—')
      .map(([k, v]) => `<div class="kv-row"><span class="kv-k">${escapeHtml(k)}</span><span class="kv-v">${escapeHtml(String(v))}</span></div>`)
      .join('') || '<span class="muted-empty">No data</span>';

    setText(els.detailSummary, e.summary || e.prelimNarrative || e.factualNarrative, 'No summary available.');

    els.detailInjuries.innerHTML = `
      <div><strong>${e.fatal ?? 0}</strong> Fatal</div>
      <div><strong>${e.serious ?? 0}</strong> Serious</div>
      <div><strong>${e.minor ?? 0}</strong> Minor</div>
      <div><strong>${e.uninjured ?? 0}</strong> Uninjured</div>
    `;
    const dmg = document.getElementById('detailDamage');
    if (dmg) dmg.textContent = e.aircraftDamage ? ('Damage: ' + e.aircraftDamage) : '';

    els.detailStatus.textContent = e.status || e.reportStatus || '—';
    const cls = document.getElementById('detailClass');
    if (cls) cls.textContent = [e.investigationClass, e.reportType].filter(Boolean).join(' · ');

    setText(document.getElementById('detailPrelim'), e.prelimNarrative || e.preliminaryNarrative, 'No preliminary narrative on file.');
    setText(document.getElementById('detailFactual'), e.factualNarrative || e.analysisNarrative || e.concatenatedFactualNarrative, 'No factual/analysis narrative on file.');
    setText(els.detailCause, e.probableCause, 'Probable cause not yet published / under investigation.');

    const findingsEl = document.getElementById('detailFindings');
    if (findingsEl) {
      const findings = e.findings || e.findingsList || [];
      if (Array.isArray(findings) && findings.length) {
        findingsEl.innerHTML = findings.map(f => {
          if (typeof f === 'string') return `<div class="finding-item">${escapeHtml(f)}</div>`;
          const text = f.text || f.description || f.tier4Name || f.tier3Name || '';
          const pc = f.inProbableCause ? ' <span class="tag-pc">probable cause</span>' : '';
          return text ? `<div class="finding-item">${escapeHtml(text)}${pc}</div>` : '';
        }).join('');
      } else findingsEl.innerHTML = '';
    }

    const vehicleEl = document.getElementById('detailVehicle');
    if (vehicleEl) {
      vehicleEl.innerHTML = kv([
        ['Make', e.make], ['Model', e.model], ['Registration', e.reg],
        ['Operator', e.operator], ['Damage', e.aircraftDamage],
        ['Category', e.aircraftCategory],
      ]);
    }
    const flightEl = document.getElementById('detailFlight');
    if (flightEl) {
      flightEl.innerHTML = kv([
        ['Phase of flight', e.phase],
        ['Flight type', e.flightOperationType || e.flightType],
        ['Regulation', e.regulationFlightConductedUnder],
        ['Departure', e.departureCity || e.departureAirport],
        ['Destination', e.destinationCity || e.destinationAirport],
      ]);
    }
    const wxEl = document.getElementById('detailWeather');
    if (wxEl) {
      wxEl.innerHTML = kv([
        ['Condition', e.weather || e.accidentSiteCondition],
        ['Visibility', e.visibilitySm != null ? e.visibilitySm + ' sm' : null],
        ['Wind', e.windSpeedKts != null ? e.windSpeedKts + ' kt' : null],
        ['Light', e.daylightCondition],
      ]);
    }

    const links = [];
    const ntsb = e.ntsbNum || '';
    if (e.docketUrl) links.push(`<a href="${escapeHtml(e.docketUrl)}" target="_blank" rel="noopener">Accident Docket</a>`);
    if (e.reportUrl) links.push(`<a href="${escapeHtml(e.reportUrl)}" target="_blank" rel="noopener">Investigation / Final Report</a>`);
    if (e.investigationPage) links.push(`<a href="${escapeHtml(e.investigationPage)}" target="_blank" rel="noopener">NTSB Investigation Page</a>`);
    if (ntsb) {
      links.push(`<a href="https://data.ntsb.gov/Docket/?ProjectID=${encodeURIComponent(ntsb)}" target="_blank" rel="noopener">Open Docket (${escapeHtml(ntsb)})</a>`);
    }
    links.push(`<a href="https://data.ntsb.gov/carol-main-public/basic-search" target="_blank" rel="noopener">NTSB CAROL Search</a>`);
    if ((e.mode || '').toLowerCase().includes('rail')) {
      links.push(`<a href="https://data.transportation.gov/stories/s/FRA-Safety-Data-Landing-Page/dakf-i7zd/" target="_blank" rel="noopener">FRA Safety Data</a>`);
    }
    els.detailLinks.innerHTML = links.join('');

    // highlight row + fly map
    $$('#eventsBody tr').forEach(tr => {
      tr.classList.toggle('selected', tr.dataset.id === id);
    });
    if (e.lat != null && e.lon != null && state.map) {
      state.map.flyTo([e.lat, e.lon], Math.max(state.map.getZoom(), 7), { duration: 0.6 });
    }

    // mobile detail open
    const side = $('#detailSidebar');
    if (side && window.innerWidth <= 1200) side.classList.add('open');
  }

  function initMap() {
    state.map = L.map('map', {
      center: [39.5, -98.3],
      zoom: 4,
      zoomControl: false,
      attributionControl: true,
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: false
    });
    L.control.zoom({ position: 'topleft' }).addTo(state.map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
      subdomains: 'abc',
      noWrap: false
    }).addTo(state.map);

    // Critical: Leaflet needs a real pixel size; reflow after flex layout settles
    const fixSize = () => { try { state.map.invalidateSize(true); } catch (_) {} };
    setTimeout(fixSize, 100);
    setTimeout(fixSize, 400);
    window.addEventListener('resize', fixSize);
  }

  function bindEvents() {
    els.modeFilters.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.chip');
      if (!btn) return;
      $$('#modeFilters .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      applyFilters();
    });

    els.severityFilters.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.chip');
      if (!btn) return;
      $$('#severityFilters .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      state.severity = btn.dataset.sev;
      applyFilters();
    });

    els.statusFilter.addEventListener('change', () => {
      state.status = els.statusFilter.value;
      applyFilters();
    });

    els.btnApply.addEventListener('click', () => {
      state.dateFrom = els.dateFrom.value || null;
      state.dateTo = els.dateTo.value || null;
      state.query = (els.searchInput.value || '').trim();
      if (els.mapSearchInput) els.mapSearchInput.value = state.query;
      if (els.mapSearchClear) els.mapSearchClear.classList.toggle('visible', !!state.query);
      applyFilters();
    });

    els.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        state.query = (els.searchInput.value || '').trim();
        if (els.mapSearchInput) els.mapSearchInput.value = state.query;
        applyFilters();
      }
    });

    // Map floating search — live full-text filter
    if (els.mapSearchInput) {
      let searchTimer = null;
      const runMapSearch = () => {
        state.query = (els.mapSearchInput.value || '').trim();
        if (els.searchInput) els.searchInput.value = state.query;
        if (els.mapSearchClear) els.mapSearchClear.classList.toggle('visible', !!state.query);
        applyFilters();
      };
      els.mapSearchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runMapSearch, 220);
      });
      els.mapSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          clearTimeout(searchTimer);
          runMapSearch();
        }
        if (e.key === 'Escape') {
          els.mapSearchInput.value = '';
          runMapSearch();
        }
      });
      if (els.mapSearchClear) {
        els.mapSearchClear.addEventListener('click', () => {
          els.mapSearchInput.value = '';
          runMapSearch();
          els.mapSearchInput.focus();
        });
      }
    }

    els.btnReset.addEventListener('click', () => {
      state.mode = 'all';
      state.severity = 'all';
      state.status = 'all';
      state.dateFrom = null;
      state.dateTo = null;
      state.query = '';
      $$('#modeFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.mode === 'all'));
      $$('#severityFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.sev === 'all'));
      els.statusFilter.value = 'all';
      els.dateFrom.value = '';
      els.dateTo.value = '';
      els.searchInput.value = '';
      applyFilters();
    });

    $$('#eventsTable th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir *= -1;
        else { state.sortKey = key; state.sortDir = key === 'date' ? -1 : 1; }
        applyFilters();
      });
    });

    els.btnRefresh.addEventListener('click', () => refresh());

    els.btnAlerts.addEventListener('click', () => {
      const next = !window.VigilAlerts.isEnabled();
      window.VigilAlerts.setEnabled(next);
      els.btnAlerts.classList.toggle('active', next);
      if (next) window.VigilAlerts.playUpdate();
    });
    els.btnAlerts.classList.toggle('active', window.VigilAlerts && window.VigilAlerts.isEnabled());

    els.btnTheme.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'light' ? null : 'light';
      if (next) document.documentElement.setAttribute('data-theme', next);
      else document.documentElement.removeAttribute('data-theme');
    });

    els.btnExport.addEventListener('click', () => {
      const rows = [['Date', 'NTSB#', 'Mode', 'City', 'State', 'Country', 'Severity', 'Fatal', 'Status', 'Summary']];
      state.filtered.forEach(e => {
        rows.push([
          e.eventDate || '', e.ntsbNum || '', e.mode || '', e.city || '', e.state || '',
          e.country || '', e.highestInjury || '', e.fatal ?? '', e.status || '', (e.summary || '').replace(/\n/g, ' ')
        ]);
      });
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vigilxplr-export.csv';
      a.click();
    });
  }

  function refresh() {
    setStatus(false, 'Refreshing…');
    loadData().then(events => {
      state.events = events;
      detectNewEvents(events);
      applyFilters();
    }).catch(err => {
      console.error(err);
      setStatus(false, 'Error');
    });
  }

  function boot() {
    initDom();
    initMap();
    bindEvents();
    refresh();
    // soft auto-refresh every 15 min while tab open
    setInterval(refresh, 15 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
