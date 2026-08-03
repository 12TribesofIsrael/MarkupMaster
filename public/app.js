/* ─── State ──────────────────────────────────────────────────────────────────── */
let files = [];

/* ─── Drag & Drop ────────────────────────────────────────────────────────────── */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});
dropzone.addEventListener('click', e => {
  if (e.target === dropzone || e.target.classList.contains('dropzone-text') || e.target.classList.contains('dropzone-sub') || e.target.classList.contains('dropzone-icon')) {
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });

function addFiles(newFiles) {
  const allowed = /\.(jpg|jpeg|png|pdf)$/i;
  for (const f of newFiles) {
    if (!allowed.test(f.name)) { showError(`"${f.name}" is not supported. Use JPG, PNG, or PDF.`); continue; }
    if (f.size > 20 * 1024 * 1024) { showError(`"${f.name}" exceeds 20MB limit.`); continue; }
    if (files.length >= 10) { showError('Maximum 10 files allowed.'); break; }
    if (!files.find(x => x.name === f.name && x.size === f.size)) files.push(f);
  }
  renderFileList();
}

function renderFileList() {
  const list = document.getElementById('fileList');
  const items = document.getElementById('fileItems');
  const count = document.getElementById('fileCount');
  const btn = document.getElementById('analyzeBtn');

  if (files.length === 0) {
    list.style.display = 'none';
    btn.disabled = true;
    return;
  }

  list.style.display = 'block';
  btn.disabled = false;
  count.textContent = `${files.length} file${files.length > 1 ? 's' : ''} selected`;

  items.innerHTML = files.map((f, i) => `
    <div class="file-item">
      <span class="file-item-icon">${f.name.endsWith('.pdf') ? '📄' : '🖼'}</span>
      <span class="file-item-name">${f.name}</span>
      <span class="file-item-size">${formatSize(f.size)}</span>
      <button class="file-item-remove" onclick="removeFile(${i})" title="Remove">✕</button>
    </div>`).join('');
}

function removeFile(i) { files.splice(i, 1); renderFileList(); }
function clearFiles() { files = []; renderFileList(); }
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ─── Analysis Pipeline ──────────────────────────────────────────────────────── */
let progressTimer = null;

async function startAnalysis() {
  clearError();
  if (files.length === 0) return;

  const bureau = document.getElementById('bureauSelect').value;
  if (bureau === 'auto' && !confirm(
    'Bureau is set to Auto-detect. That works when the uploaded pages show the bureau name (a full report, or the report\'s first pages included with your snapshot).\n\nFor a single-account snapshot alone, click Cancel and pick the bureau from the dropdown.\n\nContinue with auto-detect?'
  )) return;

  setStep(2);
  document.getElementById('uploadSection').style.display = 'none';
  document.getElementById('progressSection').style.display = 'block';
  document.getElementById('resultsSection').style.display = 'none';

  // Animated progress steps
  startProgressAnimation();

  const formData = new FormData();
  formData.append('bureau', document.getElementById('bureauSelect').value);
  files.forEach(f => formData.append('files', f));

  try {
    const resp = await fetch('/analyze', { method: 'POST', body: formData });
    stopProgressAnimation();

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Unknown server error.' }));
      throw new Error(err.error || `Server error ${resp.status}`);
    }

    const data = await resp.json();
    showResults(data);

  } catch (err) {
    stopProgressAnimation();
    document.getElementById('progressSection').style.display = 'none';
    document.getElementById('uploadSection').style.display = 'block';
    setStep(1);
    showError(err.message || 'Analysis failed. Please try again.');
  }
}

function startProgressAnimation() {
  const fill = document.getElementById('progressFill');
  const steps = ['ps1', 'ps2', 'ps3', 'ps4'];
  let current = 0;
  const targets = [15, 40, 70, 90];

  fill.style.width = '5%';

  progressTimer = setInterval(() => {
    if (current < steps.length) {
      // Mark previous done
      if (current > 0) {
        document.getElementById(steps[current - 1]).className = 'progress-step done';
      }
      document.getElementById(steps[current]).className = 'progress-step active';
      fill.style.width = targets[current] + '%';
      current++;
    }
  }, 15000); // Advance every 15s
}

function stopProgressAnimation() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  // Complete all steps
  ['ps1','ps2','ps3','ps4'].forEach(id => document.getElementById(id).className = 'progress-step done');
  document.getElementById('progressFill').style.width = '100%';
}

/* ─── Results ────────────────────────────────────────────────────────────────── */
function showResults(data) {
  setStep(4);
  document.getElementById('progressSection').style.display = 'none';
  document.getElementById('resultsSection').style.display = 'block';

  // Summary cards
  const v = data.violations || {};
  const summaryGrid = document.getElementById('summaryGrid');
  summaryGrid.innerHTML = `
    <div class="summary-card card-total">
      <div class="summary-card-value">${v.total || 0}</div>
      <div class="summary-card-label">Total Violations</div>
    </div>
    <div class="summary-card card-critical">
      <div class="summary-card-value">${v.critical || 0}</div>
      <div class="summary-card-label">Critical</div>
    </div>
    <div class="summary-card card-high">
      <div class="summary-card-value">${v.high || 0}</div>
      <div class="summary-card-label">High</div>
    </div>
    <div class="summary-card card-medium">
      <div class="summary-card-value">${v.medium || 0}</div>
      <div class="summary-card-label">Medium</div>
    </div>`;

  // Furnisher list
  const furnisherList = document.getElementById('furnisherList');
  if (data.furnishers && data.furnishers.length > 0) {
    furnisherList.innerHTML = `<h3 style="font-size:14px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Dispute Packages Generated</h3>` +
      data.furnishers.map(f => `
        <div class="furnisher-item">
          <div>
            <div class="furnisher-name">${f.name}</div>
            <div class="furnisher-meta">${f.accountCount} account${f.accountCount !== 1 ? 's' : ''}</div>
          </div>
          <span class="furnisher-badge">${f.violationCount} violation${f.violationCount !== 1 ? 's' : ''}</span>
        </div>`).join('');
  } else {
    furnisherList.innerHTML = '';
  }

  // Download links
  const zipDownload = document.getElementById('zipDownload');
  zipDownload.href = data.zipUrl;

  const fileLinks = document.getElementById('fileLinks');
  fileLinks.innerHTML = (data.files || []).map(f =>
    `<a class="file-link" href="${f.url}" download>${f.label}</a>`
  ).join('');
}

/* ─── UI Helpers ─────────────────────────────────────────────────────────────── */
function setStep(n) {
  const lines = document.querySelectorAll('.step-line');
  [1,2,3,4].forEach(i => {
    const el = document.getElementById('step' + i);
    el.className = 'step' + (i < n ? ' done' : i === n ? ' active' : '');
    if (i < 4 && lines[i-1]) lines[i-1].className = 'step-line' + (i < n ? ' done' : '');
  });
}

function showError(msg) {
  const banner = document.getElementById('errorBanner');
  document.getElementById('errorText').textContent = msg;
  banner.style.display = 'flex';
}

function clearError() {
  document.getElementById('errorBanner').style.display = 'none';
}

function resetApp() {
  files = [];
  renderFileList();
  clearError();
  setStep(1);
  document.getElementById('uploadSection').style.display = 'block';
  document.getElementById('progressSection').style.display = 'none';
  document.getElementById('resultsSection').style.display = 'none';
}
