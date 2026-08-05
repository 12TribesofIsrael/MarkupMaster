/* Analysis wizard (upload → analyze) and round detail (gates → edit → approve → mail). */
window.Views = window.Views || {};

/* ─── Wizard ─────────────────────────────────────────────────────────────────── */

let wizFiles = [];
let wizTimer = null;

Views.analyze = async function (campaignId) {
  const view = document.getElementById('view');
  wizFiles = [];
  let client = null, campaign = null;
  if (campaignId) {
    const dash = await API.get('/api/campaigns/' + campaignId);
    client = dash.client; campaign = dash.campaign;
  }

  const idFields = !campaignId ? `
    <div style="margin:16px 0">
      <label style="font-weight:600;font-size:14px;display:block;margin-bottom:6px">Your details (go on the letters — leave blank to fill in by hand)</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input id="wizPhone" placeholder="Phone" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
        <input id="wizPhone2" placeholder="Second phone (optional)" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
        <input id="wizEmail" placeholder="Email" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
        <input id="wizDob" placeholder="Date of birth (MM/DD/YYYY)" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
        <input id="wizSsn" placeholder="SSN (or last 4)" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
        <input id="wizFormerNames" placeholder="Former name(s) (optional)" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
        <input id="wizProof" placeholder='Proof of address you will enclose (e.g. "Delmarva Power bill")' style="grid-column:1 / -1;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
      </div>
    </div>` : `
    <p class="card-sub">Identity block from <strong>${esc(client.name)}</strong>'s record goes on the letters. Bureau: <strong>${esc(campaign.bureau)}</strong>.</p>`;

  view.innerHTML = `
    <div class="card" id="uploadSection">
      ${campaignId ? `<a href="#/campaign/${campaignId}" class="btn-link">← Campaign</a>` : `<a href="#/clients" class="btn-link">← Clients</a>`}
      <h2 class="card-title" style="margin-top:8px">${campaignId ? 'New round analysis' : 'Quick analysis (no campaign tracking)'}</h2>
      <p class="card-sub">Upload 1–10 images or PDF pages of the credit report. Claude analyzes all pages together.</p>

      <div class="dropzone" id="dropzone">
        <input type="file" id="fileInput" accept=".jpg,.jpeg,.png,.pdf" multiple hidden>
        <div class="dropzone-icon">📄</div>
        <div class="dropzone-text">Drag &amp; drop credit report files here</div>
        <div class="dropzone-sub">JPG, PNG, or PDF &bull; Up to 10 files &bull; 20MB each</div>
        <button class="btn btn-outline" onclick="document.getElementById('fileInput').click()">Browse Files</button>
      </div>

      ${!campaignId ? `
      <div style="margin:16px 0">
        <label for="bureauSelect" style="font-weight:600;font-size:14px;display:block;margin-bottom:6px">Credit Bureau (CRA)</label>
        <select id="bureauSelect" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;background:#fff">
          <option value="auto">Auto-detect from report (full reports only)</option>
          <option value="equifax">Equifax</option>
          <option value="experian">Experian</option>
          <option value="transunion">TransUnion</option>
        </select>
      </div>` : ''}

      ${idFields}

      <div class="file-list" id="fileList" style="display:none">
        <div class="file-list-header">
          <span id="fileCount">0 files selected</span>
          <button class="btn-link" onclick="Views._wizClear()">Clear all</button>
        </div>
        <div id="fileItems"></div>
      </div>

      <button class="btn btn-primary" id="analyzeBtn" disabled
        onclick="Views._wizStart(${campaignId || 'null'}, ${campaignId ? `'${esc(campaign.bureau).toLowerCase()}'` : 'null'})">
        Analyze Credit Report →
      </button>
    </div>

    <div class="card" id="progressSection" style="display:none">
      <h2 class="card-title">Analyzing Credit Report...</h2>
      <p class="card-sub">Claude is running the 33-point Metro 2® audit and identifying FCRA violations. This typically takes 60–90 seconds.</p>
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div class="progress-steps">
        <div class="progress-step active" id="ps1">🔍 Scanning accounts...</div>
        <div class="progress-step" id="ps2">⚖ Identifying violations...</div>
        <div class="progress-step" id="ps3">📝 Generating letters...</div>
        <div class="progress-step" id="ps4">📦 Building package...</div>
      </div>
    </div>

    <div class="card" id="resultsSection" style="display:none"></div>`;

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault(); dropzone.classList.remove('drag-over');
    Views._wizAdd([...e.dataTransfer.files]);
  });
  fileInput.addEventListener('change', () => { Views._wizAdd([...fileInput.files]); fileInput.value = ''; });
};

Views._wizAdd = function (newFiles) {
  const allowed = /\.(jpg|jpeg|png|pdf)$/i;
  for (const f of newFiles) {
    if (!allowed.test(f.name)) { showError(`"${f.name}" is not supported. Use JPG, PNG, or PDF.`); continue; }
    if (f.size > 20 * 1024 * 1024) { showError(`"${f.name}" exceeds 20MB limit.`); continue; }
    if (wizFiles.length >= 10) { showError('Maximum 10 files allowed.'); break; }
    if (!wizFiles.find(x => x.name === f.name && x.size === f.size)) wizFiles.push(f);
  }
  Views._wizRender();
};

Views._wizRender = function () {
  const list = document.getElementById('fileList');
  const items = document.getElementById('fileItems');
  const btn = document.getElementById('analyzeBtn');
  if (wizFiles.length === 0) { list.style.display = 'none'; btn.disabled = true; return; }
  list.style.display = 'block';
  btn.disabled = false;
  document.getElementById('fileCount').textContent = `${wizFiles.length} file${wizFiles.length > 1 ? 's' : ''} selected`;
  const fmt = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  items.innerHTML = wizFiles.map((f, i) => `
    <div class="file-item">
      <span class="file-item-icon">${f.name.endsWith('.pdf') ? '📄' : '🖼'}</span>
      <span class="file-item-name">${esc(f.name)}</span>
      <span class="file-item-size">${fmt(f.size)}</span>
      <button class="file-item-remove" onclick="Views._wizRemove(${i})" title="Remove">✕</button>
    </div>`).join('');
};

Views._wizRemove = function (i) { wizFiles.splice(i, 1); Views._wizRender(); };
Views._wizClear = function () { wizFiles = []; Views._wizRender(); };

Views._wizStart = async function (campaignId, campaignBureau) {
  clearError();
  if (wizFiles.length === 0) return;

  const bureau = campaignBureau || document.getElementById('bureauSelect').value;
  if (bureau === 'auto' && !confirm(
    'Bureau is set to Auto-detect. That works when the uploaded pages show the bureau name.\n\nFor a single-account snapshot alone, click Cancel and pick the bureau from the dropdown.\n\nContinue with auto-detect?'
  )) return;

  document.getElementById('uploadSection').style.display = 'none';
  document.getElementById('progressSection').style.display = 'block';

  const fill = document.getElementById('progressFill');
  const steps = ['ps1', 'ps2', 'ps3', 'ps4'];
  let cur = 0;
  fill.style.width = '5%';
  wizTimer = setInterval(() => {
    if (cur < steps.length) {
      if (cur > 0) document.getElementById(steps[cur - 1]).className = 'progress-step done';
      document.getElementById(steps[cur]).className = 'progress-step active';
      fill.style.width = [15, 40, 70, 90][cur] + '%';
      cur++;
    }
  }, 15000);

  const formData = new FormData();
  formData.append('bureau', bureau);
  if (campaignId) {
    formData.append('campaignId', String(campaignId));
  } else {
    formData.append('phone', document.getElementById('wizPhone').value.trim());
    formData.append('phone2', document.getElementById('wizPhone2').value.trim());
    formData.append('email', document.getElementById('wizEmail').value.trim());
    formData.append('dob', document.getElementById('wizDob').value.trim());
    formData.append('ssn', document.getElementById('wizSsn').value.trim());
    formData.append('formerNames', document.getElementById('wizFormerNames').value.trim());
    formData.append('proofOfAddress', document.getElementById('wizProof').value.trim());
  }
  wizFiles.forEach(f => formData.append('files', f));

  try {
    const data = await API.post('/analyze', formData);
    clearInterval(wizTimer);
    if (campaignId && data.round) {
      location.hash = `#/campaign/${campaignId}/round/${data.round.id}`;
    } else if (campaignId) {
      location.hash = `#/campaign/${campaignId}`;
    } else {
      Views._quickResults(data);
    }
  } catch (err) {
    clearInterval(wizTimer);
    document.getElementById('progressSection').style.display = 'none';
    document.getElementById('uploadSection').style.display = 'block';
    showError(err.message || 'Analysis failed. Please try again.');
  }
};

/* Quick-mode results: summary + review gate + downloads (no campaign). */
Views._quickResults = function (data) {
  document.getElementById('progressSection').style.display = 'none';
  const results = document.getElementById('resultsSection');
  results.style.display = 'block';
  const v = data.violations || {};

  const accounts = [];
  (data.furnishers || []).forEach(f => {
    const names = (f.accounts && f.accounts.length > 0) ? f.accounts : [f.name];
    names.forEach(a => accounts.push({ furnisher: f.name, account: a }));
  });

  results.innerHTML = `
    <h2 class="card-title">Analysis Complete</h2>
    <div class="summary-grid">
      <div class="summary-card card-total"><div class="summary-card-value">${v.total || 0}</div><div class="summary-card-label">Total Violations</div></div>
      <div class="summary-card card-critical"><div class="summary-card-value">${v.critical || 0}</div><div class="summary-card-label">Critical</div></div>
      <div class="summary-card card-high"><div class="summary-card-value">${v.high || 0}</div><div class="summary-card-label">High</div></div>
      <div class="summary-card card-medium"><div class="summary-card-value">${v.medium || 0}</div><div class="summary-card-label">Medium</div></div>
    </div>
    ${accounts.length > 0 ? `
    <div style="margin:24px 0;padding:16px;border:2px solid #f59e0b;border-radius:12px;background:#fffbeb">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:6px">Review before mailing — required</h3>
      <p style="font-size:13px;color:#64748b;margin-bottom:12px">Only dispute what is <strong>actually wrong</strong>, and only dispute an account if you'd be <strong>thrilled to see it deleted</strong> — the bureau's options are always fix, delete, or nothing.</p>
      <div id="quickGateItems">
        ${accounts.map((a, i) => `
          <div style="padding:10px 0;border-top:1px solid #fde68a">
            <div style="font-weight:600;font-size:14px;margin-bottom:6px">${esc(a.furnisher)} — ${esc(a.account)}</div>
            <label style="display:block;font-size:13px;margin-bottom:4px"><input type="checkbox" class="gate-check"> The disputed information is <strong>actually wrong</strong> — I could defend that under oath.</label>
            <label style="display:block;font-size:13px"><input type="checkbox" class="gate-check"> I would be <strong>thrilled if this entire account were deleted</strong>.</label>
          </div>`).join('')}
      </div>
    </div>` : ''}
    <div class="download-area">
      <a class="btn btn-primary btn-download" id="zipDownload" href="${esc(data.zipUrl)}" download>⬇ Download Full Dispute Package (.zip)</a>
      <div class="file-links" id="quickFileLinks">
        ${(data.files || []).map(f => `<a class="file-link" href="${esc(f.url)}" download>${esc(f.label)}</a>`).join('')}
      </div>
    </div>
    <button class="btn btn-outline" onclick="location.reload()" style="margin-top:16px;width:100%">← Start New Analysis</button>`;

  const zip = document.getElementById('zipDownload');
  const links = document.getElementById('quickFileLinks');
  const gate = document.getElementById('quickGateItems');
  const setEnabled = on => {
    [zip, links].forEach(el => { el.style.pointerEvents = on ? '' : 'none'; el.style.opacity = on ? '' : '0.4'; });
  };
  if (gate) {
    setEnabled(false);
    gate.querySelectorAll('.gate-check').forEach(cb => cb.addEventListener('change', () => {
      setEnabled([...gate.querySelectorAll('.gate-check')].every(c => c.checked));
    }));
  }
};

/* ─── Round detail: gates → edit → approve → mail capture ────────────────────── */

let roundState = null;

Views.round = async function (campaignId, roundId) {
  const view = document.getElementById('view');
  const dash = await API.get('/api/campaigns/' + campaignId);
  const round = dash.rounds.find(r => r.id === Number(roundId));
  if (!round) { showError('Round not found.'); location.hash = '#/campaign/' + campaignId; return; }
  if (!round.run_id) { showError('This round has no analysis attached.'); location.hash = '#/campaign/' + campaignId; return; }

  const rv = await API.get(`/api/runs/${round.run_id}/violations`);
  roundState = { campaignId: Number(campaignId), round, dash, violationsData: rv.violationsData, warnings: rv.warnings };

  const decisions = {};
  dash.decisions.forEach(d => { decisions[`${d.furnisher_name}||${d.account_name}`] = d; });
  const warnMap = {};
  rv.warnings.forEach(w => { warnMap[`${w.furnisher}||${w.account}`] = w.warnings; });

  let itemNo = 0;
  const accountsHtml = (rv.violationsData.furnishers || []).map((f, fi) => {
    const byAccount = {};
    (f.violations || []).forEach(v => { (byAccount[v.accountName || f.name] = byAccount[v.accountName || f.name] || []).push(v); });
    return Object.entries(byAccount).map(([acct, viols]) => {
      const key = `${f.name}||${acct}`;
      const d = decisions[key] || {};
      const warnings = warnMap[key] || [];
      const acctId = `acct_${fi}_${esc(acct).replace(/[^a-zA-Z0-9]/g, '_')}`;
      const itemsHtml = viols.map(v => {
        itemNo++;
        const idx = itemNo;
        return `
          <div style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:8px 0" data-item="${idx}">
            <div style="font-size:12px;color:#64748b;margin-bottom:4px">Item ${idx} — ${esc(v.title || '')} <span style="color:#dc2626">[${esc(v.severity || '')}]</span></div>
            <label style="font-size:12px;font-weight:600">What's wrong (goes in the letter):</label>
            <textarea class="vw-wording" data-f="${fi}" data-n="${esc(v.accountName || '')}" data-t="${esc(v.title || '')}"
              style="width:100%;min-height:52px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:inherit">${esc(v.disputeWording || '')}</textarea>
            <label style="font-size:12px;font-weight:600">Exact remedy:</label>
            <input class="vw-remedy" data-f="${fi}" data-n="${esc(v.accountName || '')}" data-t="${esc(v.title || '')}" value="${esc(v.remedyWording || '')}"
              style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px">
          </div>`;
      }).join('');

      return `
        <div style="margin:16px 0;padding:16px;border:1px solid #e2e8f0;border-radius:12px" data-gate-account="${esc(key)}">
          <div style="font-weight:700;font-size:15px">${esc(f.name)} — ${esc(acct)} <span style="font-weight:400;color:#64748b">(${viols.length} item${viols.length === 1 ? '' : 's'})</span></div>
          ${warnings.map(w => `
            <div style="margin:8px 0;padding:10px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px">
              ⚠ ${esc(w)}<br>
              <label style="font-weight:600"><input type="checkbox" class="warn-ack" ${d.warning_ack ? 'checked' : ''}> I understand and want to proceed anyway.</label>
            </div>`).join('')}
          <label style="display:block;font-size:13px;margin:6px 0 4px">
            <input type="checkbox" class="gate-wrong" ${d.can_dispute ? 'checked' : ''}> The disputed information is <strong>actually wrong</strong> — not just unwanted — and I could defend that under oath.
          </label>
          <label style="display:block;font-size:13px">
            <input type="checkbox" class="gate-thrilled" ${d.thrilled_if_deleted ? 'checked' : ''}> I would be <strong>thrilled if this entire account were deleted</strong> from my report.
          </label>
          ${itemsHtml}
        </div>`;
    }).join('');
  }).join('');

  view.innerHTML = `
    <div class="card">
      <a href="#/campaign/${campaignId}" class="btn-link">← Campaign</a>
      <h2 class="card-title" style="margin-top:8px">Round ${round.round_number} — review &amp; approve</h2>
      <p class="card-sub">Check the two boxes for every account you're keeping in the letter (uncheck to drop the account). Edit any wording. Then approve — the final letters are regenerated from exactly what you see here.</p>
      ${accountsHtml || '<p style="color:#64748b;font-style:italic">No violations in this analysis.</p>'}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:16px">
        <label style="font-size:13px;font-weight:600">Mail date on the letter: <input type="date" id="genMailDate" value="${todayIso()}" style="padding:8px;border:1px solid #cbd5e1;border-radius:6px"></label>
        <button class="btn btn-primary" id="approveBtn" onclick="Views._approveRound()">Approve &amp; generate final letters</button>
      </div>
      <div id="genFiles" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <h2 class="card-title">Mail capture</h2>
      <p class="card-sub">Enter the real-world dates as they happen — this drives the 30-day clock and the chronology.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
        <label style="font-size:13px;font-weight:600">Date mailed<br><input type="date" id="mcMailDate" value="${esc(round.mail_date || '')}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px"></label>
        <label style="font-size:13px;font-weight:600">Certified tracking # (CRA envelope)<br><input id="mcTracking" value="${esc(round.tracking_cra || '')}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px"></label>
        <label style="font-size:13px;font-weight:600">Delivered on (from USPS tracking / green card)<br><input type="date" id="mcDelivered" value="${esc(round.delivered_date || '')}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px"></label>
        <label style="font-size:13px;font-weight:600">Results of investigation received<br><input type="date" id="mcResults" value="${esc(round.results_received_date || '')}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px"></label>
      </div>
      <button class="btn btn-primary" style="margin-top:12px" onclick="Views._saveMailCapture()">Save dates</button>
      ${round.deadline_30 ? `<p style="font-size:13px;margin-top:8px">30-day deadline on file: <strong>${esc(round.deadline_30)}</strong> &bull; pull a fresh report after <strong>${esc(round.deadline_35)}</strong></p>` : ''}
    </div>`;
};

Views._collectEdits = function () {
  // Write textarea/input edits back into the violations JSON by furnisher
  // index + account + title match.
  const data = roundState.violationsData;
  document.querySelectorAll('.vw-wording').forEach(t => {
    const f = data.furnishers[Number(t.dataset.f)];
    if (!f) return;
    const v = (f.violations || []).find(v => (v.accountName || '') === t.dataset.n && (v.title || '') === t.dataset.t);
    if (v) v.disputeWording = t.value.trim();
  });
  document.querySelectorAll('.vw-remedy').forEach(t => {
    const f = data.furnishers[Number(t.dataset.f)];
    if (!f) return;
    const v = (f.violations || []).find(v => (v.accountName || '') === t.dataset.n && (v.title || '') === t.dataset.t);
    if (v && t.value.trim()) v.remedyWording = t.value.trim();
  });
  return data;
};

Views._gateStates = function () {
  const included = [], decisions = [];
  document.querySelectorAll('[data-gate-account]').forEach(div => {
    const [furnisher, account] = div.dataset.gateAccount.split('||');
    const wrong = div.querySelector('.gate-wrong').checked;
    const thrilled = div.querySelector('.gate-thrilled').checked;
    const acks = [...div.querySelectorAll('.warn-ack')];
    const acked = acks.length === 0 || acks.every(a => a.checked);
    const include = wrong && thrilled && acked;
    decisions.push({
      furnisher_name: furnisher, account_name: account,
      can_dispute: wrong ? 1 : 0, thrilled_if_deleted: thrilled ? 1 : 0,
      warning_ack: acked ? 1 : 0, include_in_letter: include ? 1 : 0,
    });
    if (include) included.push({ furnisher, account });
  });
  return { included, decisions };
};

Views._approveRound = async function () {
  clearError();
  const { included, decisions } = Views._gateStates();
  if (included.length === 0) { showError('No account passes both gates — nothing to put in a letter.'); return; }
  const btn = document.getElementById('approveBtn');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    await API.post(`/api/campaigns/${roundState.campaignId}/decisions`, decisions);
    await API.patch(`/api/runs/${roundState.round.run_id}/violations`, { violationsData: Views._collectEdits() });
    const mailDate = document.getElementById('genMailDate').value;
    const out = await API.post(`/api/rounds/${roundState.round.id}/generate`, {
      mailDate: mailDate ? new Date(mailDate + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : undefined,
      includedAccounts: included,
    });
    document.getElementById('genFiles').innerHTML = `
      <div style="padding:12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
        <strong>Approved.</strong> Final documents:
        <div class="file-links" style="margin-top:8px">
          ${out.files.map(f => `<a class="file-link" href="${esc(f.url)}" download>${esc(f.name)}</a>`).join('')}
        </div>
        <p style="font-size:13px;margin-top:8px">Print, sign, assemble per the Mailing Instructions, then come back and enter the mail date + tracking below.</p>
      </div>`;
  } catch (e) { showError(e.message); }
  btn.disabled = false; btn.textContent = 'Approve & generate final letters';
};

Views._saveMailCapture = async function () {
  clearError();
  const patch = {};
  const md = document.getElementById('mcMailDate').value;
  const tr = document.getElementById('mcTracking').value.trim();
  const dl = document.getElementById('mcDelivered').value;
  const rr = document.getElementById('mcResults').value;
  const r = roundState.round;
  if (md && md !== r.mail_date) patch.mail_date = md;
  if (tr && tr !== r.tracking_cra) patch.tracking_cra = tr;
  if (dl && dl !== r.delivered_date) patch.delivered_date = dl;
  if (rr && rr !== r.results_received_date) patch.results_received_date = rr;
  if (Object.keys(patch).length === 0) { showError('Nothing new to save.'); return; }
  try {
    await API.patch(`/api/rounds/${r.id}`, patch);
    Views.round(roundState.campaignId, r.id);
  } catch (e) { showError(e.message); }
};
