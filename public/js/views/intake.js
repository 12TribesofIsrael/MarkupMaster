/* Response intake: upload results letter + fresh report → item-by-item diff. */
window.Views = window.Views || {};

let intakeFiles = [];

Views.intake = async function (campaignId) {
  const view = document.getElementById('view');
  const dash = await API.get('/api/campaigns/' + campaignId);
  const waiting = dash.rounds.filter(r => r.mail_date && !r.results_received_date);
  intakeFiles = [];

  if (waiting.length === 0) {
    view.innerHTML = `
      <div class="card">
        <a href="#/campaign/${campaignId}" class="btn-link">← Campaign</a>
        <h2 class="card-title" style="margin-top:8px">Response intake</h2>
        <p class="card-sub">No mailed round is waiting on results. Enter the mail date on the round first, then come back when the bureau's results-of-investigation letter arrives.</p>
      </div>`;
    return;
  }

  view.innerHTML = `
    <div class="card" id="intakeUpload">
      <a href="#/campaign/${campaignId}" class="btn-link">← Campaign</a>
      <h2 class="card-title" style="margin-top:8px">Response intake — Round ${waiting[waiting.length - 1].round_number}</h2>
      <p class="card-sub">Upload the bureau's results-of-investigation letter AND a fresh copy of the credit report (pull one after day 35). Claude compares every disputed item and classifies it: fixed, deleted, or verified-without-correction — the last group is your litigation core.</p>

      <div class="dropzone" id="intakeDrop">
        <input type="file" id="intakeInput" accept=".jpg,.jpeg,.png,.pdf" multiple hidden>
        <div class="dropzone-icon">📬</div>
        <div class="dropzone-text">Drop the results letter + fresh report here</div>
        <div class="dropzone-sub">JPG, PNG, or PDF &bull; Up to 10 files &bull; 20MB each</div>
        <button class="btn btn-outline" onclick="document.getElementById('intakeInput').click()">Browse Files</button>
      </div>

      <div id="intakeFileList" style="margin:12px 0;font-size:13px"></div>

      <label style="font-size:13px;font-weight:600">Date the results letter arrived (starts the 2-year SOL clock):
        <input type="date" id="intakeDate" value="${todayIso()}" style="padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-left:8px">
      </label>
      <br>
      <button class="btn btn-primary" id="intakeBtn" style="margin-top:12px" disabled onclick="Views._runIntake(${campaignId})">Compare results against my dispute →</button>
    </div>

    <div class="card" id="intakeProgress" style="display:none">
      <h2 class="card-title">Comparing…</h2>
      <p class="card-sub">Claude is reading the results letter and the fresh report against every item from your dispute. This typically takes about a minute.</p>
      <div class="progress-bar"><div class="progress-fill" style="width:60%"></div></div>
    </div>

    <div class="card" id="intakeResults" style="display:none"></div>`;

  const drop = document.getElementById('intakeDrop');
  const input = document.getElementById('intakeInput');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag-over'); Views._intakeAdd([...e.dataTransfer.files]); });
  input.addEventListener('change', () => { Views._intakeAdd([...input.files]); input.value = ''; });
};

Views._intakeAdd = function (newFiles) {
  const allowed = /\.(jpg|jpeg|png|pdf)$/i;
  for (const f of newFiles) {
    if (!allowed.test(f.name)) { showError(`"${f.name}" is not supported.`); continue; }
    if (intakeFiles.length >= 10) break;
    if (!intakeFiles.find(x => x.name === f.name && x.size === f.size)) intakeFiles.push(f);
  }
  document.getElementById('intakeFileList').innerHTML = intakeFiles.map(f => `• ${esc(f.name)}`).join('<br>');
  document.getElementById('intakeBtn').disabled = intakeFiles.length === 0;
};

Views._runIntake = async function (campaignId) {
  clearError();
  document.getElementById('intakeUpload').style.display = 'none';
  document.getElementById('intakeProgress').style.display = 'block';
  const fd = new FormData();
  fd.append('results_date', document.getElementById('intakeDate').value);
  intakeFiles.forEach(f => fd.append('files', f));
  try {
    const out = await API.post(`/api/campaigns/${campaignId}/intake`, fd);
    Views._intakeResults(campaignId, out);
  } catch (e) {
    document.getElementById('intakeProgress').style.display = 'none';
    document.getElementById('intakeUpload').style.display = 'block';
    showError(e.message);
  }
};

Views._intakeResults = function (campaignId, out) {
  document.getElementById('intakeProgress').style.display = 'none';
  const box = document.getElementById('intakeResults');
  box.style.display = 'block';
  const g = out.diff.groups;

  const section = (label, rows, color) => rows.length === 0 ? '' : `
    <h3 style="font-size:14px;font-weight:700;color:${color};margin:16px 0 6px">${label} (${rows.length})</h3>
    ${rows.map(r => `
      <div style="font-size:13px;padding:6px 0;border-bottom:1px solid #f1f5f9">
        <strong>#${r.item}</strong> ${esc(r.account || r.furnisher)} — ${esc(r.title || '')}
        ${r.newValue ? `<br><span style="color:#64748b">now: ${esc(r.newValue)}</span>` : ''}
        ${r.evidenceQuote ? `<br><span style="color:#64748b;font-style:italic">"${esc(r.evidenceQuote)}"</span>` : ''}
      </div>`).join('')}`;

  box.innerHTML = `
    <h2 class="card-title">Results processed</h2>
    <p class="card-sub">${out.counts.fixed} fixed &bull; ${out.counts.deleted} deleted &bull; <strong style="color:#dc2626">${out.counts.verified_unchanged} verified without correction</strong> &bull; ${out.counts.unclear} unclear${out.solDeadline ? ` &bull; SOL deadline set: ${esc(out.solDeadline)}` : ''}</p>

    <div style="padding:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;font-size:13px;margin-bottom:8px">
      📞 <strong>Call the bureau now</strong> about anything not fixed, and log the call on the campaign page. It removes their "you should have called us" argument and shows the dispute is serious to you.
    </div>

    ${section('VERIFIED WITHOUT CORRECTION — the litigation core', g.verified_unchanged, '#dc2626')}
    ${section('FIXED', g.fixed, '#16a34a')}
    ${section('DELETED', g.deleted, '#16a34a')}
    ${section('UNCLEAR — classify these yourself', g.unclear, '#d97706')}

    <div class="file-links" style="margin-top:16px">
      ${out.files.map(f => `<a class="file-link" href="${esc(f.url)}" download>${esc(f.name)}</a>`).join('')}
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
      ${out.nextRound ? `<button class="btn btn-primary" onclick="location.hash='#/campaign/${campaignId}/round/${out.nextRound.id}'">Review Round ${out.nextRound.round_number} draft (FINAL NOTICE)</button>` : ''}
      ${out.counts.verified_unchanged > 0 ? `<button class="btn btn-outline" style="color:#dc2626;border-color:#dc2626" onclick="Views._escalate(${campaignId})">Escalate to litigation</button>` : ''}
      <button class="btn btn-outline" onclick="location.hash='#/campaign/${campaignId}'">Back to campaign</button>
    </div>`;
};

Views._escalate = async function (campaignId) {
  if (!confirm('Escalate: mark every verified-unchanged item for litigation and regenerate the litigation memo with the full chronology?')) return;
  try {
    const out = await API.post(`/api/campaigns/${campaignId}/escalate`, {});
    alert('Campaign escalated.' + (out.memoUrl ? ' The litigation memo has been regenerated with the full chronology.' : ''));
    location.hash = '#/campaign/' + campaignId;
  } catch (e) { showError(e.message); }
};
